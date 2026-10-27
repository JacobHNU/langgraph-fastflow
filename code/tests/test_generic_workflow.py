import copy
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from test_integration import wait_evaluation, wait_run

from backend.api import create_app
from backend.compiler import validate
from backend.schemas import Workflow


@pytest.fixture
def service(monkeypatch):
    state = {"requests": [], "model_requests": [], "status": 200, "bad_schema": False, "model_bad": False}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send_json(self, data, status=200):
            encoded = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            state["requests"].append({"path": self.path, "authorization": self.headers.get("Authorization")})
            self.send_json(
                {
                    "customer_id": "CUST-1001",
                    "orders": "bad" if state["bad_schema"] else [{"id": "ORD-1", "status": "paid"}],
                },
                state["status"],
            )

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["model_requests"].append({"body": body, "authorization": self.headers.get("Authorization")})
            if state["model_bad"]:
                self.send_json({"error": {"message": "private-provider-detail"}}, 401)
                return
            if body.get("tools") and not any(m["role"] == "tool" for m in body["messages"]):
                self.send_json(
                    {
                        "id": "chatcmpl-tool",
                        "object": "chat.completion",
                        "created": 1,
                        "model": body["model"],
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": None,
                                    "tool_calls": [
                                        {
                                            "id": "call-orders",
                                            "type": "function",
                                            "function": {
                                                "name": body["tools"][0]["function"]["name"],
                                                "arguments": json.dumps({"customer_id": "CUST-1001"}),
                                            },
                                        }
                                    ],
                                },
                                "finish_reason": "tool_calls",
                            }
                        ],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
                    }
                )
                return
            evaluation = any("EVALUATION_BUNDLE" in str(m["content"]) for m in body["messages"])
            content = (
                {"assessment": "SUPPORTED", "summary": "Fixture evaluation", "risk_level": "low", "recommendations": []}
                if evaluation
                else {"summary": "Fixture customer has one paid order."}
            )
            self.send_json(
                {
                    "id": "chatcmpl-fixture",
                    "object": "chat.completion",
                    "created": 1,
                    "model": body["model"],
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": json.dumps(content)},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 12, "completion_tokens": 10, "total_tokens": 22},
                }
            )

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("WORKFLOW_DEMO_ORDERS_URL", url)
    monkeypatch.setenv("MODEL_MODE", "demo")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    yield state, url
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.fixture
def client(tmp_path, service):
    with TestClient(create_app(tmp_path)) as client:
        yield client


def sample(client):
    return copy.deepcopy(client.get("/api/agents/customer-order-summary").json()["workflow"])


def publish(client, workflow):
    response = client.post("/api/agents", json={"name": "Generic fixture", "workflow": workflow})
    assert response.status_code == 201, response.text
    agent = response.json()
    result = client.post(f"/api/agents/{agent['id']}/simulate").json()
    assert result["valid"], result
    result = client.post(f"/api/agents/{agent['id']}/publish", json={"revision": agent["revision"], "confirmed": True})
    assert result.status_code == 200, result.text
    return result.json()


def launch_generic(client, release=None, inputs=None):
    release = release or {"agent_id": "customer-order-summary", "version": "1.0.0"}
    response = client.post(
        "/api/runs",
        json={
            "agent_id": release["agent_id"],
            "version": release["version"],
            "inputs": inputs or {"customer_id": "CUST-1001"},
            "idempotency_key": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 202, response.text
    return response.json()["id"]


def await_input(client, run_id):
    result = wait_run(client, run_id, ("AWAITING_INPUT", "FAILED", "CANCELLED"))
    assert result["status"] == "AWAITING_INPUT", result
    return result


def confirm(client, run, decision="accept", **body):
    pending = run["input_requests"][0]
    return client.post(
        f"/api/runs/{run['id']}/inputs/{pending['id']}",
        json={
            "revision": pending["revision"],
            "decision": decision,
            "payload": {"feedback": "Reviewed"},
            "idempotency_key": "confirmation-fixture",
            **body,
        },
    )


def test_six_node_publish_http_pause_resume_and_evidence(client, service):
    state, _ = service
    release = publish(client, sample(client))
    assert release["resolved_bindings"]["models"]
    run_id = launch_generic(client, release)
    run = await_input(client, run_id)
    assert set(run["node_results"]) == {"n_input", "n_orders", "n_summary", "n_verify"}
    assert run["node_results"]["n_verify"]["passed"]
    assert run["usage"] == {"model_calls": 1, "tool_calls": 1}
    assert state["requests"][0]["path"] == "/customers/CUST-1001/orders"
    assert confirm(client, run).status_code == 200
    assert confirm(client, run).status_code == 200
    completed = wait_run(client, run_id)
    assert completed["status"] == "SUCCEEDED", completed
    assert completed["result"]["approved"] is True
    assert "CUST-1001" in completed["result"]["summary"]
    assert completed["usage"] == run["usage"]
    assert completed["duration_ms"] == completed["active_elapsed_ms"]
    assert completed["duration_ms"] >= run["active_elapsed_ms"] > 0
    assert len(state["requests"]) == 1
    evidence = client.get(f"/api/runs/{run_id}/evidence").json()
    assert [e["number"] for e in evidence] == list(range(1, len(evidence) + 1))
    report = wait_evaluation(client, run_id)
    assert report["execution_status"] == "SUCCEEDED"
    assert report["status"] == "PASSED", report
    assert report["evidence_delivery"]


def test_confirmation_survives_restart_without_repeating_http(tmp_path, service):
    with TestClient(create_app(tmp_path)) as first:
        run_id = launch_generic(first)
        old = await_input(first, run_id)
    with TestClient(create_app(tmp_path)) as second:
        run = second.get(f"/api/runs/{run_id}").json()
        assert run["status"] == "AWAITING_INPUT"
        assert confirm(second, run).status_code == 200
        result = wait_run(second, run_id)
        assert result["status"] == "SUCCEEDED", result
        assert result["usage"] == old["usage"]
        assert result["duration_ms"] >= old["active_elapsed_ms"] > 0
    assert len(service[0]["requests"]) == 1


def test_reject_cancel_expiry_and_conflict(client):
    run = await_input(client, launch_generic(client))
    assert confirm(client, run, revision=99).status_code == 409
    assert confirm(client, run, payload={"unexpected": "bad"}).status_code == 422
    assert confirm(client, run, decision="reject").status_code == 200
    assert wait_run(client, run["id"])["status"] == "CANCELLED"
    assert confirm(client, run, payload={"feedback": "different"}).status_code == 409
    pending_run = await_input(client, launch_generic(client))
    assert client.delete("/api/agents/customer-order-summary?revision=1").status_code == 409
    assert client.post(f"/api/runs/{pending_run['id']}/cancel").json()["status"] == "CANCELLED"
    assert confirm(client, pending_run).status_code == 409


@pytest.mark.parametrize("failure", ["status", "bad_schema"])
def test_http_failure_stops_before_model_and_confirmation(client, service, failure):
    service[0][failure] = 503 if failure == "status" else True
    run_id = launch_generic(client)
    run = wait_run(client, run_id)
    assert run["status"] == "FAILED", run
    assert run["error"]["code"] == ("CONNECTOR_HTTP_ERROR" if failure == "status" else "OUTPUT_INVALID")
    assert run["usage"]["model_calls"] == 0
    assert not run["input_requests"]


def test_generic_input_and_static_permissions(client):
    response = client.post(
        "/api/runs",
        json={
            "agent_id": "customer-order-summary",
            "version": "1.0.0",
            "inputs": {"customer_id": "PRJ-1001"},
            "idempotency_key": "invalid-input-fixture",
        },
    )
    assert response.status_code == 422
    wf = sample(client)
    wf["policy"]["capability_refs"] = []
    assert validate(Workflow.model_validate(wf), client.app.state.runtime.resources)
    wf = sample(client)
    wf["nodes"][1]["config"]["connection_ref"] = "unregistered@1"
    assert validate(Workflow.model_validate(wf), client.app.state.runtime.resources)
    wf = sample(client)
    wf["nodes"][2]["config"]["user_prompt_template"] = "{{ cycler.__init__.__globals__ }}"
    assert validate(Workflow.model_validate(wf), client.app.state.runtime.resources)
    wf = sample(client)
    wf["input_schema"]["properties"]["customer_id"]["pattern"] = "(a+)+$"
    assert validate(Workflow.model_validate(wf), client.app.state.runtime.resources)


def test_two_models_bind_versions_and_use_real_sdk(client, service):
    state, url = service
    profiles = []
    for model in ("summary-model-one", "summary-model-two"):
        response = client.post(
            "/api/model-profiles",
            json={
                "name": model,
                "mode": "openai",
                "provider": "custom",
                "base_url": url + "/v1",
                "model": model,
                "api_key": "fixture-private-key",
                "requires_api_key": True,
                "timeout_seconds": 5,
                "max_tokens": 256,
            },
        )
        assert response.status_code == 201, response.text
        assert "fixture-private-key" not in response.text
        profiles.append(response.json())
    wf = sample(client)
    wf["nodes"][2]["config"]["model_ref"] = profiles[0]["ref"]
    extra = copy.deepcopy(wf["nodes"][2])
    extra["id"] = "n_second_summary"
    extra["config"]["model_ref"] = profiles[1]["ref"]
    wf["nodes"].insert(3, extra)
    wf["edges"][2]["to"] = extra["id"]
    wf["edges"].insert(3, {"from": extra["id"], "to": "n_verify"})
    wf["dependency_refs"]["models"] = [p["ref"] for p in profiles]
    release = publish(client, wf)
    changed = client.put(
        f"/api/model-profiles/{profiles[0]['id']}",
        json={"revision": 1, "name": "Changed", **profiles[0]["config"], "model": "should-not-run"},
    )
    assert changed.status_code == 200, changed.text
    stale = client.put(
        f"/api/model-profiles/{profiles[0]['id']}", json={"revision": 1, "name": "Stale", **profiles[0]["config"]}
    )
    assert stale.status_code == 409
    run = await_input(client, launch_generic(client, release))
    assert [r["body"]["model"] for r in state["model_requests"]] == [p["config"]["model"] for p in profiles]
    assert all(r["authorization"] == "Bearer fixture-private-key" for r in state["model_requests"])
    assert confirm(client, run).status_code == 200
    assert wait_run(client, run["id"])["status"] == "SUCCEEDED"
    assert "fixture-private-key" not in json.dumps(client.app.state.repo.list("run"))
    assert "fixture-private-key" not in json.dumps(client.app.state.repo.events(run["id"]))


def test_model_failure_never_falls_back_to_demo(client, service):
    state, url = service
    p = client.post(
        "/api/model-profiles",
        json={
            "name": "Failing",
            "mode": "openai",
            "base_url": url + "/v1",
            "model": "failing-model",
            "api_key": "fixture-secret",
            "timeout_seconds": 3,
        },
    ).json()
    wf = sample(client)
    wf["nodes"][2]["config"]["model_ref"] = p["ref"]
    wf["dependency_refs"]["models"] = [p["ref"]]
    release = publish(client, wf)
    state["model_bad"] = True
    run = wait_run(client, launch_generic(client, release))
    assert run["status"] == "FAILED", run
    assert run["error"]["code"] == "MODEL_CONNECTION_FAILED"
    assert not run["input_requests"]
    assert "private-provider-detail" not in json.dumps(run)


def test_agent_http_tool_uses_the_same_gateway(client, service):
    state, url = service
    profile = client.post(
        "/api/model-profiles",
        json={
            "name": "Tool agent",
            "mode": "openai",
            "base_url": url + "/v1",
            "model": "tool-model",
            "api_key": "tool-fixture-secret",
            "timeout_seconds": 8,
        },
    ).json()
    wf = sample(client)
    model = wf["nodes"][2]
    model["type"] = "agent"
    model["config"].update(executor="langchain_agent", model_ref=profile["ref"], tools=["orders.list@1"])
    wf["dependency_refs"]["models"] = [profile["ref"]]
    run = await_input(client, launch_generic(client, publish(client, wf)))
    assert run["usage"] == {"model_calls": 2, "tool_calls": 2}
    assert len(state["requests"]) == 2
    invocations = [i for i in client.app.state.repo.list("invocation") if i["run_id"] == run["id"]]
    assert {i["node_id"] for i in invocations} == {"n_orders", "n_summary"}
    assert all(i["capability_ref"] == "orders.list@1" for i in invocations)
    assert confirm(client, run).status_code == 200
    assert wait_run(client, run["id"])["status"] == "SUCCEEDED"


def test_http_connection_versions_and_secrets_are_not_embedded(client, service):
    _, url = service
    connection = client.get("/api/connections").json()[0]
    body = {key: connection[key] for key in ("name", "revision", "base_url", "timeout_seconds", "operations")}
    body["bearer_token"] = "http-private-fixture-token"
    saved = client.put(f"/api/connections/{connection['id']}", json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json()["ref"] == "conn_orders@2"
    assert "http-private-fixture-token" not in saved.text
    wf = sample(client)
    wf["nodes"][1]["config"]["connection_ref"] = "conn_orders@2"
    wf["dependency_refs"]["connections"] = ["conn_orders@2"]
    release = publish(client, wf)
    body.update(revision=2, base_url="http://127.0.0.1:1", bearer_token=None)
    assert client.put(f"/api/connections/{connection['id']}", json=body).status_code == 200
    assert client.put(f"/api/connections/{connection['id']}", json=body).status_code == 409
    run = await_input(client, launch_generic(client, release))
    assert service[0]["requests"][-1]["authorization"] == "Bearer http-private-fixture-token"
    assert run["resolved_bindings"]["connections"]["conn_orders@2"]["base_url"] == url
    assert "http-private-fixture-token" not in json.dumps(run)
    assert confirm(client, run).status_code == 200
    assert wait_run(client, run["id"])["status"] == "SUCCEEDED"


def test_expired_confirmation_and_invalid_reference(client):
    run = await_input(client, launch_generic(client))
    client.app.state.repo.update("human_input", run["input_requests"][0]["id"], expires_at=0)
    result = confirm(client, run)
    assert result.status_code in (409, 422)
    assert wait_run(client, run["id"])["status"] == "CANCELLED"
    wf = sample(client)
    wf["nodes"][-1]["inputs"]["summary"]["path"] = ["missing_field"]
    assert any(
        "missing_field" in e["message"]
        for e in validate(Workflow.model_validate(wf), client.app.state.runtime.resources)
    )
    wf = sample(client)
    wf["policy"]["capability_refs"] = [{}]
    assert validate(Workflow.model_validate(wf), client.app.state.runtime.resources)


def test_blank_v2_draft_and_chat_generate_preview(client):
    blank = client.post("/api/agents/blank", json={"name": "Generic blank", "schema_version": "2.0"}).json()
    assert blank["workflow"]["schema_version"] == "2.0"
    assert not blank["workflow"]["edges"]
    assert not client.post(f"/api/agents/{blank['id']}/validate").json()["valid"]
    session = client.post("/api/workflow-assistant/sessions", json={"mode": "create"}).json()
    before = len(client.app.state.repo.list("agent"))
    reply = client.post(
        f"/api/workflow-assistant/sessions/{session['id']}/messages",
        json={"message": "新建客户订单 HTTP 查询、模型摘要、核验和人工确认流程"},
    ).json()["messages"][-1]
    assert not reply["errors"], reply
    assert reply["proposal"]["workflow"]["schema_version"] == "2.0"
    assert len(client.app.state.repo.list("agent")) == before
    release = publish(client, reply["proposal"]["workflow"])
    run = await_input(client, launch_generic(client, release))
    assert confirm(client, run).status_code == 200
    assert wait_run(client, run["id"])["status"] == "SUCCEEDED"
