import copy
import json

import pytest
from fastapi.testclient import TestClient
from test_generic_workflow import client as generic_client
from test_generic_workflow import launch_generic, publish, sample
from test_generic_workflow import service as generic_service
from test_integration import wait_run
from test_packages import exported, import_package

from backend.compiler import validate
from backend.headless import create_app as headless_app
from backend.packages import inspect_package
from backend.resources import ConnectionRequest
from backend.schemas import Workflow

client = generic_client
service = generic_service


def skill_body(client):
    connection = next(c for c in client.get("/api/connections").json() if c["id"] == "conn_orders")
    return {
        "name": "软件订单查询",
        "description": "按客户编号查询订单并摘要",
        "content": "# QUERY_SKILL_VERSION_ONE\n必须调用 orders.list@1，根据真实响应输出摘要。",
        "tools": ["orders.list@1"],
        "connection_refs": [connection["ref"]],
        "input_schema": {
            "type": "object",
            "properties": {"customer_id": {"type": "string"}, "secretary_note": {"type": "string"}},
            "required": ["customer_id"],
            "additionalProperties": False,
        },
    }


def make_workflow(client, service, executor="langchain_agent"):
    body = skill_body(client)
    response = client.post("/api/skills", json=body)
    assert response.status_code == 201, response.text
    skill = response.json()
    profile = client.post(
        "/api/model-profiles",
        json={
            "name": "Local SDK skill test",
            "mode": "openai",
            "provider": "custom",
            "base_url": service[1] + "/v1",
            "model": "fixture-skill-model",
            "requires_api_key": False,
            "timeout_seconds": 8,
            "max_tokens": 256,
        },
    ).json()
    wf = sample(client)
    node = copy.deepcopy(wf["nodes"][2])
    node.update(type="agent", inputs={"customer_id": {"source": "input", "path": ["customer_id"]}})
    node["config"].update(executor=executor, model_ref=profile["ref"], skills=[skill["ref"]], tools=body["tools"])
    node["config"]["user_prompt_template"] = "查询客户 {{ customer_id }} 的软件订单。"
    output = copy.deepcopy(wf["nodes"][-1])
    output["inputs"] = {"summary": {"source": "node", "node_id": node["id"], "path": ["summary"]}}
    verify = {
        "id": "n_verify",
        "type": "verify",
        "config": {"validator_ref": "schema@1", "schema": node["output_schema"]},
        "inputs": {"value": {"source": "node", "node_id": node["id"], "path": []}},
    }
    wf.update(
        nodes=[wf["nodes"][0], node, verify, output],
        edges=[
            {"from": "n_input", "to": node["id"]},
            {"from": node["id"], "to": "n_verify"},
            {"from": "n_verify", "to": output["id"]},
        ],
        output_schema=node["output_schema"],
        dependency_refs={
            "models": [profile["ref"]],
            "connections": body["connection_refs"],
            "skills": [skill["ref"]],
            "tools": body["tools"],
            "validators": ["schema@1"],
            "subgraphs": [],
        },
    )
    return wf, skill, body, profile


@pytest.mark.parametrize("executor", ["langchain_agent", "deep_agent"])
def test_skill_drives_real_http_tool_with_frozen_versions_and_evidence(client, service, executor):
    wf, skill, body, _ = make_workflow(client, service, executor)
    release = publish(client, wf)
    changed = client.put(
        "/api/skills/" + skill["id"], json={**body, "revision": 1, "content": "# VERSION_TWO_DO_NOT_USE"}
    )
    assert changed.status_code == 200, changed.text
    run = wait_run(client, launch_generic(client, release))
    assert run["status"] == "SUCCEEDED", run
    assert run["usage"]["tool_calls"] == 1
    assert service[0]["requests"][0]["path"] == "/customers/CUST-1001/orders"
    prompts = json.dumps(service[0]["model_requests"])
    assert "QUERY_SKILL_VERSION_ONE" in prompts and "VERSION_TWO_DO_NOT_USE" not in prompts
    events = client.get(f"/api/runs/{run['id']}/event-log").json()
    loaded = next(e for e in events if e["event_type"] == "skill.loaded")
    assert loaded["payload"]["skills"][0]["sha256"] == skill["sha256"]
    evidence = client.get(f"/api/runs/{run['id']}/evidence").json()
    assert any(e["id"] in loaded["evidence_refs"] for e in evidence)
    assert run["skill_hashes"] == [{"ref": skill["ref"], "sha256": skill["sha256"]}]


def test_skill_validation_conflicts_missing_input_and_authorization(client, service):
    wf, skill, body, _ = make_workflow(client, service)
    assert client.put("/api/skills/" + skill["id"], json={**body, "revision": 99}).status_code == 409
    assert client.post("/api/skills", json={**body, "connection_refs": []}).status_code == 422
    assert client.post("/api/skills", json={**body, "tools": ["software.unknown@1"]}).status_code == 422
    assert client.post("/api/skills", json={**body, "content": "Bearer inline-private-credential"}).status_code == 422
    resources = client.app.state.runtime.resources
    for change in ("tools", "skills", "inputs", "executor", "connection"):
        bad = copy.deepcopy(wf)
        node = bad["nodes"][1]
        if change == "tools":
            node["config"]["tools"] = []
        if change == "skills":
            node["config"]["skills"] = ["skill_0000000000000000@1"]
        if change == "inputs":
            node["inputs"] = {}
        if change == "executor":
            node["config"]["executor"] = "direct_model"
        if change == "connection":
            bad["dependency_refs"]["connections"] = []
        assert validate(Workflow.model_validate(bad), resources), change


def test_skill_package_import_rebind_and_execute_without_source_skill_registry(client, service, tmp_path):
    wf, skill, _, profile = make_workflow(client, service)
    release = publish(client, wf)
    _, archive = exported(client, agent=release["agent_id"])
    _, _, contracts = inspect_package(archive)
    assert contracts["skills"][0]["ref"] == skill["ref"]
    with TestClient(headless_app(tmp_path / "target")) as target:
        package = import_package(target, archive)
        assert target.get("/api/skills").json() == []
        model = target.post("/api/model-profiles", json={"name": "Target SDK model", **profile["config"]}).json()
        connection = target.post(
            "/api/connections",
            json={
                "name": "Target software",
                "base_url": service[1],
                "auth_type": "none",
                "operations": contracts["connections"][0]["operations"],
            },
        ).json()
        response = target.post(
            "/api/runtime/bindings",
            json={
                "package_key": package["id"],
                "authorize_credentials": True,
                "mappings": {
                    "models": {profile["ref"]: model["ref"]},
                    "connections": {contracts["connections"][0]["ref"]: connection["ref"]},
                },
            },
        )
        assert response.status_code == 201, response.text
        deployment = target.post(
            "/api/runtime/deployments", json={"binding_id": response.json()["id"], "name": "Skill package"}
        ).json()
        run = target.post(
            f"/api/runtime/deployments/{deployment['id']}/test-runs",
            json={"inputs": {"customer_id": "CUST-1001"}, "idempotency_key": "skill-package-test"},
        ).json()
        result = wait_run(target, run["id"])
        assert result["status"] == "SUCCEEDED", result
        assert result["usage"]["tool_calls"] == 1
        assert result["skill_hashes"][0]["sha256"] == skill["sha256"]


def test_connection_credentials_are_immutable_and_scoped_for_skill_versions(client):
    connection = next(c for c in client.get("/api/connections").json() if c["id"] == "conn_orders")
    body = {
        "name": connection["name"],
        "base_url": connection["base_url"],
        "auth_type": "bearer",
        "operations": connection["operations"],
    }
    first = client.put(
        "/api/connections/" + connection["id"], json={**body, "revision": 1, "bearer_token": "first-private-token"}
    ).json()
    second = client.put(
        "/api/connections/" + connection["id"], json={**body, "revision": 2, "bearer_token": "second-private-token"}
    ).json()
    resources = client.app.state.runtime.resources
    assert resources.secret(first["credential_ref"]) == "first-private-token"
    assert resources.secret(second["credential_ref"]) == "second-private-token"
    other = client.put(
        "/api/connections/" + connection["id"], json={**body, "revision": 3, "base_url": "http://127.0.0.1:19999"}
    ).json()
    assert not other["credential_configured"]
    restored = client.put("/api/connections/" + connection["id"], json={**body, "revision": 4}).json()
    assert resources.secret(restored["credential_ref"]) == "second-private-token"


def test_skills_and_tool_versions_are_workspace_isolated(client):
    body = skill_body(client)
    skill = client.post("/api/skills", json=body).json()
    workspace = client.post("/api/workspaces", json={"name": "Empty skill workspace", "template": "empty"}).json()
    prefix = f"/api/workspaces/{workspace['id']}"
    assert client.get(prefix + "/skills").json() == []
    assert client.get(prefix + f"/skills/{skill['id']}/versions").json() == []
    assert client.post(prefix + "/skills", json=body).status_code == 422


def test_connection_save_failure_keeps_old_version_and_cleans_new_secret(client, monkeypatch):
    resources = client.app.state.runtime.resources
    connection = resources.repo.get("connection", "conn_orders")
    old_files = set(resources.vault.iterdir())
    old_put = resources.repo.put

    def fail_write(kind, key, value):
        if kind == "connection":
            raise OSError("simulated database failure")
        return old_put(kind, key, value)

    monkeypatch.setattr(resources.repo, "put", fail_write)
    with pytest.raises(OSError):
        resources.save_connection(
            ConnectionRequest(
                name=connection["name"],
                revision=connection["revision"],
                base_url=connection["base_url"],
                bearer_token="replacement-private-token",
                operations=connection["operations"],
            ),
            connection["id"],
        )
    assert set(resources.vault.iterdir()) == old_files
    assert resources.repo.get("connection", connection["id"]) == connection
    assert resources.repo.get("connection_version", "conn_orders@2") is None
