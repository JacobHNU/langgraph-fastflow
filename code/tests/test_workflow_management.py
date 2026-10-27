import copy
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from test_integration import launch, wait_evaluation, wait_run

from backend.api import create_app
from backend.repository import Repository, digest, dump
from backend.seeds import seed


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "demo")
    with TestClient(create_app(tmp_path)) as client:
        yield client


def create_copy(client):
    original = client.get("/api/agents/project-status").json()
    return client.post(
        "/api/agents", json={"name": "Custom", "workflow": original["workflow"], "layout": original["layout"]}
    ).json()


def test_blank_metadata_archive_restore_and_restart(client):
    blank = client.post("/api/agents/blank", json={"name": "New workflow"}).json()
    assert [n["type"] for n in blank["workflow"]["nodes"]] == ["input", "output"]
    assert blank["workflow"]["edges"] == []
    assert not client.post(f"/api/agents/{blank['id']}/validate").json()["valid"]
    updated = client.patch(
        f"/api/agents/{blank['id']}", json={"revision": 1, "name": "Renamed", "description": "Description"}
    ).json()
    assert updated["revision"] == 2
    assert client.patch(f"/api/agents/{blank['id']}", json={"revision": 1, "name": "Stale"}).status_code == 409
    assert client.delete(f"/api/agents/{blank['id']}?revision=1").status_code == 409
    deleted = client.delete(f"/api/agents/{blank['id']}?revision=2").json()
    assert deleted["deleted_at"]
    assert blank["id"] not in [a["id"] for a in client.get("/api/agents").json()]
    assert blank["id"] in [a["id"] for a in client.get("/api/agents?deleted=true").json()]
    assert (
        client.put(f"/api/agents/{blank['id']}/draft", json={"revision": 3, "workflow": blank["workflow"]}).status_code
        == 422
    )
    seed(client.app.state.repo)
    assert client.app.state.repo.get("agent", blank["id"])["deleted_at"]
    restored = client.post(f"/api/agents/{blank['id']}/restore", json={"revision": 3}).json()
    assert restored["id"] == blank["id"] and not restored["deleted_at"]
    assert restored["description"] == "Description"


def test_archive_dependencies_running_and_immutable_runs(client):
    assert client.delete("/api/agents/project-status?revision=1").status_code == 409
    custom = create_copy(client)
    repo = client.app.state.repo
    repo.put(
        "run",
        "busy-run",
        {"id": "busy-run", "agent_id": custom["id"], "status": "AWAITING_APPROVAL", "evaluation_status": "PASSED"},
    )
    assert client.delete(f"/api/agents/{custom['id']}?revision=1").status_code == 409
    repo.update("run", "busy-run", status="SUCCEEDED")
    assert client.delete(f"/api/agents/{custom['id']}?revision=1").status_code == 200
    assert repo.get("run", "busy-run")["status"] == "SUCCEEDED"
    response = client.post(
        "/api/runs",
        json={
            "agent_id": custom["id"],
            "version": "1.0.0",
            "inputs": {"project_id": "PRJ-1001"},
            "idempotency_key": "deleted-run-test",
        },
    )
    assert response.json()["code"] == "WORKFLOW_DELETED"


def test_evidence_number_migration_and_concurrent_append(tmp_path):
    repo = Repository(tmp_path)
    first = repo.evidence("run-test", "node", {"payload": "large " * 4000})
    raw = repo.list("evidence")[0]
    sha = raw["sha256"]
    raw.pop("number")
    repo.put("evidence", first, raw)
    repo.close()
    repo = Repository(tmp_path)
    assert repo.get("evidence", first)["number"] == 1
    assert repo.get("evidence", first)["sha256"] == sha
    with ThreadPoolExecutor(max_workers=4) as pool:
        refs = list(pool.map(lambda n: repo.evidence("run-test", "node", {"n": n}), range(8)))
    assert sorted(repo.get("evidence", ref)["number"] for ref in refs) == list(range(2, 10))
    assert [e["number"] for e in repo.evidence_index("run-test")] == list(range(1, 10))
    repo.close()


def test_deleted_seed_stays_deleted_after_restart(tmp_path):
    repo = Repository(tmp_path)
    seed(repo)
    repo.update("agent", "material-analysis", deleted_at="2026-10-23T00:00:00Z")
    repo.close()
    repo = Repository(tmp_path)
    seed(repo)
    assert repo.get("agent", "material-analysis")["deleted_at"]
    repo.close()


def test_long_evaluation_reports_actual_coverage(client):
    run_id = launch(client)
    wait_run(client, run_id)
    wait_evaluation(client, run_id)
    repo = client.app.state.repo
    for index in range(32):
        ref = repo.evidence(run_id, "n_query", {"long": "x" * 70000} if index == 0 else {"index": index})
        repo.event(run_id, "tool.completed", "n_query", evidence_refs=[ref])
    client.app.state.runtime.evaluate(run_id)
    report = client.get(f"/api/runs/{run_id}/evaluation").json()
    assert report["reviewed_evidence_refs"] == []
    assert report["missing_evidence"] == report["evidence_refs"]
    assert report["assessment"] == "INSUFFICIENT_EVIDENCE"


def test_assistant_create_followup_and_readonly_generation(client):
    session = client.post("/api/workflow-assistant/sessions", json={"mode": "create"}).json()
    path = f"/api/workflow-assistant/sessions/{session['id']}"
    before = len(client.get("/api/agents").json())
    reply = client.post(path + "/messages", json={"message": "新建查询流程"}).json()
    proposal = reply["messages"][-1]["proposal"]
    assert len(proposal["workflow"]["nodes"]) == 4
    assert reply["messages"][-1]["mode"] == "demo"
    assert len(client.get("/api/agents").json()) == before
    followup = client.post(path + "/messages", json={"message": "增加分析节点"}).json()
    assert len(followup["messages"]) == 4
    assert len(followup["messages"][-1]["proposal"]["workflow"]["nodes"]) == 5
    assert client.get(path).json() == followup


def test_assistant_edit_base_snapshot_and_conflict(client):
    agent = client.get("/api/agents/project-status").json()
    session = client.post("/api/workflow-assistant/sessions", json={"mode": "edit", "agent_id": agent["id"]}).json()
    snapshot = {"workflow": agent["workflow"], "layout": agent["layout"]}
    reply = client.post(
        f"/api/workflow-assistant/sessions/{session['id']}/messages",
        json={"message": "增加分析节点", "revision": 1, "current": snapshot},
    ).json()
    proposal = reply["messages"][-1]["proposal"]
    assert proposal["base_snapshot"] == snapshot
    assert proposal["base_digest"] == digest(proposal["base_snapshot"])
    assert proposal["agent_id"] == agent["id"]
    assert proposal["changes"]["新增节点"]
    assert client.get(f"/api/agents/{agent['id']}").json()["workflow"] == snapshot["workflow"]
    assert (
        client.post(
            f"/api/workflow-assistant/sessions/{session['id']}/messages",
            json={"message": "增加分析", "revision": 0, "current": snapshot},
        ).status_code
        == 409
    )


@pytest.mark.parametrize("kind", ["format", "permission", "provider", "repair"])
def test_assistant_invalid_proposals_and_provider_errors(client, monkeypatch, kind):
    calls = []
    valid = client.get("/api/agents/project-status").json()

    class Model:
        def invoke(self, messages):
            calls.append(messages)
            if kind == "provider":
                raise RuntimeError("private-provider-key must not be exposed")
            if kind == "format" or kind == "repair" and len(calls) == 1:
                return AIMessage("invalid json")
            workflow = copy.deepcopy(valid["workflow"])
            if kind == "permission":
                workflow["policy"]["objects"] = ["PRJ-9999"]
            return AIMessage(
                dump(
                    {
                        "message": "Candidate",
                        "proposal": {"name": "Generated", "workflow": workflow, "layout": valid["layout"]},
                    }
                )
            )

    monkeypatch.setattr("backend.workflow_assistant.get_model", lambda _config: Model())
    session = client.post("/api/workflow-assistant/sessions", json={"mode": "create"}).json()
    response = client.post(
        f"/api/workflow-assistant/sessions/{session['id']}/messages", json={"message": "Build"}
    ).json()
    assert not response["busy"]
    result = response["messages"][-1]
    assert "private-provider-key" not in dump(response)
    if kind == "repair":
        assert result["proposal"]
    else:
        assert not result.get("proposal")
        assert result["errors"]
    assert len(calls) == (1 if kind == "provider" else 2)


@pytest.mark.parametrize("failure", ["timeout", "length"])
def test_assistant_identifies_generation_timeout_and_truncation(client, monkeypatch, failure):
    import httpx

    calls = []

    class Model:
        def invoke(self, messages):
            calls.append(messages)
            if failure == "timeout":
                raise httpx.ReadTimeout("private-provider-key must not be exposed")
            return AIMessage('{"proposal":', response_metadata={"finish_reason": "length"})

    monkeypatch.setattr("backend.workflow_assistant.get_model", lambda _config: Model())
    session = client.post("/api/workflow-assistant/sessions", json={"mode": "create"}).json()
    result = client.post(f"/api/workflow-assistant/sessions/{session['id']}/messages", json={"message": "Build"}).json()
    reply = result["messages"][-1]
    assert reply["errors"][0]["code"] == ("MODEL_TIMEOUT" if failure == "timeout" else "MODEL_OUTPUT_LIMIT")
    assert ("请求超时" if failure == "timeout" else "最大输出 Token") in reply["content"]
    assert len(calls) == reply["model_calls"] == 1
    assert reply["duration_ms"] >= 0
    assert not result["busy"]
    assert not reply.get("proposal")
    assert "private-provider-key" not in dump(result)


def test_assistant_supplies_valid_query_example_and_lays_out_generated_nodes(client, monkeypatch):
    bundles = []

    class Model:
        def invoke(self, messages):
            import json

            bundle = json.loads(messages[-1].content)
            bundles.append(bundle)
            return AIMessage(
                dump({"message": "Generated", "proposal": {"name": "Query", "workflow": bundle["query_example"]}})
            )

    monkeypatch.setattr("backend.workflow_assistant.get_model", lambda _config: Model())
    session = client.post("/api/workflow-assistant/sessions", json={"mode": "create"}).json()
    response = client.post(
        f"/api/workflow-assistant/sessions/{session['id']}/messages", json={"message": "Build query"}
    ).json()
    reply = response["messages"][-1]
    assert not reply["errors"]
    assert len(bundles) == 1
    proposal = reply["proposal"]
    assert {n["id"] for n in proposal["workflow"]["nodes"]} == set(proposal["layout"])
    assert len({position["x"] for position in proposal["layout"].values()}) == 4
