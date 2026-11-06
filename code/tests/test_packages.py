import copy
import io
import tarfile
import threading
import time
import zipfile
from http.server import ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from test_generic_workflow import await_input, confirm
from test_generic_workflow import client as generic_client
from test_generic_workflow import service as generic_service
from test_integration import wait_evaluation, wait_run

from backend.demo_orders import OrdersHandler
from backend.headless import RuntimeLock, create_app
from backend.package_archive import (
    WORKFLOW_PATH,
    json_read,
    manifest_digest,
    read_archive,
    sha,
    write_archive,
)
from backend.packages import capabilities, export_release, inspect_package
from backend.runtime import Runtime
from backend.schemas import BusinessError

client = generic_client
service = generic_service


def exported(client, container="tar.gz", agent="customer-order-summary"):
    response = client.post(f"/api/agents/{agent}/versions/1.0.0/export-jobs", json={"container": container})
    assert response.status_code == 201, response.text
    job = response.json()
    data = client.get(f"/api/export-jobs/{job['id']}/download").content
    return job, data


def import_package(target, data):
    response = target.post("/api/runtime/import-jobs", content=data)
    assert response.status_code == 201, response.text
    job = response.json()
    assert target.get("/api/runtime/packages").json() == []
    assert target.post(f"/api/runtime/import-jobs/{job['id']}/commit", json={}).status_code == 403
    response = target.post(f"/api/runtime/import-jobs/{job['id']}/commit", json={"trust_unsigned": True})
    assert response.status_code == 201, response.text
    return response.json()


def bind_and_deploy(target, package, url):
    contracts = package["resources"]
    mapping = {"models": {}, "connections": {}}
    for model in contracts["models"]:
        mapping["models"][model["ref"]] = target.get("/api/model-profiles").json()[0]["ref"]
    for connection in contracts["connections"]:
        response = target.post(
            "/api/connections",
            json={
                "name": "Target orders",
                "base_url": url,
                "auth_type": "none",
                "operations": connection["operations"],
            },
        )
        assert response.status_code == 201, response.text
        mapping["connections"][connection["ref"]] = response.json()["ref"]
    body = {"package_key": package["id"], "mappings": mapping, "authorize_credentials": True}
    response = target.post("/api/runtime/bindings", json=body)
    assert response.status_code == 201, response.text
    binding = response.json()
    response = target.post("/api/runtime/deployments", json={"binding_id": binding["id"], "name": "Target deployment"})
    assert response.status_code == 201, response.text
    return response.json(), binding, body


def submit(target, deployment, key="package-run-1", test=True, **inputs):
    return target.post(
        f"/api/runtime/deployments/{deployment['id']}/{'test-runs' if test else 'runs'}",
        json={"inputs": inputs or {"customer_id": "CUST-1001"}, "idempotency_key": key},
    )


def test_reproducible_containers_no_environment_or_history(client):
    first, tar = exported(client)
    second, zip_data = exported(client, "zip")
    third, again = exported(client)
    assert first["package_digest"] == second["package_digest"] == third["package_digest"]
    assert tar == again and first["archive_digest"] != second["archive_digest"]
    manifest, files, contracts = inspect_package(tar)
    assert read_archive(zip_data)[0] == manifest
    assert contracts["connections"][0]["operations"][0]["id"] == "orders.list@1"
    text = b"\n".join(files.values()).decode()
    for excluded in ("base_url", "credential_ref", "workspace_id", "submitted_by", "checkpoint", "18765"):
        assert excluded not in text
    # Draft edits do not alter an already published package.
    repo = client.app.state.repo
    original = repo.get("agent", "customer-order-summary")
    changed = copy.deepcopy(original)
    changed["workflow"]["nodes"][1]["title"] = "Edited draft only"
    repo.put("agent", original["id"], changed)
    assert exported(client)[0]["package_digest"] == first["package_digest"]


def test_headless_import_binding_execution_and_lifecycle(client, service, tmp_path):
    _, data = exported(client)
    with TestClient(create_app(tmp_path / "target")) as target:
        assert target.get("/api/health").json()["service"] == "fastflow-runtime"
        assert target.get("/api/agents").status_code == 404
        assert target.get("/api/assistant/sessions").status_code == 404
        package = import_package(target, data)
        deployment, binding, _body = bind_and_deploy(target, package, service[1])
        assert binding["resolved_bindings"]["connections"]["conn_orders@1"]["base_url"] == service[1]
        assert (
            target.post(f"/api/runtime/deployments/{deployment['id']}/activate", json={"revision": 1}).status_code
            == 422
        )
        assert submit(target, deployment, test=False).status_code == 422
        run = submit(target, deployment).json()
        pending = await_input(target, run["id"])
        assert pending["package_digest"] == package["manifest"]["package_digest"]
        assert pending["workflow"] == json_read(read_archive(data)[1][WORKFLOW_PATH])
        assert pending["binding_digest"] == binding["binding_digest"]
        assert confirm(target, pending).status_code == 200
        assert wait_run(target, run["id"])["status"] == "SUCCEEDED"
        assert wait_evaluation(target, run["id"])["status"] == "PASSED"
        response = target.post(f"/api/runtime/deployments/{deployment['id']}/activate", json={"revision": 1})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "ACTIVE"
        real = submit(target, deployment, key="production-1", test=False).json()
        assert await_input(target, real["id"])["status"] == "AWAITING_INPUT"
        # Disable affects new requests; an idempotent retry still returns the original run.
        assert (
            target.post(f"/api/runtime/deployments/{deployment['id']}/disable", json={"revision": 2}).status_code == 200
        )
        assert submit(target, deployment, key="production-1", test=False).json()["id"] == real["id"]
        assert submit(target, deployment, key="production-1", test=False, customer_id="CUST-1002").status_code == 409
        assert submit(target, deployment, key="production-2", test=False).status_code == 422
        assert (
            target.post(f"/api/runtime/deployments/{deployment['id']}/activate", json={"revision": 1}).status_code
            == 409
        )
        # Waiting runs survive headless process lifecycles; restore below.
        waiting_id = real["id"]
    with TestClient(create_app(tmp_path / "target")) as target:
        pending = target.get("/api/runtime/runs/" + waiting_id).json()
        assert pending["status"] == "AWAITING_INPUT"
        assert confirm(target, pending).status_code == 200
        assert wait_run(target, waiting_id)["status"] == "SUCCEEDED"
        assert wait_evaluation(target, waiting_id)["status"] == "PASSED"


def rewrite(data, mutate):
    manifest, files = read_archive(data)
    files.pop("manifest.json")
    mutate(manifest, files)
    manifest["files"] = [
        {"path": path, "size_bytes": len(value), "sha256": sha(value)} for path, value in sorted(files.items())
    ]
    manifest["package_digest"] = manifest_digest(manifest)
    return write_archive(manifest, files)


def test_contract_mismatch_secret_and_unknown_capability(client, service, tmp_path):
    _, data = exported(client)
    with TestClient(create_app(tmp_path / "target")) as target:
        package = import_package(target, data)
        deployment, _, body = bind_and_deploy(target, package, service[1])
        denied = {**body, "authorize_credentials": False}
        assert target.post("/api/runtime/bindings", json=denied).status_code == 403
        target_ref = next(iter(body["mappings"]["connections"].values()))
        target_repo = target.app.state.repo
        connection = target_repo.get("connection_version", target_ref)
        connection["operations"][0]["path"] = "/different"
        target_repo.put("connection_version", target_ref, connection)
        assert target.post("/api/runtime/bindings", json=body).status_code == 409
        assert (
            target.post(f"/api/runtime/deployments/{deployment['id']}/revoke", json={"revision": 1}).status_code == 200
        )
        assert submit(target, deployment).status_code == 422
    bad = rewrite(data, lambda m, f: m["runtime_contract"]["required_capabilities"].append("node:arbitrary-code@1"))
    with pytest.raises(BusinessError):
        inspect_package(bad)
    bad = rewrite(data, lambda m, f: f.update({"docs/README.md": b"sk-this-is-a-private-secret-12345"}))
    with pytest.raises(BusinessError):
        inspect_package(bad)
    # Export must reject known saved credentials embedded in prompts, without modifying source.
    repo = client.app.state.repo
    release = repo.get("release", "customer-order-summary:1.0.0")
    release["workflow"]["nodes"][2]["config"]["system_prompt"] += " sk-abcdefghijklmnop"
    from backend.v2 import semantic_digest

    release["sha256"] = semantic_digest(release["workflow"])
    with pytest.raises(BusinessError):
        # Repository redaction intentionally does not conceal the invalid in-memory source.
        class Snapshot:
            def get(self, kind, key):
                return release if kind == "release" else repo.get(kind, key)

        export_release(Snapshot(), client.app.state.runtime.resources, "customer-order-summary", "1.0.0")


@pytest.mark.parametrize("name", ["../escape", "/absolute", "C:/escape", "x\\escape", "a/../b", "a//b"])
def test_archive_paths(name):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr(name, "unsafe")
    with pytest.raises(BusinessError):
        read_archive(stream.getvalue())


def test_archive_links_collisions_json_and_corruption(client):
    for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            info = tarfile.TarInfo("link")
            info.type, info.linkname = kind, "../escape"
            archive.addfile(info)
        with pytest.raises(BusinessError):
            read_archive(stream.getvalue())
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("manifest.json", "{}")
        archive.writestr("MANIFEST.json", "{}")
    with pytest.raises(BusinessError):
        read_archive(stream.getvalue())
    for data in (b'{"a":1,"a":2}', b'{"a":NaN}', b"[" * 50 + b"0" + b"]" * 50):
        with pytest.raises(BusinessError):
            json_read(data)
    _, data = exported(client)
    manifest, files = read_archive(data)
    files[WORKFLOW_PATH] += b" "
    with pytest.raises(BusinessError):
        write_archive(manifest, {k: v for k, v in files.items() if k != "manifest.json"})
    with pytest.raises(BusinessError):
        inspect_package(rewrite(data, lambda m, f: f.update({"unlisted.py": b"print('no')"})))


def test_headless_never_inherits_environment_or_seeds(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "source-only-secret")
    with TestClient(create_app(tmp_path)) as target:
        assert target.app.state.runtime.model_settings.current().mode == "demo"
        assert not target.app.state.runtime.model_settings.current().api_key.get_secret_value()
        assert target.app.state.repo.list("agent") == []
        assert target.get("/api/connections").json() == []
        assert target.get("/").status_code == 200
        assert target.get("/api/runtime/capabilities").json()["profile"] == capabilities()["profile"]
        with pytest.raises(RuntimeError):
            RuntimeLock(tmp_path)


def test_parallel_packages_rejection_revocation_and_source_independence(client, service, tmp_path):
    _, first = exported(client)
    _, second = exported(client, agent="order-integration-lab")
    # Closing/removing the source is not needed for target execution: only bytes travel.
    with TestClient(create_app(tmp_path / "target")) as target:
        one = import_package(target, first)
        d1, _, _ = bind_and_deploy(target, one, service[1])
        job = target.post("/api/runtime/import-jobs", content=second).json()
        two = target.post(f"/api/runtime/import-jobs/{job['id']}/commit", json={"trust_unsigned": True}).json()
        d2, _, _ = bind_and_deploy(target, two, service[1])
        # The second package uses POST + response-path extraction; the shared test
        # server intentionally has a different response, so its failure is isolated.
        r1, r2 = submit(target, d1).json(), submit(target, d2, key="second-package").json()
        pending = await_input(target, r1["id"])
        failed = wait_run(target, r2["id"])
        assert failed["status"] == "FAILED"
        assert confirm(target, pending, decision="reject").status_code == 200
        assert wait_run(target, r1["id"])["status"] == "CANCELLED"
        assert target.post(f"/api/runtime/deployments/{d1['id']}/activate", json={"revision": 1}).status_code == 422
        waiting = await_input(target, submit(target, d1, key="revoked-wait").json()["id"])
        assert target.post(f"/api/runtime/deployments/{d1['id']}/revoke", json={"revision": 1}).status_code == 200
        assert confirm(target, waiting).status_code == 200
        assert wait_run(target, waiting["id"])["status"] == "CANCELLED"
        assert target.app.state.repo.list("agent") == []
        assert not (target.app.state.repo.root / ".env").exists()


def test_import_idempotency_and_version_conflict(client, tmp_path):
    _, data = exported(client)
    with TestClient(create_app(tmp_path / "target")) as target:
        one = import_package(target, data)
        job = target.post("/api/runtime/import-jobs", content=data).json()
        two = target.post(f"/api/runtime/import-jobs/{job['id']}/commit", json={"trust_unsigned": True}).json()
        assert two["id"] == one["id"]
        assert len(target.get("/api/runtime/packages").json()) == 1
        changed = rewrite(data, lambda m, f: m.update(display_name="Changed artifact"))
        job = target.post("/api/runtime/import-jobs", content=changed).json()
        response = target.post(f"/api/runtime/import-jobs/{job['id']}/commit", json={"trust_unsigned": True})
        assert response.status_code == 409


def test_binding_policy_model_substitution_and_immutable_credentials(client, service, tmp_path):
    _, data = exported(client)
    with TestClient(create_app(tmp_path / "target")) as target:
        package = import_package(target, data)
        _, binding, body = bind_and_deploy(target, package, service[1])
        policy = copy.deepcopy(package["manifest"]["requested_policy"])
        policy["max_model_calls"] = 100
        assert target.post("/api/runtime/bindings", json={**body, "effective_policy": policy}).status_code == 403
        assert target.post("/api/runtime/bindings", json={**body, "effective_policy": {}}).status_code == 403
        default_ref = next(iter(body["mappings"]["models"].values()))
        repo = target.app.state.repo
        model = repo.get("model_profile_version", default_ref)
        original_key = target.app.state.runtime.resources.secret(model["credential_ref"])
        model["config"]["model"] = "different-model"
        repo.put("model_profile_version", default_ref, model)
        assert target.post("/api/runtime/bindings", json=body).status_code == 409
        response = target.post("/api/runtime/bindings", json={**body, "allow_model_substitution": True})
        assert response.status_code == 201 and response.json()["model_substitutions"]
        frozen = next(iter(binding["resolved_bindings"]["models"].values()))
        assert frozen["config"]["model"] != "different-model"
        assert frozen["credential_ref"] != "legacy-default"
        assert target.app.state.runtime.resources.secret(frozen["credential_ref"]) == original_key


def test_model_failure_is_not_silently_offline(client, service, tmp_path):
    _, data = exported(client)
    with TestClient(create_app(tmp_path / "target")) as target:
        package = import_package(target, data)
        deployment, _, body = bind_and_deploy(target, package, service[1])
        config = target.get("/api/settings/model").json()
        response = target.put(
            "/api/settings/model",
            json={
                "mode": "openai",
                "provider": "custom",
                "base_url": service[1] + "/v1",
                "model": "fixture-model",
                "api_key": "fixture-target-key",
                "timeout_seconds": 5,
                "max_tokens": 1800,
            },
        )
        assert response.status_code == 200, (config, response.text)
        body["mappings"]["models"] = {
            ref: target.get("/api/model-profiles").json()[0]["ref"] for ref in body["mappings"]["models"]
        }
        binding = target.post("/api/runtime/bindings", json={**body, "allow_model_substitution": True}).json()
        deployment = target.post(
            "/api/runtime/deployments", json={"binding_id": binding["id"], "name": "Online target"}
        ).json()
        service[0]["model_bad"] = True
        run = submit(target, deployment).json()
        failed = wait_run(target, run["id"])
        assert failed["status"] == "FAILED" and failed["model_mode"] == "openai"
        assert "fixture-target-key" not in str(target.get(f"/api/runtime/runs/{run['id']}/event-log").json())
        assert (
            target.post(f"/api/runtime/deployments/{deployment['id']}/activate", json={"revision": 1}).status_code
            == 422
        )


def test_two_portable_workflows_succeed_concurrently_with_bounded_pool(client, tmp_path, monkeypatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), OrdersHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    active = {"current": 0, "max": 0}
    lock = threading.Lock()
    original = Runtime.execute

    def measured(runtime, run_id):
        with lock:
            active["current"] += 1
            active["max"] = max(active["max"], active["current"])
        try:
            time.sleep(0.08)
            return original(runtime, run_id)
        finally:
            with lock:
                active["current"] -= 1

    monkeypatch.setattr(Runtime, "execute", measured)
    try:
        with TestClient(create_app(tmp_path / "target")) as target:
            deployments = []
            for agent in ("customer-order-summary", "order-integration-lab"):
                _, data = exported(client, agent=agent)
                job = target.post("/api/runtime/import-jobs", content=data).json()
                package = target.post(
                    f"/api/runtime/import-jobs/{job['id']}/commit", json={"trust_unsigned": True}
                ).json()
                deployment, _, _ = bind_and_deploy(target, package, f"http://127.0.0.1:{server.server_port}")
                deployments.append(deployment)
            ids = [submit(target, deployments[i % 2], key=f"parallel-{i}").json()["id"] for i in range(6)]
            paused = [await_input(target, run_id) for run_id in ids]
            assert 2 <= active["max"] <= 3
            assert len({r["checkpoint_thread_id"] for r in paused}) == 6
            for run in paused:
                assert confirm(target, run).status_code == 200
            for run_id in ids:
                assert wait_run(target, run_id)["status"] == "SUCCEEDED"
                assert wait_evaluation(target, run_id)["status"] == "PASSED"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
