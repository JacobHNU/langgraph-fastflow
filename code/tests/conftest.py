import pytest
from fastapi.testclient import TestClient

TEST_PASSWORD = "Test-admin-password-2026"


def authenticate(client, username="testadmin", password=TEST_PASSWORD):
    status = client.get("/api/auth/status")
    if not status.json()["initialized"]:
        response = client.post(
            "/api/auth/setup", json={"username": username, "display_name": "Test administrator", "password": password}
        )
    else:
        response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code in (200, 201), response.text
    client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return response.json()["user"]


@pytest.fixture(autouse=True)
def existing_authenticated_clients(request, monkeypatch):
    if request.node.get_closest_marker("system_auth"):
        return
    original = TestClient.__enter__

    def enter(client):
        entered = original(client)
        authenticate(entered)
        return entered

    monkeypatch.setattr(TestClient, "__enter__", enter)
