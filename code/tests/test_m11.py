import copy
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_generic_workflow import await_input, confirm, launch_generic, publish
from test_generic_workflow import client as generic_client
from test_generic_workflow import service as generic_service
from test_integration import wait_evaluation, wait_run

from backend.api import create_app
from backend.compiler import validate
from backend.resources import OperationSpec
from backend.schemas import BusinessError, Workflow
from backend.transforms import TransformConfig, transform

client = generic_client
service = generic_service


@pytest.fixture
def connector():
    state = {
        "active": 0,
        "max_active": 0,
        "invalid_json": False,
        "requests": [],
        "status": 200,
        "delay": 0,
        "payload": {"customer_id": "CUST-1001", "orders": [{"id": "ORD-1", "status": "paid"}]},
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.respond(None)

        def do_POST(self):
            self.respond(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))

        def respond(self, body):
            state["active"] += 1
            state["max_active"] = max(state["active"], state["max_active"])
            state["requests"].append(
                {
                    "method": self.command,
                    "path": self.path,
                    "body": body,
                    "header": self.headers.get("X-Source"),
                    "credential": self.headers.get("X-Service-Key"),
                }
            )
            time.sleep(state["delay"])
            state["active"] -= 1
            data = json.dumps({"payload": state["payload"]}).encode()
            if state["invalid_json"]:
                data = b"not-json"
            self.send_response(state["status"])
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield state, f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()
    thread.join()


def configure(client, connector, **overrides):
    connection = client.get("/api/connections").json()
    connection = next(c for c in connection if c["id"] == "conn_orders_m11")
    op = copy.deepcopy(connection["operations"][0])
    op["parameters"]["request_tag"]["name"] = "X-Source"
    body = {
        "revision": connection["revision"],
        "name": "Test integration",
        "base_url": connector[1],
        "auth_type": "api_key",
        "api_key_header": "X-Service-Key",
        "bearer_token": "connector-private-token",
        "operations": [op],
        **overrides,
    }
    response = client.put("/api/connections/conn_orders_m11", json=body)
    assert response.status_code == 200, response.text
    workflow = client.get("/api/agents/order-integration-lab").json()["workflow"]
    workflow["dependency_refs"]["connections"] = [response.json()["ref"]]
    next(n for n in workflow["nodes"] if n["type"] == "http")["config"]["connection_ref"] = response.json()["ref"]
    return workflow, body


def debug(client, workflow, node_id="n_transform", inputs=None, revision=1):
    return client.post(
        "/api/agents/order-integration-lab/debug",
        json={"revision": revision, "workflow": workflow, "node_id": node_id, "inputs": inputs or {}},
    )


def test_post_parameters_extraction_transform_real_model_and_confirmation(client, connector, service):
    workflow, _ = configure(client, connector)
    model = client.put(
        "/api/settings/model",
        json={
            "mode": "openai",
            "provider": "custom",
            "base_url": service[1] + "/v1",
            "model": "fixture",
            "api_key": "model-private-token",
            "requires_api_key": True,
        },
    )
    assert model.status_code == 200, model.text
    profiles = client.get("/api/model-profiles").json()
    model_ref = next(p["ref"] for p in profiles if p["id"] == "model_default")
    workflow["dependency_refs"]["models"] = [model_ref]
    next(n for n in workflow["nodes"] if n["type"] == "llm")["config"]["model_ref"] = model_ref
    release = publish(client, workflow)
    run = await_input(client, launch_generic(client, release))
    assert run["node_results"]["n_transform"]["order_ids"] == ["ORD-1"]
    assert run["node_results"]["n_transform"]["source"] == "本地订单服务"
    assert connector[0]["requests"] == [
        {
            "method": "POST",
            "path": "/orders/search?limit=3",
            "body": {"customer_id": "CUST-1001"},
            "header": "fastflow-m11",
            "credential": "connector-private-token",
        }
    ]
    assert confirm(client, run).status_code == 200
    result = wait_run(client, run["id"])
    assert result["status"] == "SUCCEEDED", result
    assert result["result"]["order_ids"] == ["ORD-1"]
    assert result["usage"] == {"model_calls": 1, "tool_calls": 1}
    assert len(result["node_results"]) == 7
    assert wait_evaluation(client, run["id"])["status"] == "PASSED"
    audit = client.get(f"/api/runs/{run['id']}/event-log").text + client.get(f"/api/runs/{run['id']}/evidence").text
    assert "model.completed" in audit
    assert "connector-private-token" not in audit and "model-private-token" not in audit


def test_transform_fields_arrays_defaults_objects_and_strict_conversions():
    assert (
        transform({"fields": {"exact": {"value": "9007199254740993", "type": "integer"}}}, {})["exact"]
        == 9007199254740993
    )
    assert transform(
        {
            "fields": {
                "renamed": {"path": ["source", "name"]},
                "count": {"path": ["count"], "type": "integer"},
                "ids": {"path": ["items", "*", "id"], "type": "array"},
                "default": {"path": ["missing"], "default": 0, "type": "integer"},
                "literal": {"value": {"kind": "orders"}, "type": "object"},
                "bool": {"value": "false", "type": "boolean"},
            }
        },
        {"source": {"name": "Alice"}, "count": "3", "items": [{"id": 1}, {"id": 2}]},
    ) == {
        "renamed": "Alice",
        "count": 3,
        "ids": [1, 2],
        "default": 0,
        "literal": {"kind": "orders"},
        "bool": False,
    }
    for value, target in [
        ("3.5", "integer"),
        (True, "integer"),
        ("NaN", "number"),
        ("maybe", "boolean"),
        ({}, "array"),
    ]:
        with pytest.raises(BusinessError, match="不能转换"):
            transform({"fields": {"value": {"value": value, "type": target}}}, {})
    with pytest.raises(BusinessError, match="不存在"):
        transform({"fields": {"value": {"path": ["missing"]}}}, {})
    with pytest.raises(ValidationError):
        TransformConfig.model_validate({"fields": {"x": {"expression": "__import__('os')"}}})
    with pytest.raises(BusinessError, match="1000"):
        transform({"fields": {"value": {"path": ["items", "*"]}}}, {"items": [1] * 1001})


def test_debug_uses_independent_snapshot_and_does_not_execute_neighbors(client):
    agent = client.get("/api/agents/order-integration-lab").json()
    workflow = copy.deepcopy(agent["workflow"])
    workflow["edges"] = []  # An incomplete draft may still debug a single configured node.
    response = debug(
        client,
        workflow,
        inputs={"response": {"data": {"customer_id": "CUST-1001", "orders": [{"id": "isolated", "status": "paid"}]}}},
    )
    assert response.status_code == 202, response.text
    run_id = response.json()["id"]
    workflow["nodes"][2]["config"]["fields"] = {}
    run = wait_run(client, run_id)
    assert run["status"] == "SUCCEEDED", run
    assert set(run["node_results"]) == {"n_transform"}
    assert run["result"]["order_ids"] == ["isolated"]
    assert run["entrypoint"] == "node_debug" and run["evaluation_status"] == "SKIPPED"
    assert client.get("/api/agents/order-integration-lab").json() == agent
    assert run["workflow"]["nodes"][2]["config"]["fields"]
    evidence = client.get(f"/api/runs/{run_id}/evidence").json()
    assert evidence[0]["number"] == 1 and evidence[0]["data"]["inputs"] == run["debug_inputs"]
    assert run["submitted_by"] != "local-demo-operator"


def test_debug_rejects_stale_policy_human_and_cross_workspace(client):
    workflow = client.get("/api/agents/order-integration-lab").json()["workflow"]
    assert debug(client, workflow, revision=999).status_code == 409
    assert debug(client, workflow, "n_review").status_code == 403
    assert debug(client, workflow, "n_output").status_code == 403
    denied = copy.deepcopy(workflow)
    denied["policy"]["capability_refs"] = []
    assert debug(client, denied, "n_orders").status_code == 422
    workspace = client.post("/api/workspaces", json={"name": "Isolated debug"}).json()
    response = client.post(
        f"/api/workspaces/{workspace['id']}/agents/order-integration-lab/debug",
        json={"revision": 1, "workflow": workflow, "node_id": "n_transform", "inputs": {}},
    )
    assert response.status_code == 404


@pytest.mark.parametrize(
    "failure,code",
    [
        ("status", "CONNECTOR_HTTP_ERROR"),
        ("path", "FIELD_MISSING"),
        ("timeout", "CONNECTOR_TIMEOUT"),
        ("size", "OUTPUT_INVALID"),
    ],
)
def test_debug_http_failures_have_timing_and_no_secrets(client, connector, failure, code):
    workflow, _ = configure(client, connector, timeout_seconds=1)
    state = connector[0]
    if failure == "status":
        state["status"] = 503
    elif failure == "timeout":
        state["delay"] = 1.2
    elif failure == "size":
        state["payload"] = "x" * 120001
    else:
        # Select a non-existent extraction path through the public connection API.
        current = next(c for c in client.get("/api/connections").json() if c["id"] == "conn_orders_m11")
        operations = current["operations"]
        operations[0]["response_path"] = ["missing"]
        updated = client.put(
            "/api/connections/conn_orders_m11",
            json={
                "revision": current["revision"],
                "name": "Bad extraction",
                "base_url": connector[1],
                "operations": operations,
            },
        ).json()
        workflow["dependency_refs"]["connections"] = [updated["ref"]]
        next(n for n in workflow["nodes"] if n["type"] == "http")["config"]["connection_ref"] = updated["ref"]
    response = debug(client, workflow, "n_orders", {"customer_id": "CUST-1001", "limit": 3})
    assert response.status_code == 202, response.text
    run = wait_run(client, response.json()["id"])
    assert run["status"] == "FAILED" and run["error"]["code"] == code, run
    assert run["active_elapsed_ms"] == run["duration_ms"] > 0
    events = client.get(f"/api/runs/{run['id']}/event-log").json()
    failed = next(e for e in events if e["event_type"] == "tool.failed")
    assert failed["payload"]["duration_ms"] >= 0
    assert "connector-private-token" not in json.dumps(events)


def test_registration_post_readonly_auth_headers_and_old_get(client, connector):
    workflow, body = configure(client, connector)
    body["revision"] += 1
    body["operations"][0]["read_only_confirmed"] = False
    assert client.put("/api/connections/conn_orders_m11", json=body).status_code == 403
    body["operations"][0]["read_only_confirmed"] = True
    body["operations"][0]["parameters"]["request_tag"]["name"] = "Authorization"
    assert client.put("/api/connections/conn_orders_m11", json=body).status_code == 403
    assert (
        OperationSpec.model_validate(
            {
                "id": "legacy.get@1",
                "name": "Legacy",
                "path": "/{id}",
                "input_schema": {"type": "object"},
                "response_schema": {},
            }
        ).method
        == "GET"
    )
    assert not validate(Workflow.model_validate(workflow), client.app.state.runtime.resources)


def test_debug_model_logs_and_transform_schema_failure(client):
    workflow = client.get("/api/agents/order-integration-lab").json()["workflow"]
    response = debug(client, workflow, "n_summary", {"customer_id": "CUST-1001", "orders": []})
    assert response.status_code == 202, response.text
    run = wait_run(client, response.json()["id"])
    assert run["status"] == "SUCCEEDED", run
    events = client.get(f"/api/runs/{run['id']}/event-log").json()
    assert {"model.called", "model.completed"}.issubset({e["event_type"] for e in events})
    assert run["usage"] == {"model_calls": 1, "tool_calls": 0}
    selected = next(n for n in workflow["nodes"] if n["type"] == "transform")
    selected["config"] = {"fields": {"invalid": {"value": "schema mismatch"}}}
    response = debug(client, workflow, inputs={})
    run = wait_run(client, response.json()["id"])
    assert run["status"] == "FAILED" and run["error"]["code"] == "OUTPUT_INVALID"


def test_debug_and_full_workflows_share_three_execution_slots(client, connector):
    connector[0]["delay"] = 0.4
    workflow, _ = configure(client, connector)
    release = publish(client, workflow)
    normal_id = launch_generic(client, release)
    ids = [debug(client, workflow, "n_orders", {"customer_id": "CUST-1001", "limit": 3}).json()["id"] for _ in range(5)]
    for run_id in ids:
        assert wait_run(client, run_id)["status"] == "SUCCEEDED"
    normal = await_input(client, normal_id)
    assert confirm(client, normal).status_code == 200
    assert wait_run(client, normal_id)["status"] == "SUCCEEDED"
    assert 2 <= connector[0]["max_active"] <= 3
    assert len(connector[0]["requests"]) == 6


def test_debug_snapshot_evidence_survive_restart_and_seed_is_not_resurrected(tmp_path, service):
    with TestClient(create_app(tmp_path)) as first:
        workflow = first.get("/api/agents/order-integration-lab").json()["workflow"]
        run_id = debug(first, workflow, "n_summary", {"customer_id": "CUST-1001", "orders": []}).json()["id"]
        assert wait_run(first, run_id)["status"] == "SUCCEEDED"
        evidence = first.get(f"/api/runs/{run_id}/evidence").json()
        assert first.post(f"/api/runs/{run_id}/evaluation/retry").status_code == 409
        assert first.delete("/api/agents/order-integration-lab?revision=1").status_code == 200
    with TestClient(create_app(tmp_path)) as second:
        run = second.get(f"/api/runs/{run_id}").json()
        assert run["status"] == "SUCCEEDED" and run["entrypoint"] == "node_debug"
        assert second.get(f"/api/runs/{run_id}/evidence").json() == evidence
        assert not any(a["id"] == "order-integration-lab" for a in second.get("/api/agents").json())


def test_invalid_json_response_and_model_provider_failure_are_audited(client, connector, service):
    workflow, _ = configure(client, connector)
    connector[0]["invalid_json"] = True
    run_id = debug(client, workflow, "n_orders", {"customer_id": "CUST-1001", "limit": 3}).json()["id"]
    assert wait_run(client, run_id)["error"]["code"] == "OUTPUT_INVALID"
    assert (
        client.put(
            "/api/settings/model",
            json={
                "mode": "openai",
                "provider": "custom",
                "base_url": service[1] + "/v1",
                "model": "fixture",
                "api_key": "model-private-token",
            },
        ).status_code
        == 200
    )
    ref = next(p["ref"] for p in client.get("/api/model-profiles").json() if p["id"] == "model_default")
    workflow["dependency_refs"]["models"] = [ref]
    next(n for n in workflow["nodes"] if n["type"] == "llm")["config"]["model_ref"] = ref
    service[0]["model_bad"] = True
    run_id = debug(client, workflow, "n_summary", {"customer_id": "CUST-1001", "orders": []}).json()["id"]
    run = wait_run(client, run_id)
    assert run["status"] == "FAILED"
    assert run["model_mode"] != "demo"
    events = client.get(f"/api/runs/{run_id}/event-log").text
    assert "model.failed" in events and "node.failed" in events
    assert "private-provider-detail" not in events and "model-private-token" not in events


def test_echoed_credential_with_json_escapes_is_redacted_in_results_logs_and_evidence(client, connector):
    secret = 'private-"quoted-token'
    workflow, _ = configure(client, connector, bearer_token=secret)
    connector[0]["payload"]["orders"][0]["id"] = secret
    run_id = debug(client, workflow, "n_orders", {"customer_id": "CUST-1001", "limit": 3}).json()["id"]
    run = wait_run(client, run_id)
    assert run["status"] == "SUCCEEDED", run
    assert run["result"]["data"]["orders"][0]["id"] == "[REDACTED]"
    for path in (f"/api/runs/{run_id}", f"/api/runs/{run_id}/event-log", f"/api/runs/{run_id}/evidence"):
        assert "quoted-token" not in client.get(path).text
