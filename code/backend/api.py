import asyncio
import logging
import math
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.compiler import validate
from backend.executors.models import model_mode
from backend.registry import FUNCTIONS, NODE_TYPES, skills
from backend.repository import Repository, digest, dump, now, uid
from backend.runtime import TERMINAL, Runtime
from backend.schemas import BusinessError, CreateAgent, DraftRequest, RunRequest, Workflow
from backend.seeds import manifest, seed

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
logging.basicConfig(level=logging.INFO)


def create_app(data_dir=None):
    repo = Repository(data_dir)
    seed(repo)
    runtime = Runtime(repo)

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(runtime.worker())
        yield
        runtime.stopping = True
        await task
        await asyncio.to_thread(runtime.pool.shutdown, wait=True)
        repo.close()

    app = FastAPI(title="Workflow Studio", version="0.1.0", lifespan=lifespan)
    app.state.repo, app.state.runtime = repo, runtime
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:8000",
            "http://localhost:8000",
        ],
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["Content-Type", "Last-Event-ID"],
        allow_origin_regex=r"http://(?:127\.0\.0\.1|localhost):\d{1,5}",
    )

    @app.middleware("http")
    async def local_origin_boundary(request: Request, call_next):
        origin = request.headers.get("origin", "")
        if (
            request.method not in ("GET", "HEAD", "OPTIONS")
            and origin
            and not re.fullmatch(r"http://(?:127\.0\.0\.1|localhost):\d{1,5}", origin)
        ):
            return JSONResponse({"code": "POLICY_DENIED", "message": "仅接受本地 Demo 界面的操作请求"}, status_code=403)
        return await call_next(request)

    @app.exception_handler(BusinessError)
    async def business_error(request, exc):
        status = (
            403
            if exc.code == "POLICY_DENIED"
            else 409
            if "CONFLICT" in exc.code or exc.code in ("APPROVAL_STALE", "APPROVAL_REQUIRED")
            else 422
        )
        return JSONResponse({"code": exc.code, "message": exc.message}, status_code=status)

    @app.exception_handler(ValidationError)
    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return JSONResponse(
            {
                "code": "INPUT_INVALID",
                "message": "输入结构不符合约定",
                "errors": [{"loc": list(e["loc"]), "message": e["msg"]} for e in exc.errors()],
            },
            status_code=422,
        )

    def get(kind, key):
        value = repo.get(kind, key)
        if value is None:
            raise HTTPException(404, f"{kind} 不存在")
        return value

    def all_errors(wf, root_id=None, chain=None):
        errors = validate(wf)
        chain = (chain or []) + ([root_id] if root_id else [])
        for child in wf.child_agent_refs:
            key = f"{child['agent_id']}:{child['version']}"
            release = repo.get("release", key)
            if child["agent_id"] in chain or len(chain) >= 3:
                errors.append({"node_id": None, "message": "子 Agent 递归或调用深度超限"})
            elif not release or release.get("revoked"):
                errors.append({"node_id": None, "message": "子 Agent 发布版本不存在或已撤销"})
            else:
                child_wf = Workflow.model_validate(release["workflow"])
                if any(n.type == "approval" for n in child_wf.nodes):
                    errors.append({"node_id": None, "message": "当前 Demo 固定子调用仅支持无需审批的流程"})
                errors.extend(all_errors(child_wf, child["agent_id"], chain))
        return errors

    @app.get("/api/health")
    def health():
        return {
            "service": "workflow-studio",
            "status": "ok",
            "engine": "LangGraph",
            "model_mode": model_mode(),
            "identity": "local-demo-operator",
            "storage": "SQLite + SqliteSaver",
            "dependencies": manifest({"nodes": [], "skill_refs": []})["packages"],
        }

    @app.get("/api/node-types")
    def node_types():
        return {
            "nodes": NODE_TYPES,
            "functions": FUNCTIONS,
            "skills": skills(),
            "schemas": {"input": {"project_id": "PRJ-1001", "progress": 80, "task": "分析交付风险"}},
            "policy_limits": {"max_model_calls": 6, "max_tool_calls": 6, "max_depth": 2, "concurrency": 3},
        }

    @app.get("/api/projects")
    def projects():
        return repo.list("project")

    @app.get("/api/agents")
    def agents():
        return list(reversed(repo.list("agent")))

    @app.post("/api/agents", status_code=201)
    def create_agent(body: CreateAgent):
        agent_id = uid("agent")
        value = {
            "id": agent_id,
            "name": body.name,
            "description": "自定义业务流程",
            "category": "custom",
            "revision": 1,
            "workflow": body.workflow.model_dump(by_alias=True),
            "layout": body.layout,
            "latest_version": None,
            "created_at": now(),
            "updated_at": now(),
        }
        return repo.put("agent", agent_id, value)

    @app.get("/api/agents/{agent_id}")
    def agent_detail(agent_id: str):
        return get("agent", agent_id)

    @app.put("/api/agents/{agent_id}/draft")
    def save_draft(agent_id: str, body: DraftRequest):
        with repo.lock:
            agent = get("agent", agent_id)
            if body.revision != agent["revision"]:
                raise BusinessError("REVISION_CONFLICT", "草稿版本已变化，请重新载入后编辑")
            return repo.update(
                "agent",
                agent_id,
                workflow=body.workflow.model_dump(by_alias=True),
                layout=body.layout,
                name=body.name or agent["name"],
                revision=agent["revision"] + 1,
                updated_at=now(),
                simulated_digest=None,
            )

    @app.post("/api/agents/{agent_id}/validate")
    def validate_agent(agent_id: str):
        agent = get("agent", agent_id)
        errors = all_errors(Workflow.model_validate(agent["workflow"]), agent_id)
        return {"valid": not errors, "errors": errors, "revision": agent["revision"]}

    @app.post("/api/agents/{agent_id}/simulate")
    def simulate(agent_id: str):
        with repo.lock:
            agent = get("agent", agent_id)
            errors = all_errors(Workflow.model_validate(agent["workflow"]), agent_id)
            if errors:
                return {"valid": False, "errors": errors}
            # Static dry run: no model or software adapter is invoked.
            repo.update("agent", agent_id, simulated_digest=digest(agent["workflow"]))
            return {
                "valid": True,
                "errors": [],
                "mode": "static-no-side-effects",
                "nodes": len(agent["workflow"]["nodes"]),
                "write_operations": [
                    n
                    for n in agent["workflow"]["nodes"]
                    if FUNCTIONS.get(n["config"].get("function_ref"), {}).get("effect")
                    in ("idempotent_write", "non_idempotent_write")
                ],
                "tools": agent["workflow"]["policy"]["tools"],
                "dependency_manifest": manifest(agent["workflow"]),
            }

    class PublishRequest(BaseModel):
        revision: int
        confirmed: bool

    @app.post("/api/agents/{agent_id}/publish")
    def publish(agent_id: str, body: PublishRequest):
        with repo.transaction():
            agent = get("agent", agent_id)
            if body.revision != agent["revision"] or not body.confirmed:
                raise BusinessError("REVISION_CONFLICT", "发布必须确认当前草稿版本")
            errors = all_errors(Workflow.model_validate(agent["workflow"]), agent_id)
            if errors:
                raise BusinessError("DSL_INVALID", "; ".join(e["message"] for e in errors))
            if agent.get("simulated_digest") != digest(agent["workflow"]):
                raise BusinessError("SIMULATION_REQUIRED", "请先完成当前版本的无副作用预检")
            releases = [r for r in repo.list("release") if r["agent_id"] == agent_id]
            version = f"1.0.{len(releases)}"
            value = {
                "agent_id": agent_id,
                "name": agent["name"],
                "version": version,
                "workflow": agent["workflow"],
                "layout": agent["layout"],
                "sha256": digest(agent["workflow"]),
                "dependency_manifest": manifest(agent["workflow"]),
                "created_at": now(),
                "revoked": False,
            }
            repo.put("release", f"{agent_id}:{version}", value)
            repo.update("agent", agent_id, latest_version=version)
            return value

    @app.get("/api/agents/{agent_id}/versions")
    def versions(agent_id: str):
        get("agent", agent_id)
        return [r for r in repo.list("release") if r["agent_id"] == agent_id]

    @app.post("/api/agents/{agent_id}/versions/{version}/revoke")
    def revoke(agent_id: str, version: str):
        get("release", f"{agent_id}:{version}")
        return repo.update("release", f"{agent_id}:{version}", revoked=True)

    @app.post("/api/runs", status_code=202)
    def run(body: RunRequest):
        start = time.monotonic()
        result = runtime.create_run(body)
        elapsed = round((time.monotonic() - start) * 1000, 2)
        repo.update("run", result["id"], acceptance_ms=elapsed)
        return {
            "id": result["id"],
            "status": result["status"],
            "version": result["version"],
            "acceptance_ms": elapsed,
        }

    @app.get("/api/metrics")
    def metrics():
        runs = repo.list("run")

        def summarize(values):
            values = sorted(v for v in values if isinstance(v, (int, float)))
            return {
                "samples": len(values),
                "p50_ms": values[max(0, math.ceil(len(values) * 0.5) - 1)] if values else None,
                "p95_ms": values[max(0, math.ceil(len(values) * 0.95) - 1)] if values else None,
            }

        all_events = [event for run in runs for event in repo.events(run["id"])]
        return {
            "acceptance": summarize([r.get("acceptance_ms") for r in runs]),
            "run": summarize([r.get("duration_ms") for r in runs]),
            "node": summarize(
                [e["payload"].get("duration_ms") for e in all_events if e["event_type"] == "node.completed"]
            ),
            "software": summarize(
                [e["payload"].get("duration_ms") for e in all_events if e["event_type"] == "tool.completed"]
            ),
            "model": summarize(
                [e["payload"].get("duration_ms") for e in all_events if e["event_type"] == "model.completed"]
            ),
            "evaluation": summarize([r.get("duration_ms") for r in repo.list("evaluation")]),
            "environment": "local-demo",
            "model_mode": model_mode(),
        }

    @app.get("/api/runs")
    def runs():
        return [
            {k: v for k, v in run.items() if k not in ("workflow", "layout", "node_results", "skill_hashes")}
            for run in repo.list("run")
        ][:150]

    @app.get("/api/runs/{run_id}")
    def run_detail(run_id: str):
        run = get("run", run_id)
        run["approvals"] = [a for a in repo.list("approval") if a["run_id"] == run_id]
        run["operations"] = [o for o in repo.list("operation") if o["run_id"] == run_id]
        run["children"] = [
            {"id": r["id"], "status": r["status"], "agent_name": r["agent_name"]}
            for r in repo.list("run")
            if r.get("parent_run_id") == run_id
        ]
        run["usage"] = {
            "model_calls": sum(e["event_type"] == "model.called" for e in repo.events(run_id)),
            "tool_calls": sum(e["event_type"] == "tool.completed" for e in repo.events(run_id)),
        }
        return run

    @app.get("/api/runs/{run_id}/events")
    async def events(run_id: str, request: Request, after: int = 0, last_event_id: str | None = Header(default=None)):
        get("run", run_id)
        cursor = max(after, int(last_event_id) if last_event_id and last_event_id.isdigit() else 0)

        async def stream():
            nonlocal cursor
            while not await request.is_disconnected():
                for event in repo.events(run_id, cursor):
                    cursor = event["sequence"]
                    yield f"id: {cursor}\ndata: {dump(event)}\n\n"
                run = repo.get("run", run_id)
                if run["status"] in TERMINAL and run["evaluation_status"] not in ("PENDING", "RUNNING"):
                    yield "event: complete\ndata: {}\n\n"
                    break
                yield ": heartbeat\n\n"
                await asyncio.sleep(0.35)

        return StreamingResponse(
            stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
        )

    @app.get("/api/runs/{run_id}/event-log")
    def event_log(run_id: str, after: int = 0):
        get("run", run_id)
        return repo.events(run_id, after)

    class ApprovalDecision(BaseModel):
        decision: Literal["approve", "reject"]

    @app.post("/api/runs/{run_id}/approvals/{approval_id}")
    def decide(run_id: str, approval_id: str, body: ApprovalDecision):
        with repo.transaction():
            run = get("run", run_id)
            approval = get("approval", approval_id)
            if approval["run_id"] != run_id:
                raise BusinessError("POLICY_DENIED", "审批不属于此运行")
            expected = "APPROVED" if body.decision == "approve" else "REJECTED"
            if approval["status"] == expected:
                return approval
            if approval["status"] != "PENDING" or run["status"] != "AWAITING_APPROVAL":
                raise BusinessError("APPROVAL_CONFLICT", "审批已处理或运行未处于等待状态")
            project = get("project", approval["plan"]["project_id"])
            if approval["expires_at"] < time.time() or project["object_version"] != approval["plan"]["object_version"]:
                raise BusinessError("APPROVAL_STALE", "审批已过期或项目版本发生变化")
            value = repo.update(
                "approval", approval_id, status=expected, decided_at=now(), actor_ref="local-demo-operator"
            )
            repo.event(
                run_id,
                "approval.resolved",
                approval["node_id"],
                {"approval_id": approval_id, "decision": body.decision},
            )
            repo.update("run", run_id, status="QUEUED", resume={"decision": body.decision})
            return value

    @app.post("/api/runs/{run_id}/cancel")
    def cancel(run_id: str):
        with repo.lock:
            run = get("run", run_id)
            if run["status"] in TERMINAL:
                return run
            value = repo.update("run", run_id, cancel_requested=True)
            repo.event(run_id, "run.cancel_requested")
            if run["status"] in ("AWAITING_APPROVAL", "QUEUED"):
                runtime.finish(run_id, "CANCELLED")
                value = get("run", run_id)
            return value

    @app.post("/api/runs/{run_id}/reconcile")
    def reconcile(run_id: str):
        with repo.lock:
            run = get("run", run_id)
            if run["status"] != "NEEDS_RECONCILIATION":
                raise BusinessError("RECONCILIATION_CONFLICT", "运行不处于待对账状态")
            operations = [
                o for o in repo.list("operation") if o["run_id"] == run_id and o["status"] in ("UNKNOWN", "SENT")
            ]
            findings = []
            for operation in operations:
                actual = get("project", operation["plan"]["project_id"])
                matched = (
                    actual["progress"] == operation["plan"]["progress"]
                    and actual["object_version"] == operation["plan"]["object_version"] + 1
                )
                finding = {"operation_id": operation["id"], "matched": matched, "actual": actual}
                findings.append(finding)
                if matched:
                    repo.update("operation", operation["id"], status="CONFIRMED", result=actual, reconciled_at=now())
            evidence_id = repo.evidence(run_id, "reconciliation", findings)
            repo.event(
                run_id,
                "operation.reconciled",
                payload={
                    "findings": findings,
                    "note": "仅查询确认，未重新提交。原运行保持待对账，需人工核验后新建业务请求。",
                },
                evidence_refs=[evidence_id],
            )
            return {"findings": findings, "evidence_ref": evidence_id, "status": run["status"]}

    @app.get("/api/runs/{run_id}/evaluation")
    def evaluation(run_id: str):
        run = get("run", run_id)
        report = repo.get("evaluation", run_id) or {}
        return {**report, "status": run["evaluation_status"]}

    @app.post("/api/runs/{run_id}/evaluation/retry")
    def retry_evaluation(run_id: str):
        with repo.lock:
            run = get("run", run_id)
            if run["status"] not in TERMINAL or run["evaluation_status"] in ("PENDING", "RUNNING"):
                raise BusinessError("EVALUATION_CONFLICT", "运行未结束或评估正在进行")
            return repo.update("run", run_id, evaluation_status="PENDING")

    @app.get("/api/runs/{run_id}/evidence")
    def evidence_index(run_id: str):
        get("run", run_id)
        return [e for e in repo.list("evidence") if e["run_id"] == run_id]

    @app.get("/api/evidence/{evidence_id}")
    def evidence(evidence_id: str):
        return get("evidence", evidence_id)

    frontend = Path(__file__).resolve().parent.parent / "frontend" / "dist"
    if frontend.exists():
        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    return app
