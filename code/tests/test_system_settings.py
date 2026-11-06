import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import TEST_PASSWORD, authenticate
from fastapi.testclient import TestClient
from test_generic_workflow import service  # noqa: F401 - reuse the real HTTP fixture

from backend.api import create_app
from backend.repository import Repository

pytestmark = pytest.mark.system_auth


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "demo")
    return create_app(tmp_path)


def new_user(client, username="seconduser"):
    response = client.post(
        "/api/admin/users", json={"username": username, "display_name": username, "password": TEST_PASSWORD}
    )
    assert response.status_code == 201, response.text
    return response.json()


def login(client, username="testadmin", password=TEST_PASSWORD):
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return response.json()["user"]


def change_temporary(client, username):
    user = login(client, username)
    assert user["must_change_password"]
    assert client.get("/api/workspaces").status_code == 403
    assert (
        client.post(
            "/api/auth/password", json={"current_password": TEST_PASSWORD, "new_password": TEST_PASSWORD + "-changed"}
        ).status_code
        == 200
    )
    assert client.get("/api/me").status_code == 401
    return login(client, username, TEST_PASSWORD + "-changed")


def create_workspace(client, name="New workspace", template="empty"):
    response = client.post("/api/workspaces", json={"name": name, "template": template})
    assert response.status_code == 201, response.text
    return response.json()


def wait_for(client, path, predicate):
    end = time.monotonic() + 15
    while time.monotonic() < end:
        value = client.get(path).json()
        if predicate(value):
            return value
        time.sleep(0.04)
    raise AssertionError(value)


def test_setup_once_cookie_csrf_origin_and_secret_validation(app):
    with TestClient(app) as client:
        assert client.get("/api/agents").status_code == 401
        assert client.get("/api/settings/model").status_code == 401
        user = authenticate(client)
        assert user["is_admin"]
        assert "password_hash" not in json.dumps(user)
        session_cookie = client.cookies.get("workflow_session")
        records = app.state.control.list("session")
        assert session_cookie not in json.dumps(records)
        assert app.state.control.list("user")[0]["password_hash"].startswith("$argon2id$")
        assert (
            client.post(
                "/api/auth/setup", json={"username": "another", "display_name": "Other", "password": TEST_PASSWORD}
            ).status_code
            == 409
        )
        assert client.post("/api/workspaces", headers={"X-CSRF-Token": ""}, json={"name": "No csrf"}).status_code == 403
        assert (
            client.post(
                "/api/workspaces", headers={"Origin": "http://attacker.invalid"}, json={"name": "Bad origin"}
            ).status_code
            == 403
        )
        response = client.post(
            "/api/admin/users",
            json={"username": "bad space", "display_name": "Bad", "password": "sensitive-password-value"},
        )
        assert response.status_code == 422
        assert "sensitive-password-value" not in response.text
        headers = (
            client.post("/api/auth/login", json={"username": "TESTADMIN", "password": TEST_PASSWORD})
            .headers["set-cookie"]
            .lower()
        )
        assert "httponly" in headers and "samesite=lax" in headers and "max-age=43200" in headers


def test_login_limits_expiry_password_rotation_and_cli_hash_policy(app):
    with TestClient(app) as client:
        authenticate(client)
        for _ in range(5):
            assert (
                client.post("/api/auth/login", json={"username": "missinguser", "password": "invalid"}).status_code
                == 401
            )
        assert (
            client.post("/api/auth/login", json={"username": "MISSINGUSER", "password": "invalid"}).status_code == 429
        )
        session = app.state.control.list("session")[0]
        app.state.control.put("session", session["id"], {**session, "expires_at": time.time() - 1})
        assert client.get("/api/me").status_code == 401
        login(client)
        old_cookie = client.cookies.get("workflow_session")
        response = client.post(
            "/api/auth/password", json={"current_password": TEST_PASSWORD, "new_password": TEST_PASSWORD + "-new"}
        )
        assert response.status_code == 200
        assert app.state.control.authenticate(old_cookie) is None
        assert client.get("/api/me").status_code == 401
        login(client, password=TEST_PASSWORD + "-new")


def test_profile_revision_casefold_preferences_and_last_admin(app):
    with TestClient(app) as client:
        user = authenticate(client)
        second = new_user(client)
        data = {k: user[k] for k in ("username", "display_name", "email", "avatar", "avatar_color", "revision")}
        data.update(username="renamedadmin", display_name="Renamed", email="local@example.com")
        assert client.patch("/api/me", json=data).status_code == 403
        response = client.patch("/api/me", json={**data, "current_password": TEST_PASSWORD})
        assert response.status_code == 200, response.text
        assert response.json()["id"] == user["id"]
        assert client.patch("/api/me", json={**data, "current_password": TEST_PASSWORD}).status_code == 409
        data["revision"] = response.json()["revision"]
        assert (
            client.patch(
                "/api/me", json={**data, "username": second["username"].upper(), "current_password": TEST_PASSWORD}
            ).status_code
            == 409
        )
        assert (
            client.post(f"/api/admin/users/{user['id']}/disable", json={"revision": data["revision"]}).status_code
            == 409
        )
        prefs = {"theme": "dark", "accent": "blue", "default_workspace_id": "ws_legacy"}
        assert client.put("/api/me/preferences", json=prefs).json() == prefs
        assert client.get("/api/auth/me").json()["user"]["preferences"] == prefs
        assert client.put("/api/me/preferences", json={**prefs, "theme": "arbitrary-css"}).status_code == 422


def test_two_users_four_workspaces_full_isolation(app, monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "environment-secret-not-for-new-spaces")
    with TestClient(app) as client:
        authenticate(client)
        new_user(client)
        a = create_workspace(client, "A")
        b = create_workspace(client, "B")
        scope_a, scope_b = f"/api/workspaces/{a['id']}", f"/api/workspaces/{b['id']}"
        assert client.get(scope_a + "/agents").json() == []
        assert client.get(scope_a + "/connections").json() == []
        config = client.get(scope_a + "/settings/model").json()
        assert config["mode"] == "demo" and not config["api_key_configured"]
        draft = client.post(scope_a + "/agents/blank", json={"name": "Only A", "schema_version": "2.0"}).json()
        assert client.get(scope_b + f"/agents/{draft['id']}").status_code == 404
        session = client.post(scope_a + "/workflow-assistant/sessions", json={"mode": "create"}).json()
        assert client.get(scope_b + f"/workflow-assistant/sessions/{session['id']}").status_code == 404
        a_repo = app.state.manager.apps[a["id"]].state.repo
        b_repo = app.state.manager.apps[b["id"]].state.repo
        for repo, name in ((a_repo, "A"), (b_repo, "B")):
            repo.put("agent", "same-id", {"id": "same-id", "name": name})
        assert client.get(scope_a + "/agents/same-id").json()["name"] == "A"
        assert client.get(scope_b + "/agents/same-id").json()["name"] == "B"
        assert app.state.manager.apps[a["id"]].state.runtime.pool is app.state.manager.apps[b["id"]].state.runtime.pool
        assert client.post("/api/auth/logout").status_code == 200
        user = change_temporary(client, "seconduser")
        c = create_workspace(client, "C")
        d = create_workspace(client, "D")
        for workspace in (a, b):
            for tail in (
                "",
                "/agents",
                "/runs/any",
                "/runs/any/events",
                "/evidence/any",
                "/settings/model",
                "/model-profiles",
                "/connections",
                "/workflow-assistant/sessions/any",
            ):
                assert client.get(f"/api/workspaces/{workspace['id']}" + tail).status_code == 404
            assert (
                client.post(f"/api/workspaces/{workspace['id']}/agents/blank", json={"name": "Bad"}).status_code == 404
            )
        assert client.get("/api/agents").status_code == 404
        assert client.get("/api/admin/users").status_code == 403
        assert {w["owner_id"] for w in client.get("/api/workspaces").json()} == {user["id"]}
        assert client.get(f"/api/workspaces/{c['id']}/agents").json() == []
        assert client.get(f"/api/workspaces/{d['id']}/settings/model").json()["mode"] == "demo"
        assert "environment-secret-not-for-new-spaces" not in json.dumps(app.state.control.list("audit"))


def test_archive_default_revision_readonly_restore_and_blockers(app):
    with TestClient(app) as client:
        authenticate(client)
        a = create_workspace(client)
        root = f"/api/workspaces/{a['id']}"
        prefs = {"theme": "light", "accent": "rose", "default_workspace_id": a["id"]}
        assert client.put("/api/me/preferences", json=prefs).status_code == 200
        assert client.patch(root, json={"revision": 99, "name": "Conflict"}).status_code == 409
        archived = client.post(root + "/archive", json={"revision": a["revision"]})
        assert archived.status_code == 200
        assert client.get(root + "/agents").status_code == 200
        assert client.post(root + "/agents/blank", json={"name": "No"}).status_code == 409
        assert client.put("/api/me/preferences", json=prefs).status_code == 409
        assert client.get("/api/me/preferences").json()["default_workspace_id"] == "ws_legacy"
        restored = client.post(root + "/restore", json={"revision": archived.json()["revision"]}).json()
        assert restored["id"] == a["id"] and restored["archived_at"] is None
        repo = app.state.manager.apps[a["id"]].state.repo
        repo.put(
            "run", "pending-input", {"id": "pending-input", "status": "AWAITING_INPUT", "evaluation_status": "PENDING"}
        )
        blocked = client.post(root + "/archive", json={"revision": restored["revision"]})
        assert blocked.status_code == 409 and "pending-input" in blocked.text
        repo.update("run", "pending-input", status="CANCELLED", evaluation_status="PASSED")
        repo.put("operation", "unknown-operation", {"run_id": "pending-input", "status": "UNKNOWN"})
        assert client.post(root + "/archive", json={"revision": restored["revision"]}).status_code == 409
        repo.update("operation", "unknown-operation", status="CONFIRMED")
        assert client.post(root + "/archive", json={"revision": restored["revision"]}).status_code == 200
        assert client.post("/api/workspaces/ws_legacy/archive", json={"revision": 1}).status_code == 409


def test_admin_reset_disable_and_restore_revokes_sessions(app):
    with TestClient(app) as client:
        authenticate(client)
        user = new_user(client)
        reset = client.post(
            f"/api/admin/users/{user['id']}/reset-password",
            json={"revision": user["revision"], "new_password": TEST_PASSWORD + "-reset"},
        )
        assert reset.status_code == 200 and reset.json()["must_change_password"]
        user = reset.json()
        assert (
            client.post(f"/api/admin/users/{user['id']}/disable", json={"revision": user["revision"]}).status_code
            == 200
        )
        assert (
            client.post(
                "/api/auth/login", json={"username": user["username"], "password": TEST_PASSWORD + "-reset"}
            ).status_code
            == 401
        )
        user = next(u for u in client.get("/api/admin/users").json() if u["id"] == user["id"])
        assert (
            client.post(f"/api/admin/users/{user['id']}/restore", json={"revision": user["revision"]}).status_code
            == 200
        )
        login(client, user["username"], TEST_PASSWORD + "-reset")


def test_migration_and_restart_preserve_history_and_owned_workspaces(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "demo")
    old = Repository(tmp_path)
    evidence = {
        "id": "ev_1111111111111111",
        "run_id": "historical",
        "node_id": "old",
        "created_at": "2025-01-01",
        "number": 7,
        "sha256": "original-digest",
        "data": {"unchanged": True},
    }
    old.put("evidence", evidence["id"], evidence)
    old.close()
    with TestClient(create_app(tmp_path)) as first:
        owner = authenticate(first)
        workspace = create_workspace(first, "Persistent")
        assert first.app.state.repo.get("evidence", evidence["id"]) == evidence
    with TestClient(create_app(tmp_path)) as second:
        user = login(second)
        assert user["id"] == owner["id"]
        rows = second.get("/api/workspaces").json()
        assert len([w for w in rows if w["id"] == "ws_legacy"]) == 1
        assert any(w["id"] == workspace["id"] for w in rows)
        assert second.app.state.repo.get("evidence", evidence["id"]) == evidence


def test_six_node_pending_run_survives_switch_logout_and_restart(tmp_path, service):  # noqa: F811
    with TestClient(create_app(tmp_path)) as first:
        owner = authenticate(first)
        other = create_workspace(first, "Other")
        response = first.post(
            "/api/workspaces/ws_legacy/runs",
            json={
                "agent_id": "customer-order-summary",
                "version": "1.0.0",
                "inputs": {"customer_id": "CUST-1001"},
                "idempotency_key": str(uuid.uuid4()),
            },
        )
        assert response.status_code == 202, response.text
        run_id = response.json()["id"]
        path = f"/api/workspaces/ws_legacy/runs/{run_id}"
        pending = wait_for(first, path, lambda r: r["status"] == "AWAITING_INPUT")
        assert pending["submitted_by"] == owner["id"]
        assert first.get(f"/api/workspaces/{other['id']}/runs/{run_id}").status_code == 404
        assert first.post("/api/auth/logout").status_code == 200
        assert first.get(path).status_code == 401
    with TestClient(create_app(tmp_path)) as second:
        login(second)
        pending = second.get(path).json()
        review = pending["input_requests"][0]
        result = second.post(
            path + f"/inputs/{review['id']}",
            json={
                "revision": review["revision"],
                "decision": "accept",
                "payload": {},
                "idempotency_key": str(uuid.uuid4()),
            },
        )
        assert result.status_code == 200, result.text
        completed = wait_for(second, path, lambda r: r["status"] == "SUCCEEDED")
        assert completed["usage"] == {"model_calls": 1, "tool_calls": 1}
        events = second.get(path + "/event-log").json()
        assert all(e["actor_ref"] == owner["id"] for e in events)
        assert result.json()["actor_ref"] == owner["id"]


def test_initialization_is_atomic_under_concurrent_requests(app):
    with TestClient(app) as client:

        def initialize(index):
            return client.post(
                "/api/auth/setup",
                json={"username": f"admin{index}", "display_name": "Admin", "password": TEST_PASSWORD},
            ).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(initialize, range(2))) == [201, 409]
        assert len(app.state.control.list("user")) == 1
        assert len(app.state.control.list("workspace")) == 1


def test_sse_heartbeat_disconnects_after_session_revocation(app):
    with TestClient(app) as client:
        owner = authenticate(client)
        app.state.repo.put("run", "streaming", {"id": "streaming", "status": "AWAITING_APPROVAL"})
        timer = threading.Timer(0.15, lambda: app.state.control.revoke(owner["id"]))
        timer.start()
        try:
            response = client.get("/api/workspaces/ws_legacy/runs/streaming/events")
            assert response.status_code == 200
            assert "event: session-expired" in response.text
            assert client.get("/api/workspaces/ws_legacy/runs/streaming/events").status_code == 401
        finally:
            timer.join()


def test_workspaces_share_three_execution_slots(app, monkeypatch):
    with TestClient(app) as client:
        authenticate(client)
        workspaces = [create_workspace(client, str(i)) for i in range(4)]
        runtimes = [app.state.manager.apps[w["id"]].state.runtime for w in workspaces]
        started = []
        completed = []
        release = threading.Event()

        def execute(run_id):
            started.append(run_id)
            release.wait(5)
            completed.append(run_id)

        for index, runtime in enumerate(runtimes):
            monkeypatch.setattr(runtime, "execute", execute)
            runtime.repo.put("run", str(index), {"id": str(index), "status": "HELD"})
        try:
            for index, runtime in enumerate(runtimes):
                with runtime.repo.transaction():
                    # schedule now rechecks eligibility to prevent cancelled-run revival.
                    runtime.repo.update("run", str(index), status="QUEUED")
                    runtime.schedule("test", str(index))
                    if not runtime.active:
                        runtime.repo.update("run", str(index), status="HELD")
            end = time.monotonic() + 3
            while len(started) < 3 and time.monotonic() < end:
                time.sleep(0.01)
            assert len(started) == 3
            assert len(runtimes[3].active) == 0
            assert runtimes[3].repo.get("run", "3")["status"] == "HELD"
            release.set()
            end = time.monotonic() + 3
            while len(completed) < 3 and time.monotonic() < end:
                time.sleep(0.01)
            assert len(completed) == 3
            with runtimes[3].repo.transaction():
                runtimes[3].repo.update("run", "3", status="QUEUED")
                runtimes[3].schedule("test", "3")
            runtimes[3].active["test"].result(timeout=3)
            assert len(started) == 4
        finally:
            release.set()


def test_disable_blocks_pending_work_owned_by_target(app):
    with TestClient(app) as client:
        authenticate(client)
        user = new_user(client)
        workspace = next(w for w in app.state.control.list("workspace") if w["owner_id"] == user["id"])
        repo = app.state.manager.open(workspace).state.repo
        repo.put("run", "waiting", {"id": "waiting", "status": "AWAITING_APPROVAL"})
        response = client.post(f"/api/admin/users/{user['id']}/disable", json={"revision": user["revision"]})
        assert response.status_code == 409
        assert workspace["id"] in response.text
        assert not app.state.control.get("user", user["id"])["disabled"]


def test_local_cli_recovers_admin_and_revokes_sessions(tmp_path, monkeypatch, capsys):
    from backend import manage

    with TestClient(create_app(tmp_path)) as client:
        authenticate(client)
        new_user(client)
        previous_token = client.cookies.get("workflow_session")
    replacement = "Recovered-admin-password-2026"
    answers = iter((replacement, replacement))
    monkeypatch.setattr(manage.getpass, "getpass", lambda prompt: next(answers))
    arguments = ["manage", "reset-password", "--username", "testadmin", "--data-dir", str(tmp_path)]
    monkeypatch.setattr("sys.argv", arguments)
    manage.main()
    assert replacement not in capsys.readouterr().out
    with TestClient(create_app(tmp_path)) as client:
        client.cookies.set("workflow_session", previous_token)
        assert client.get("/api/auth/me").status_code == 401
        assert not login(client, password=replacement)["must_change_password"]
    arguments[3] = "seconduser"
    monkeypatch.setattr("sys.argv", arguments)
    with pytest.raises(SystemExit) as error:
        manage.main()
    assert error.value.code == 2
