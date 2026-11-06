import copy
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from test_generic_workflow import await_input, confirm, launch_generic, publish, sample
from test_generic_workflow import client as generic_client
from test_generic_workflow import service as generic_service
from test_integration import launch, wait_run
from test_model_settings import provider as model_provider
from test_model_settings import settings

from backend.api import create_app
from backend.compiler import validate
from backend.data_policy import BUSINESS_DATA_POLICY
from backend.model_settings import ModelSettingsRequest, ModelSettingsStore
from backend.repository import Repository
from backend.runtime import Runtime
from backend.schemas import Workflow

client = generic_client
service = generic_service
provider = model_provider


def test_scoped_credentials_unsaved_probe_clear_replace_and_restart(client, provider):
    url, calls = provider
    a = settings(url, api_key="provider-a-key", api_key_action="replace")
    b = settings(url + "/other", api_key=None, api_key_action="preserve")
    assert client.put("/api/settings/model", json=a).status_code == 200
    resources = client.app.state.runtime.resources
    old_binding = resources.refresh_default()
    store = client.app.state.runtime.model_settings
    original = store.path.read_bytes()
    # Neither probing nor fetching models may send A's key to B's endpoint.
    for endpoint in ("test", "models"):
        assert client.post(f"/api/settings/model/{endpoint}", json=b).status_code == 422
    assert calls == [] and store.path.read_bytes() == original
    assert not client.put("/api/settings/model", json=b).json()["api_key_configured"]
    b.update(api_key="provider-b-key", api_key_action="replace")
    assert client.put("/api/settings/model", json=b).json()["api_key_configured"]
    assert resources.model_config(old_binding).api_key.get_secret_value() == "provider-a-key"
    original = store.path.read_bytes()
    a.update(api_key=None, api_key_action="preserve")
    assert client.post("/api/settings/model/test", json=a).status_code == 200
    assert calls[-1]["authorization"] == "Bearer provider-a-key"
    assert store.path.read_bytes() == original
    assert client.put("/api/settings/model", json=a).json()["api_key_configured"]
    # Reopening uses only disk, including the migrated per-endpoint credential map.
    reopened = ModelSettingsStore(store.path.parent, allow_environment=False)
    assert reopened.current().api_key.get_secret_value() == "provider-a-key"
    b.update(api_key=None, api_key_action="clear")
    assert not reopened.save(ModelSettingsRequest(**b))["api_key_configured"]
    assert reopened.candidate(ModelSettingsRequest(**a)).api_key.get_secret_value() == "provider-a-key"
    b.update(api_key_action="preserve")
    assert not reopened.candidate(ModelSettingsRequest(**b)).api_key.get_secret_value()
    # Identical URL under a different provider also cannot inherit the old key.
    assert not reopened.candidate(ModelSettingsRequest(**{**a, "provider": "deepseek"})).api_key.get_secret_value()
    assert "provider-a-key" not in client.get("/api/settings/model").text


@pytest.mark.parametrize(
    "patch",
    [
        {"api_key_action": "preserve"},
        {"api_key_action": "clear"},
        {"api_key_action": "replace", "api_key": None},
        {"api_key_action": "replace", "clear_api_key": True},
    ],
)
def test_conflicting_credential_intents_never_write(client, patch):
    store = client.app.state.runtime.model_settings
    before = store.path.read_bytes() if store.path.exists() else None
    response = client.put("/api/settings/model", json=settings(**patch))
    assert response.status_code == 422
    assert "private-test-key" not in response.text
    assert (store.path.read_bytes() if store.path.exists() else None) == before


def test_model_profile_credentials_are_scoped_and_old_versions_unchanged(client):
    body = {**settings(), "name": "Scoped profile"}
    first = client.post("/api/model-profiles", json=body).json()
    path = f"/api/model-profiles/{first['id']}"
    body.update(revision=1, base_url="http://127.0.0.1:11435/v1", api_key=None)
    second = client.put(path, json=body).json()
    assert not second["credential_configured"]
    body.update(revision=2, base_url=first["config"]["base_url"], api_key_action="preserve")
    third = client.put(path, json=body).json()
    assert third["credential_configured"]
    resources = client.app.state.runtime.resources
    assert resources.secret(first["credential_ref"]) == "private-test-key"
    assert not resources.secret(second["credential_ref"])
    assert first["credential_ref"] != third["credential_ref"]


def pending_task(client, kind):
    if kind == "human_input":
        run = await_input(client, launch_generic(client))
        return run, run["input_requests"][0]
    run = wait_run(client, launch(client, "approved-update", progress=82))
    assert run["status"] == "AWAITING_APPROVAL"
    return run, run["approvals"][0]


@pytest.mark.parametrize("kind", ["human_input", "approval"])
def test_cancel_closes_tasks_once_and_stale_schedule_cannot_revive(client, kind):
    run, task = pending_task(client, kind)
    path = f"/api/runs/{run['id']}/cancel"
    assert client.post(path).json()["status"] == "CANCELLED"
    assert client.post(path).json()["status"] == "CANCELLED"
    repo, runtime = client.app.state.repo, client.app.state.runtime
    closed = repo.get(kind, task["id"])
    assert closed["status"] == "CANCELLED"
    assert closed["revision"] == task.get("revision", 1) + 1
    assert closed["closed_by"].startswith("user_")
    assert closed["closure_reason"] == "RUN_CANCELLED"
    runtime.schedule("run:" + run["id"], run["id"])
    runtime.finish(run["id"], "SUCCEEDED")
    runtime.execute(run["id"])
    assert repo.get("run", run["id"])["status"] == "CANCELLED"
    events = [e for e in repo.events(run["id"]) if e["event_type"].endswith(".closed")]
    assert len(events) == 1 and events[0]["actor_ref"] == closed["closed_by"]


@pytest.mark.parametrize("kind", ["human_input", "approval"])
def test_expiry_closes_task_and_keeps_reason(client, kind):
    run, task = pending_task(client, kind)
    repo, runtime = client.app.state.repo, client.app.state.runtime
    with repo.transaction():
        repo.update(kind, task["id"], expires_at=0)
        runtime.expire_waiting(run["id"])
    closed = repo.get(kind, task["id"])
    assert closed["status"] == "EXPIRED"
    assert closed["closure_reason"] == ("INPUT_EXPIRED" if kind == "human_input" else "APPROVAL_EXPIRED")
    assert repo.get("run", run["id"])["status"] == "CANCELLED"


def test_finish_is_atomic_and_recovery_only_closes_pending(tmp_path, monkeypatch):
    repo = Repository(tmp_path)
    runtime = Runtime(repo)
    try:
        repo.put("run", "run_test", {"id": "run_test", "status": "AWAITING_INPUT", "cancel_requested": False})
        for status in ("PENDING", "ACCEPTED", "REJECTED"):
            repo.put("human_input", status, {"id": status, "run_id": "run_test", "node_id": "n", "status": status})
        original = repo.event

        def fail(*args, **kwargs):
            raise OSError("injected audit failure")

        with monkeypatch.context() as patch:
            patch.setattr(repo, "event", fail)
            with pytest.raises(OSError):
                runtime.finish("run_test", "FAILED")
        assert repo.get("run", "run_test")["status"] == "AWAITING_INPUT"
        assert repo.get("human_input", "PENDING")["status"] == "PENDING"
        assert repo.events("run_test") == []
        monkeypatch.setattr(repo, "event", original)
        # Simulate a legacy terminal run with an orphaned pending task.
        repo.update("run", "run_test", status="FAILED", error={"code": "OLD_FAILURE"})
        runtime.recover()
        runtime.recover()
        assert repo.get("human_input", "PENDING")["status"] == "CLOSED"
        assert repo.get("human_input", "ACCEPTED")["status"] == "ACCEPTED"
        assert repo.get("human_input", "REJECTED")["status"] == "REJECTED"
        assert len(repo.events("run_test")) == 1
        assert repo.events("run_test")[0]["payload"]["recovered"]
    finally:
        runtime.pool.shutdown()
        repo.close()


def test_cancel_and_feedback_race_has_one_consistent_outcome(client):
    run, task = pending_task(client, "human_input")
    with ThreadPoolExecutor(2) as pool:
        cancelled = pool.submit(client.post, f"/api/runs/{run['id']}/cancel")
        submitted = pool.submit(confirm, client, run)
        assert cancelled.result().status_code == 200
        assert submitted.result().status_code in (200, 409)
    final = wait_run(client, run["id"])
    assert final["status"] == "CANCELLED"
    record = client.app.state.repo.get("human_input", task["id"])
    assert record["status"] in ("ACCEPTED", "CANCELLED")
    assert not any(r["status"] == "PENDING" for r in final["input_requests"])


def feedback_workflow(client):
    workflow = sample(client)
    human = next(n for n in workflow["nodes"] if n["type"] == "human_input")
    human["config"]["form_schema"] = {
        "type": "object",
        "properties": {
            "authorization_status": {"type": "string", "enum": ["业务已授权"]},
            "secretary_note": {"type": "string", "minLength": 3},
        },
        "required": ["authorization_status", "secretary_note"],
        "additionalProperties": False,
    }
    human["output_schema"] = copy.deepcopy(human["config"]["form_schema"])
    human["output_schema"]["properties"]["accepted"] = {"type": "boolean"}
    output = next(n for n in workflow["nodes"] if n["type"] == "output")
    output["inputs"]["feedback"] = {"source": "node", "node_id": human["id"], "path": []}
    workflow["output_schema"]["properties"]["feedback"] = {"type": "object"}
    return workflow


def test_business_feedback_preserves_meaning_across_queued_restart_and_audit_stays_redacted(tmp_path, service):
    payload = {"authorization_status": "业务已授权", "secretary_note": "业务联系人已核对"}
    with TestClient(create_app(tmp_path)) as first:
        release = publish(first, feedback_workflow(first))
        run = await_input(first, launch_generic(first, release))
        # Persist the decision but do not let the scheduler execute the resumed segment.
        slots = first.app.state.runtime.slots
        for _ in range(3):
            assert slots.acquire(timeout=10)
        try:
            response = confirm(first, run, payload=payload)
            assert response.status_code == 200, response.text
            assert response.json()["payload"] == payload
            assert first.get(f"/api/runs/{run['id']}").json()["status"] == "QUEUED"
            # The feedback was accepted in time; queue delay must not invalidate it.
            first.app.state.repo.update("human_input", run["input_requests"][0]["id"], expires_at=0)
        finally:
            first.app.state.runtime.stopping = True
            for _ in range(3):
                slots.release()
    with TestClient(create_app(tmp_path)) as second:
        result = wait_run(second, run["id"])
        assert result["status"] == "SUCCEEDED", result
        assert result["result"]["feedback"] == {**payload, "accepted": True}
        assert result["input_requests"][0]["payload"] == payload
        assert result["business_data_policy"] == BUSINESS_DATA_POLICY
        events = second.get(f"/api/runs/{run['id']}/event-log").json()
        event = next(e for e in events if e["event_type"] == "input.resolved")
        assert event["payload"]["payload"] == {key: "[REDACTED]" for key in payload}
        evidence = second.get(f"/api/runs/{run['id']}/evidence").json()
        assert "业务联系人已核对" not in json.dumps(evidence, ensure_ascii=False)
    assert len(service[0]["requests"]) == 1


@pytest.mark.parametrize(
    "payload",
    [
        {"api_key": "forbidden-inline-credential"},
        {"nested": [{"clientSecret": "forbidden-inline-credential"}]},
        {"feedback": "Bearer forbidden-inline-credential"},
    ],
)
@pytest.mark.parametrize("decision", ["accept", "reject"])
def test_credential_feedback_is_rejected_before_persistence_even_on_rejection(client, payload, decision):
    run, task = pending_task(client, "human_input")
    response = confirm(client, run, payload=payload, decision=decision)
    assert response.status_code == 422
    assert response.json()["code"] == "CREDENTIAL_INPUT_FORBIDDEN"
    assert "forbidden-inline-credential" not in response.text
    assert client.app.state.repo.get("human_input", task["id"])["status"] == "PENDING"
    assert "forbidden-inline-credential" not in json.dumps(client.app.state.repo.list("human_input"))


def test_credential_fields_in_schema_and_constants_fail_publish_validation(client):
    for key in ("apiKey", "client_secret", "access_token"):
        workflow = feedback_workflow(client)
        human = next(n for n in workflow["nodes"] if n["type"] == "human_input")
        human["config"]["form_schema"]["properties"][key] = {"type": "string"}
        assert validate(Workflow.model_validate(workflow), client.app.state.runtime.resources)


def test_lost_legacy_feedback_fails_explicitly_instead_of_executing_placeholder(client):
    run, task = pending_task(client, "human_input")
    repo = client.app.state.repo
    with repo.transaction():
        old = copy.deepcopy(repo.get("human_input", task["id"]))
        old.pop("business_data_policy", None)
        old.update(status="ACCEPTED", payload={"feedback": "[REDACTED]"})
        repo.put("human_input", task["id"], old)
        repo.update("run", run["id"], status="QUEUED", resume={"request_id": task["id"]})
    result = wait_run(client, run["id"])
    assert result["status"] == "FAILED"
    assert result["error"]["code"] == "INPUT_FEEDBACK_UNRECOVERABLE"
    assert result["input_requests"][0]["status"] == "ACCEPTED"
    assert "n_output" not in result["node_results"]
