import time

from backend.registry import FUNCTIONS
from backend.repository import Repository, digest, now
from backend.schemas import BusinessError


class BusinessTools:
    """The same authorization and operation boundary serves Python and model tools."""

    def __init__(self, repo: Repository):
        self.repo = repo

    def call(self, function_ref: str, args: dict, context: dict):
        started = time.monotonic()
        repo = self.repo
        run_id, node_id = context["run_id"], context["node_id"]
        if sum(e["event_type"] == "tool.requested" for e in repo.events(run_id)) >= 60:
            raise BusinessError("BUDGET_EXCEEDED", "本次运行工具调用总预算耗尽")
        repo.event(run_id, "tool.requested", node_id, {"function_ref": function_ref, "inputs": args})
        try:
            if function_ref not in context["policy"].get("tools", []) or function_ref not in FUNCTIONS:
                raise BusinessError("POLICY_DENIED", "工具未被当前运行授权")
            project_id = args.get("project_id") or args.get("plan", {}).get("project_id")
            if project_id not in context["policy"].get("objects", []) or project_id not in ("PRJ-1001", "PRJ-1002"):
                raise BusinessError("POLICY_DENIED", "没有当前项目的对象级权限")
            project = repo.get("project", project_id)
            if not project:
                raise BusinessError("INPUT_INVALID", "项目不存在")
            if function_ref == "project.query_status@1":
                result = project
            elif function_ref == "project.snapshot@1":
                repo.event(run_id, "workflow.step", node_id, {"step_id": "load-project", "message": "读取项目基本信息"})
                result = {**project, "delivery_health": "on_track" if project["progress"] >= 60 else "at_risk"}
                repo.event(
                    run_id, "workflow.step", node_id, {"step_id": "check-milestones", "message": "核对里程碑和交付风险"}
                )
            elif function_ref == "project.prepare_update@1":
                progress = args.get("progress")
                if not isinstance(progress, int) or isinstance(progress, bool) or not 0 <= progress <= 100:
                    raise BusinessError("INPUT_INVALID", "进度必须是 0 到 100 之间的整数")
                result = {
                    "project_id": project_id,
                    "progress": progress,
                    "object_version": project["object_version"],
                    "previous_progress": project["progress"],
                }
            elif function_ref == "project.update_progress@1":
                result = self._commit(args["plan"], context)
            else:
                raise BusinessError("POLICY_DENIED", "未知工具")
            evidence = repo.evidence(run_id, node_id, {"function_ref": function_ref, "inputs": args, "result": result})
            repo.event(
                run_id,
                "tool.completed",
                node_id,
                {
                    "function_ref": function_ref,
                    "result": result,
                    "duration_ms": round((time.monotonic() - started) * 1000, 2),
                },
                evidence_refs=[evidence],
            )
            return result
        except BusinessError as exc:
            repo.event(
                run_id,
                "tool.denied" if exc.code in ("POLICY_DENIED", "APPROVAL_STALE") else "tool.failed",
                node_id,
                {"code": exc.code, "message": exc.message},
            )
            raise

    def _commit(self, plan: dict, context: dict):
        repo = self.repo
        run_id, node_id = context["run_id"], context["node_id"]
        operation_id = "op_" + digest({"run": run_id, "node": node_id, "plan": plan})[:24]
        with repo.lock:
            existing = repo.get("operation", operation_id)
            if existing:
                if existing["status"] == "CONFIRMED":
                    return existing["result"]
                raise BusinessError("OPERATION_UNKNOWN", "已发送的操作结果未确认，请对账，禁止重复提交")
            approvals = [
                a
                for a in repo.list("approval")
                if a["run_id"] == run_id and a["status"] == "APPROVED" and a["plan_digest"] == digest(plan)
            ]
            if not approvals:
                raise BusinessError("APPROVAL_REQUIRED", "该操作方案未获批准")
            if approvals[0]["expires_at"] < time.time():
                raise BusinessError("APPROVAL_STALE", "审批已过期")
            current = repo.get("project", plan["project_id"])
            if current["object_version"] != plan["object_version"]:
                raise BusinessError("APPROVAL_STALE", "项目版本已变化，请重新生成方案并审批")
            repo.put(
                "operation",
                operation_id,
                {
                    "id": operation_id,
                    "run_id": run_id,
                    "node_id": node_id,
                    "status": "SENT",
                    "plan": plan,
                    "sent_at": now(),
                    "cancellable": False,
                },
            )
            updated = {**current, "progress": plan["progress"], "object_version": current["object_version"] + 1}
            repo.put("project", plan["project_id"], updated)
            if context.get("simulate_unknown"):
                repo.update("operation", operation_id, status="UNKNOWN")
                raise BusinessError("OPERATION_UNKNOWN", "演示故障：测试数据已更新，但提交响应丢失，需要读回对账")
            readback = repo.get("project", plan["project_id"])
            result = {
                **readback,
                "operation_id": operation_id,
                "readback_verified": readback["progress"] == plan["progress"],
            }
            repo.update("operation", operation_id, status="CONFIRMED", result=result, confirmed_at=now())
            repo.event(run_id, "operation.confirmed", node_id, {"result": result}, operation_id=operation_id)
            return result
