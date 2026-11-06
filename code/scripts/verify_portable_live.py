"""Opt-in cross-process verification; never print or include credentials in exports."""

import argparse
import copy
import getpass
import json
import time
from pathlib import Path
from uuid import uuid4

import httpx

from backend.model_settings import ModelSettingsStore


def checked(response):
    if not response.is_success:
        raise RuntimeError(f"API verification failed: HTTP {response.status_code}, {response.request.url.path}")
    return response.json()


def login(client, username, password):
    session = checked(client.post("/api/auth/login", json={"username": username, "password": password}))
    client.headers["X-CSRF-Token"] = session["csrf_token"]


def wait(target, run_id, condition, timeout=240):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        run = checked(target.get(f"/api/runtime/runs/{run_id}"))
        if condition(run):
            return run
        if run["status"] in ("FAILED", "CANCELLED"):
            raise RuntimeError(f"Run failed: {run_id}, {run.get('error', {}).get('code')}")
        time.sleep(0.5)
    raise RuntimeError(f"Timed out: {run_id}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="http://127.0.0.1:8005")
    parser.add_argument("--target", default="http://127.0.0.1:8010")
    parser.add_argument("--source-data", required=True)
    parser.add_argument("--username", default="e2eadmin")
    parser.add_argument("--orders-url", default="http://127.0.0.1:18765")
    args = parser.parse_args()
    password = getpass.getpass("Verification account password: ")
    config = ModelSettingsStore(Path(args.source_data), allow_environment=False).current()
    if config.mode != "openai" or not config.api_key.get_secret_value():
        raise RuntimeError("The isolated source verification account must already have a saved live model")
    with (
        httpx.Client(base_url=args.source, timeout=60) as source,
        httpx.Client(base_url=args.target, timeout=60) as target,
    ):
        login(source, args.username, password)
        login(target, args.username, password)
        default = next(p for p in checked(source.get("/api/model-profiles")) if p["id"] == "model_default")
        original = checked(source.get("/api/agents/order-integration-lab"))
        workflow = copy.deepcopy(original["workflow"])
        workflow["dependency_refs"]["models"] = [default["ref"]]
        for node in workflow["nodes"]:
            if node["type"] in ("llm", "agent"):
                node["config"]["model_ref"] = default["ref"]
        agent = checked(
            source.post(
                "/api/agents",
                json={"name": "可移植七节点真实模型验收", "workflow": workflow, "layout": original["layout"]},
            )
        )
        preview = checked(source.post(f"/api/agents/{agent['id']}/simulate"))
        if not preview["valid"]:
            raise RuntimeError("Source static validation failed")
        release = checked(
            source.post(f"/api/agents/{agent['id']}/publish", json={"revision": agent["revision"], "confirmed": True})
        )
        job = checked(
            source.post(
                f"/api/agents/{agent['id']}/versions/{release['version']}/export-jobs", json={"container": "tar.gz"}
            )
        )
        archive = source.get(f"/api/export-jobs/{job['id']}/download")
        archive.raise_for_status()
        output = Path("dist")
        output.mkdir(exist_ok=True)
        (output / "order-integration-lab-live.tar.gz").write_bytes(archive.content)
        staged = checked(target.post("/api/runtime/import-jobs", content=archive.content))
        package = checked(target.post(f"/api/runtime/import-jobs/{staged['id']}/commit", json={"trust_unsigned": True}))
        body = config.model_dump(mode="json", exclude={"api_key"})
        body.update(name="独立 Runtime 真实模型", api_key=config.api_key.get_secret_value(), timeout_seconds=120)
        model = checked(target.post("/api/model-profiles", json=body))
        mappings = {"models": {m["ref"]: model["ref"] for m in package["resources"]["models"]}, "connections": {}}
        for resource in package["resources"]["connections"]:
            connection = checked(
                target.post(
                    "/api/connections",
                    json={
                        "name": "独立 Runtime 只读查询",
                        "base_url": args.orders_url,
                        "auth_type": "none",
                        "operations": resource["operations"],
                    },
                )
            )
            mappings["connections"][resource["ref"]] = connection["ref"]
        binding = checked(
            target.post(
                "/api/runtime/bindings",
                json={"package_key": package["id"], "mappings": mappings, "authorize_credentials": True},
            )
        )
        deployment = checked(
            target.post("/api/runtime/deployments", json={"binding_id": binding["id"], "name": "七节点 Qwen 独立部署"})
        )
        run = checked(
            target.post(
                f"/api/runtime/deployments/{deployment['id']}/test-runs",
                json={"inputs": {"customer_id": "CUST-1001"}, "idempotency_key": str(uuid4())},
            )
        )
        paused = wait(target, run["id"], lambda r: r["status"] == "AWAITING_INPUT")
        request = next(p for p in paused["input_requests"] if p["status"] == "PENDING")
        checked(
            target.post(
                f"/api/runtime/runs/{run['id']}/inputs/{request['id']}",
                json={
                    "revision": request["revision"],
                    "decision": "accept",
                    "payload": {"feedback": "已核对真实模型摘要与目标查询结果"},
                    "idempotency_key": str(uuid4()),
                },
            )
        )
        completed = wait(
            target,
            run["id"],
            lambda r: r["status"] == "SUCCEEDED" and r["evaluation_status"] not in ("PENDING", "RUNNING"),
        )
        if completed["evaluation_status"] != "PASSED" or completed["model_mode"] != "openai":
            raise RuntimeError("Live target evaluation did not pass")
        checked(target.post(f"/api/runtime/deployments/{deployment['id']}/activate", json={"revision": 1}))
        summary = {
            "run_id": run["id"],
            "deployment_id": deployment["id"],
            "status": completed["status"],
            "evaluation": completed["evaluation_status"],
            "model": config.model,
            "usage": completed["usage"],
            "package_digest": completed["package_digest"],
            "binding_digest": completed["binding_digest"],
            "node_count": len(completed["node_results"]),
            "runtime_url": args.target,
            "source_agent": agent["id"],
            "source_version": release["version"],
        }
        (output / "m12-live-verification.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
