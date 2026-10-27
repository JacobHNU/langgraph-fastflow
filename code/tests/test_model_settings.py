import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from backend.api import create_app


@pytest.fixture
def provider():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.send_json({"data": [{"id": "fixture-model"}, {"id": "second-model"}]})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append({"body": body, "authorization": self.headers.get("Authorization")})
            if self.headers.get("Authorization") == "Bearer invalid-test-key":
                self.send_json({"error": {"message": "Never expose invalid-test-key", "type": "auth_error"}}, 401)
                return
            analysis = {"summary": "Test analysis", "risk_level": "low", "recommendations": ["Check milestones"]}
            if any("WORKFLOW_BUILDER_BUNDLE" in str(m.get("content")) for m in body["messages"]):
                from backend.seeds import default_layout, templates

                workflow = templates()[0][0]
                analysis = {
                    "message": "HTTP provider proposal",
                    "proposal": {"name": "Online generated", "workflow": workflow, "layout": default_layout(workflow)},
                }
            if any("EVALUATION_BUNDLE" in str(m.get("content")) for m in body["messages"]):
                analysis = {"assessment": "SUPPORTED", **analysis}
            self.send_json(
                {
                    "id": "chatcmpl-test",
                    "object": "chat.completion",
                    "created": 1,
                    "model": body["model"],
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": json.dumps(analysis)},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
                }
            )

        def send_json(self, value, status=200):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}/v1", requests
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "demo")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with TestClient(create_app(tmp_path)) as instance:
        yield instance


def settings(base_url="http://127.0.0.1:11434/v1", **changes):
    return {
        "mode": "openai",
        "provider": "custom",
        "base_url": base_url,
        "model": "fixture-model",
        "api_key": "private-test-key",
        "requires_api_key": True,
        "timeout_seconds": 8,
        "max_tokens": 256,
        "temperature": 0.3,
        **changes,
    }


def test_settings_persist_preserve_and_delete_key_without_exposing_it(client, tmp_path):
    assert client.get("/api/settings/model").json()["source"] == "environment"
    saved = client.put("/api/settings/model", json=settings())
    assert saved.status_code == 200
    assert saved.json()["api_key_configured"]
    assert "api_key" not in saved.json()
    assert "private-test-key" not in saved.text
    retained = client.put("/api/settings/model", json=settings(api_key=None, model="changed-model"))
    assert retained.json()["api_key_configured"]
    assert client.app.state.runtime.model_settings.current().api_key.get_secret_value() == "private-test-key"
    with TestClient(create_app(tmp_path)) as reopened:
        assert reopened.get("/api/settings/model").json()["model"] == "changed-model"
        assert reopened.get("/api/health").json()["model_mode"] == "openai"
    cleared = client.put("/api/settings/model", json=settings(api_key=None, clear_api_key=True))
    assert not cleared.json()["api_key_configured"]
    assert not client.app.state.repo.list("settings")
    assert "private-test-key" not in json.dumps(client.app.state.repo.list("run"))


def test_connection_and_model_discovery_use_unsaved_config(client, provider):
    url, requests = provider
    response = client.post("/api/settings/model/test", json=settings(url))
    assert response.status_code == 200, response.text
    assert response.json()["success"]
    assert requests[-1]["authorization"] == "Bearer private-test-key"
    assert requests[-1]["body"]["model"] == "fixture-model"
    assert requests[-1]["body"]["temperature"] == 0.3
    assert client.get("/api/settings/model").json()["mode"] == "demo"
    assert client.post("/api/settings/model/models", json=settings(url)).json()["models"] == [
        "fixture-model",
        "second-model",
    ]
    assert "private-test-key" not in response.text


@pytest.mark.parametrize("qwen", [False, True])
def test_online_builder_uses_saved_model_and_does_not_write_workflow(client, provider, monkeypatch, qwen):
    url, requests = provider
    config = settings(url)
    if qwen:
        from backend.executors.models import get_model

        config.update(base_url="https://dashscope.aliyuncs.com/compatible-mode/v1", model="qwen3.8-max")
        # Route only the transport to the fixture, preserving the saved provider/model.
        monkeypatch.setattr(
            "backend.workflow_assistant.get_model",
            lambda config: get_model(config.model_copy(update={"base_url": url})),
        )
    assert client.put("/api/settings/model", json=config).status_code == 200
    session = client.post("/api/workflow-assistant/sessions", json={"mode": "create"}).json()
    before = len(client.get("/api/agents").json())
    response = client.post(
        f"/api/workflow-assistant/sessions/{session['id']}/messages", json={"message": "Create query flow"}
    )
    reply = response.json()["messages"][-1]
    assert reply["proposal"]["name"] == "Online generated"
    assert reply["mode"] == "openai"
    assert reply["model"] == config["model"]
    assert reply["duration_ms"] >= 0
    assert len(requests) == 1
    assert requests[0]["authorization"] == "Bearer private-test-key"
    assert requests[0]["body"]["model"] == config["model"]
    if qwen:
        assert requests[0]["body"]["enable_thinking"] is False
        assert requests[0]["body"]["response_format"] == {"type": "json_object"}
    else:
        assert "enable_thinking" not in requests[0]["body"]
        assert "response_format" not in requests[0]["body"]
    body = requests[0]["body"]
    assert body.get("max_completion_tokens", body.get("max_tokens")) == config["max_tokens"]
    assert len(client.get("/api/agents").json()) == before
    assert "private-test-key" not in response.text
    saved = client.get("/api/settings/model").json()
    assert saved["timeout_seconds"] == config["timeout_seconds"]
    assert saved["max_tokens"] == config["max_tokens"]
    # An existing conversation must pick up a newly saved model on its next turn.
    config.update(model="changed-model", api_key=None)
    assert client.put("/api/settings/model", json=config).status_code == 200
    again = client.post(
        f"/api/workflow-assistant/sessions/{session['id']}/messages", json={"message": "Rename the proposal"}
    ).json()
    assert again["messages"][-1]["model"] == "changed-model"
    assert requests[-1]["body"]["model"] == "changed-model"
    assert requests[-1]["authorization"] == "Bearer private-test-key"


@pytest.mark.parametrize("agent", ["model-summary", "material-analysis", "deep-analysis"])
def test_saved_model_configuration_is_used_by_runtime_and_evaluation(client, provider, agent):
    url, requests = provider
    assert client.put("/api/settings/model", json=settings(url)).status_code == 200
    response = client.post(
        "/api/runs",
        json={
            "agent_id": agent,
            "version": "1.0.0",
            "inputs": {"project_id": "PRJ-1001"},
            "idempotency_key": f"settings-test-{agent}",
        },
    )
    run_id = response.json()["id"]
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        run = client.get(f"/api/runs/{run_id}").json()
        if run["status"] in ("SUCCEEDED", "FAILED") and run["evaluation_status"] not in ("PENDING", "RUNNING"):
            break
        time.sleep(0.04)
    assert run["status"] == "SUCCEEDED", run
    assert run["model_mode"] == "openai"
    assert run["evaluation_status"] == "PASSED"
    assert len(requests) >= 2
    assert all(r["body"]["model"] == "fixture-model" for r in requests)
    assert all(r["authorization"] == "Bearer private-test-key" for r in requests)
    assert requests[0]["body"].get("max_completion_tokens", requests[0]["body"].get("max_tokens")) == 256
    assert "private-test-key" not in json.dumps(run)
    assert "private-test-key" not in client.get(f"/api/runs/{run_id}/event-log").text


def test_auth_failure_is_sanitized_and_keyless_provider_can_connect(client, provider):
    url, requests = provider
    failed = client.post("/api/settings/model/test", json=settings(url, api_key="invalid-test-key"))
    assert failed.status_code == 422
    assert failed.json()["code"] == "MODEL_CONNECTION_FAILED"
    assert "invalid-test-key" not in failed.text
    missing = client.post("/api/settings/model/test", json=settings(url, api_key=None))
    assert missing.json()["code"] == "MODEL_UNAVAILABLE"
    local = client.post("/api/settings/model/test", json=settings(url, api_key=None, requires_api_key=False))
    assert local.status_code == 200
    assert requests[-1]["authorization"] == "Bearer local-no-key"


@pytest.mark.parametrize(
    "patch",
    [
        {"base_url": "file:///etc/passwd"},
        {"base_url": "https://user:password@example.com/v1"},
        {"timeout_seconds": 0},
        {"max_tokens": 0},
        {"temperature": 3},
        {"model": " "},
    ],
)
def test_invalid_configuration_is_rejected_without_leaking_key(client, patch):
    response = client.put("/api/settings/model", json=settings(**patch))
    assert response.status_code == 422
    assert "private-test-key" not in response.text
    assert client.get("/api/settings/model").json()["mode"] == "demo"
