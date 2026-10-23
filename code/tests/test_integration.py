import time
import uuid

import pytest
from fastapi.testclient import TestClient

from backend.api import create_app
from backend.compiler import validate
from backend.schemas import Workflow
from backend.seeds import templates


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "demo")
    app = create_app(tmp_path)
    with TestClient(app) as client:
        yield client


def launch(client, agent="project-status", **inputs):
    body = {
        "agent_id": agent,
        "version": "1.0.0",
        "inputs": {"project_id": "PRJ-1001", **inputs},
        "idempotency_key": str(uuid.uuid4()),
    }
    response = client.post("/api/runs", json=body)
    assert response.status_code == 202, response.text
    return response.json()["id"]


def wait_run(
    client, run_id, statuses=("SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_RECONCILIATION", "AWAITING_APPROVAL")
):
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        result = client.get(f"/api/runs/{run_id}").json()
        if result["status"] in statuses:
            return result
        time.sleep(0.04)
    raise AssertionError(f"Run did not finish: {result}")


def wait_evaluation(client, run_id):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        result = client.get(f"/api/runs/{run_id}/evaluation").json()
        if result["status"] not in ("PENDING", "RUNNING"):
            return result
        time.sleep(0.04)
    raise AssertionError("Evaluation did not complete")


def test_run_reservation_rolls_back_on_event_failure(tmp_path, monkeypatch):
    from backend.repository import Repository

    monkeypatch.setenv("MODEL_MODE", "demo")
    app = create_app(tmp_path)
    repo = app.state.repo
    runtime = app.state.runtime
    before = len(repo.list("run"))

    def fail_event(*args, **kwargs):
        raise RuntimeError("simulated persistence failure")

    monkeypatch.setattr(repo, "event", fail_event)
    with pytest.raises(RuntimeError, match="persistence failure"):
        runtime.create_run(
            {
                "agent_id": "project-status",
                "version": "1.0.0",
                "inputs": {"project_id": "PRJ-1001"},
                "idempotency_key": "rollback-test",
            }
        )
    assert len(repo.list("run")) == before
    assert repo.list("idempotency") == []
    runtime.pool.shutdown()
    repo.close()
    reopened = Repository(tmp_path)
    assert len(reopened.list("run")) == before
    assert reopened.list("idempotency") == []
    reopened.close()


@pytest.mark.parametrize(
    "agent",
    ["project-status", "material-analysis", "deep-analysis", "delivery-check", "project-assistant", "model-summary"],
)
def test_real_graph_templates(client, agent):
    run_id = launch(client, agent)
    run = wait_run(client, run_id)
    assert run["status"] == "SUCCEEDED", run
    assert run["result"]["verification"]["passed"]
    assert run["usage"]["model_calls"] == (
        0
        if agent in ("project-status", "delivery-check", "project-assistant")
        else 1
        if agent == "model-summary"
        else 2
    )
    report = wait_evaluation(client, run_id)
    assert report["execution_status"] == "SUCCEEDED"
    assert report["model_mode"] == "demo"
    assert report["evidence_refs"]
    events = client.get(f"/api/runs/{run_id}/event-log").json()
    assert events[0]["event_type"] == "run.created"
    assert len({e["sequence"] for e in events}) == len(events)
    if agent == "project-assistant":
        assert len(run["children"]) == 1


def test_approval_commit_idempotency_and_readback(client):
    run_id = launch(client, "approved-update", progress=83)
    run = wait_run(client, run_id)
    assert run["status"] == "AWAITING_APPROVAL"
    approval = run["approvals"][0]
    path = f"/api/runs/{run_id}/approvals/{approval['id']}"
    assert client.post(path, json={"decision": "approve"}).status_code == 200
    assert client.post(path, json={"decision": "approve"}).status_code == 200
    run = wait_run(client, run_id, statuses=("SUCCEEDED", "FAILED"))
    assert run["status"] == "SUCCEEDED", run
    assert run["result"]["result"]["progress"] == 83
    assert len(run["operations"]) == 1
    assert run["operations"][0]["status"] == "CONFIRMED"
    assert run["result"]["result"]["object_version"] == 2


def test_rejected_and_expired_approval(client):
    run_id = launch(client, "approved-update", progress=80)
    run = wait_run(client, run_id)
    approval = run["approvals"][0]
    client.app.state.repo.update("approval", approval["id"], expires_at=0)
    path = f"/api/runs/{run_id}/approvals/{approval['id']}"
    response = client.post(path, json={"decision": "approve"})
    assert response.status_code == 409
    assert response.json()["code"] == "APPROVAL_STALE"
    assert not client.get(f"/api/runs/{run_id}").json()["operations"]
    client.post(f"/api/runs/{run_id}/cancel")
    run_id = launch(client, "approved-update", progress=80)
    run = wait_run(client, run_id)
    path = f"/api/runs/{run_id}/approvals/{run['approvals'][0]['id']}"
    client.post(path, json={"decision": "reject"})
    run = wait_run(client, run_id, statuses=("SUCCEEDED", "FAILED"))
    assert run["status"] == "FAILED"
    assert run["error"]["code"] == "APPROVAL_REJECTED"


def test_approval_survives_process_resources_recreation(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "demo")
    with TestClient(create_app(tmp_path)) as first:
        run_id = launch(first, "approved-update", progress=89)
        run = wait_run(first, run_id)
        assert run["status"] == "AWAITING_APPROVAL"
    with TestClient(create_app(tmp_path)) as second:
        run = second.get(f"/api/runs/{run_id}").json()
        path = f"/api/runs/{run_id}/approvals/{run['approvals'][0]['id']}"
        assert second.post(path, json={"decision": "approve"}).status_code == 200
        run = wait_run(second, run_id, statuses=("SUCCEEDED", "FAILED"))
        assert run["status"] == "SUCCEEDED", run
        assert len(run["operations"]) == 1


def test_unknown_operation_not_resubmitted(client):
    run_id = launch(client, "approved-update", progress=91, simulate_unknown=True)
    run = wait_run(client, run_id)
    client.post(f"/api/runs/{run_id}/approvals/{run['approvals'][0]['id']}", json={"decision": "approve"})
    run = wait_run(client, run_id, statuses=("NEEDS_RECONCILIATION", "FAILED", "SUCCEEDED"))
    assert run["status"] == "NEEDS_RECONCILIATION"
    assert len(run["operations"]) == 1
    result = client.post(f"/api/runs/{run_id}/reconcile").json()
    assert result["findings"][0]["matched"]
    assert client.get("/api/projects").json()[1]["object_version"] == 2


def test_idempotency_input_and_permissions(client):
    body = {
        "agent_id": "project-status",
        "version": "1.0.0",
        "inputs": {"project_id": "PRJ-1001"},
        "idempotency_key": "same-request-1234",
    }
    a = client.post("/api/runs", json=body)
    b = client.post("/api/runs", json=body)
    assert a.json()["id"] == b.json()["id"]
    body["inputs"]["project_id"] = "PRJ-1002"
    assert client.post("/api/runs", json=body).status_code == 409
    body["idempotency_key"] = "other-request-1234"
    body["inputs"]["project_id"] = "PRJ-9999"
    assert client.post("/api/runs", json=body).status_code == 403
    body["inputs"]["project_id"] = "bad-id"
    assert client.post("/api/runs", json=body).status_code == 422
    assert client.post("/api/runs", json=body, headers={"Origin": "https://untrusted.example"}).status_code == 403


def test_draft_does_not_change_release_and_optimistic_lock(client):
    run_id = launch(client)
    original = client.get("/api/agents/project-status").json()
    original["workflow"]["nodes"][1]["title"] = "草稿新标题"
    body = {k: original[k] for k in ("workflow", "layout", "revision")}
    assert client.put("/api/agents/project-status/draft", json=body).status_code == 200
    assert client.put("/api/agents/project-status/draft", json=body).status_code == 409
    assert client.get(f"/api/runs/{run_id}").json()["workflow"]["nodes"][1]["title"] == "查询项目状态"
    assert client.post("/api/agents/project-status/simulate").json()["valid"]
    published = client.post("/api/agents/project-status/publish", json={"revision": 2, "confirmed": True})
    assert published.status_code == 200, published.text
    assert published.json()["version"] == "1.0.1"
    client.post("/api/agents/project-status/versions/1.0.1/revoke")
    body = {
        "agent_id": "project-status",
        "version": "1.0.1",
        "inputs": {"project_id": "PRJ-1001"},
        "idempotency_key": "revoked-request-1234",
    }
    assert client.post("/api/runs", json=body).status_code == 422


def test_model_evaluation_failure_preserves_business(client, monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "unavailable")
    run_id = launch(client)
    assert wait_run(client, run_id)["status"] == "SUCCEEDED"
    assert wait_evaluation(client, run_id)["status"] == "UNAVAILABLE"
    before = len(client.get(f"/api/runs/{run_id}/event-log").json())
    monkeypatch.setenv("MODEL_MODE", "demo")
    assert client.post(f"/api/runs/{run_id}/evaluation/retry").status_code == 200
    assert wait_evaluation(client, run_id)["status"] == "PASSED"
    later = client.get(f"/api/runs/{run_id}/event-log").json()[before:]
    assert not any(e["event_type"] in ("node.started", "tool.requested") for e in later)


def test_dsl_blocks_cycle_unknown_function_branch_reference():
    wf = Workflow.model_validate(templates()[0][0])
    wf.nodes[1].config["function_ref"] = "shell.execute@1"
    assert validate(wf)
    wf = Workflow.model_validate(templates()[0][0])
    wf.nodes[1].inputs["project_id"] = {"source": "node", "node_id": "n_verify", "path": []}
    assert any("上游" in e["message"] for e in validate(wf))
    wf = Workflow.model_validate(templates()[0][0])
    wf.edges[-1].target = "n_input"
    assert any("循环" in e["message"] for e in validate(wf))


def test_two_branches_and_sse_replay(client):
    first = launch(client, "delivery-check", project_id="PRJ-1001")
    second = launch(client, "delivery-check", project_id="PRJ-1002")
    for run_id, branch in ((first, "true"), (second, "false")):
        assert wait_run(client, run_id)["status"] == "SUCCEEDED"
        events = client.get(f"/api/runs/{run_id}/event-log").json()
        assert next(e["payload"]["branch"] for e in events if e["event_type"] == "branch.selected") == branch
    wait_evaluation(client, first)
    events = client.get(f"/api/runs/{first}/event-log").json()
    response = client.get(f"/api/runs/{first}/events", headers={"Last-Event-ID": str(events[-3]["sequence"])})
    assert events[-3]["event_id"] not in response.text
    assert events[-1]["event_id"] in response.text


def test_cancel_waiting_approval_never_writes(client):
    run_id = launch(client, "approved-update", progress=90)
    assert wait_run(client, run_id)["status"] == "AWAITING_APPROVAL"
    result = client.post(f"/api/runs/{run_id}/cancel").json()
    assert result["status"] == "CANCELLED"
    assert not client.get(f"/api/runs/{run_id}").json()["operations"]


def test_object_version_change_invalidates_approval(client):
    run_id = launch(client, "approved-update", progress=90)
    run = wait_run(client, run_id)
    repo = client.app.state.repo
    repo.update("project", "PRJ-1001", object_version=2)
    path = f"/api/runs/{run_id}/approvals/{run['approvals'][0]['id']}"
    response = client.post(path, json={"decision": "approve"})
    assert response.status_code == 409
    assert response.json()["code"] == "APPROVAL_STALE"


def test_python_tool_and_model_tool_share_authorization(client):
    from backend.schemas import BusinessError
    from backend.tools import BusinessTools

    run_id = launch(client)
    context = {
        "run_id": run_id,
        "node_id": "unauthorized-test",
        "policy": {"tools": ["project.query_status@1"], "objects": ["PRJ-1001"]},
    }
    tools = BusinessTools(client.app.state.repo)
    with pytest.raises(BusinessError, match="对象级权限"):
        tools.call("project.query_status@1", {"project_id": "PRJ-1002"}, context)
    with pytest.raises(BusinessError, match="授权"):
        tools.call("project.update_progress@1", {"plan": {"project_id": "PRJ-1001"}}, context)


def test_deep_agent_blocks_forged_subagent_tool(client, monkeypatch):
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult

    from backend.executors.models import DemoChatModel

    def attack(self, messages, **kwargs):
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "task",
                                "args": {"description": "do something", "subagent_type": "general-purpose"},
                                "id": "attack-call",
                            }
                        ],
                    )
                )
            ]
        )

    monkeypatch.setattr(DemoChatModel, "_generate", attack)
    run_id = launch(client, "deep-analysis")
    run = wait_run(client, run_id)
    assert run["status"] == "FAILED"
    assert run["error"]["code"] == "POLICY_DENIED"
    assert not run["children"]


def test_hard_model_call_budget_stops_tool_loop(client):
    agent = client.get("/api/agents/material-analysis").json()
    agent["workflow"]["policy"]["max_model_calls"] = 1
    body = {k: agent[k] for k in ("workflow", "layout", "revision")}
    assert client.put("/api/agents/material-analysis/draft", json=body).status_code == 200
    client.post("/api/agents/material-analysis/simulate")
    release = client.post("/api/agents/material-analysis/publish", json={"revision": 2, "confirmed": True}).json()
    response = client.post(
        "/api/runs",
        json={
            "agent_id": "material-analysis",
            "version": release["version"],
            "inputs": {"project_id": "PRJ-1001"},
            "idempotency_key": "hard-model-budget",
        },
    )
    run = wait_run(client, response.json()["id"])
    assert run["status"] == "FAILED"
    assert run["error"]["code"] == "BUDGET_EXCEEDED"
    assert run["usage"]["model_calls"] == 1


def test_conversation_isolation_and_metered_summarization(client):
    def converse(project, conversation):
        response = client.post(
            "/api/runs",
            json={
                "agent_id": "material-analysis",
                "version": "1.0.0",
                "inputs": {"project_id": project},
                "conversation_id": conversation,
                "idempotency_key": str(uuid.uuid4()),
            },
        )
        run = wait_run(client, response.json()["id"])
        assert run["status"] == "SUCCEEDED", run
        return run

    first = converse("PRJ-1001", "conversation-a")
    other = converse("PRJ-1002", "conversation-a")
    assert first["result"]["result"]["context_messages"] == other["result"]["result"]["context_messages"]
    last = None
    for _ in range(4):
        last = converse("PRJ-1001", "conversation-a")
    assert last["usage"]["model_calls"] >= 3
    fresh = converse("PRJ-1001", "conversation-b")
    assert fresh["result"]["result"]["context_messages"] == first["result"]["result"]["context_messages"]
    assert len(client.app.state.repo.list("conversation")) == 3


def test_large_evidence_offload_and_redaction(client):
    repo = client.app.state.repo
    run_id = launch(client)
    evidence_id = repo.evidence(
        run_id, "large-material", {"api_key": "do-not-store", "material": "test-evidence " * 2500}
    )
    raw = next(e for e in repo.list("evidence") if e["id"] == evidence_id)
    assert raw["storage"] == "file"
    assert "data" not in raw
    full = client.get(f"/api/evidence/{evidence_id}").json()
    assert full["data"]["api_key"] == "[REDACTED]"
    assert full["data"]["material"].startswith("test-evidence")
    assert "do-not-store" not in (repo.root / "evidence" / f"{evidence_id}.json").read_text(encoding="utf-8")


def test_metrics_and_local_host_boundary(client):
    run_id = launch(client)
    wait_run(client, run_id)
    wait_evaluation(client, run_id)
    metrics = client.get("/api/metrics").json()
    assert metrics["acceptance"]["samples"] == 1
    assert metrics["node"]["samples"] == 4
    assert metrics["software"]["samples"] == 2
    assert client.get("/api/health", headers={"Host": "attacker.invalid"}).status_code == 400
