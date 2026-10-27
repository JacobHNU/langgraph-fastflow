import time
from urllib.parse import quote

import httpx

from backend.repository import now, uid
from backend.schema_validation import validate_data
from backend.schemas import BusinessError


class InvocationGateway:
    def __init__(self, repo, resources):
        self.repo, self.resources = repo, resources

    def call(self, capability_ref, arguments, context, connection_ref=None):
        repo = self.repo
        run_id, node_id = context["run_id"], context["node_id"]
        if repo.get("run", run_id).get("cancel_requested"):
            raise BusinessError("CANCELLED", "已在 HTTP 调用边界确认取消")
        if capability_ref not in context["policy"].get("capability_refs", []):
            raise BusinessError("POLICY_DENIED", "HTTP 操作未获得流程授权")
        candidates = [
            (connection, operation)
            for ref, connection in context["resolved_bindings"]["connections"].items()
            if not connection_ref or ref == connection_ref
            for operation in connection["operations"]
            if operation["id"] == capability_ref
        ]
        if len(candidates) != 1:
            raise BusinessError("REFERENCE_INVALID", "操作与连接绑定不唯一或不存在")
        connection, operation = candidates[0]
        if operation["effect"] != "read_only" or operation["method"] != "GET":
            raise BusinessError("POLICY_DENIED", "当前 HTTP 适配器仅允许已登记只读操作")
        scopes = context["policy"].get("resource_scopes", [])
        if "http:registered" not in scopes and not (capability_ref == "orders.list@1" and "orders:customer" in scopes):
            raise BusinessError("POLICY_DENIED", "HTTP 操作缺少对应资源作用域")
        validate_data(operation["input_schema"], arguments)
        calls = [e for e in repo.events(run_id) if e["event_type"] == "tool.requested"]
        if (
            sum(e["node_id"] == node_id for e in calls) >= context["policy"].get("max_tool_calls", 6)
            or len(calls) >= 24
        ):
            raise BusinessError("BUDGET_EXCEEDED", "HTTP/工具调用预算耗尽")
        timeout = min(connection["timeout_seconds"], context["timeout_ms"] / 1000)
        remaining = context.get("deadline", time.monotonic() + timeout) - time.monotonic()
        if remaining <= 0:
            raise BusinessError("BUDGET_EXCEEDED", "运行活动时间预算耗尽")
        timeout = min(timeout, remaining)
        path = operation["path"].format(**{key: quote(str(value), safe="") for key, value in arguments.items()})
        token = self.resources.secret(connection["credential_ref"])
        invocation_id = uid("invocation")
        record = {
            "id": invocation_id,
            "run_id": run_id,
            "node_id": node_id,
            "node_path": node_id,
            "capability_ref": capability_ref,
            "connection_ref": connection["ref"],
            "status": "STARTED",
            "created_at": now(),
            "arguments": arguments,
        }
        repo.put("invocation", invocation_id, record)
        repo.event(
            run_id,
            "tool.requested",
            node_id,
            {"tool": capability_ref, "invocation_id": invocation_id, "arguments": arguments},
        )
        started = time.monotonic()
        try:
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            # No environment proxy, redirects, retries or model-selected hosts.
            with httpx.Client(timeout=timeout, follow_redirects=False, trust_env=False) as client:  # noqa: SIM117
                with client.stream("GET", connection["base_url"] + path, headers=headers) as response:
                    if not 200 <= response.status_code < 300:
                        raise BusinessError("CONNECTOR_HTTP_ERROR", f"HTTP 查询返回状态 {response.status_code}")
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        if time.monotonic() - started > timeout:
                            raise BusinessError("CONNECTOR_TIMEOUT", "HTTP 查询超过调用时限")
                        size += len(chunk)
                        if size > 120000:
                            raise BusinessError("OUTPUT_INVALID", "HTTP 响应超过 120KB 上限")
                        chunks.append(chunk)
                    import json

                    try:
                        data = json.loads(b"".join(chunks))
                    except (ValueError, UnicodeError):
                        raise BusinessError("OUTPUT_INVALID", "HTTP 查询未返回合法 JSON") from None
                    result = {
                        "ok": True,
                        "status": response.status_code,
                        "data": data,
                        "meta": {"invocation_id": invocation_id},
                    }
            validate_data(operation["response_schema"], result, "OUTPUT_INVALID")
            # Remove the credential even if a remote service echoes it into data.
            if token:
                from backend.repository import dump

                result = json.loads(dump(result).replace(token, "[REDACTED]"))
            ref = repo.evidence(run_id, node_id, result)
            repo.update("invocation", invocation_id, status="SUCCEEDED", finished_at=now(), evidence_ref=ref)
            repo.event(
                run_id,
                "tool.completed",
                node_id,
                {
                    "tool": capability_ref,
                    "invocation_id": invocation_id,
                    "duration_ms": round((time.monotonic() - started) * 1000, 2),
                },
                evidence_refs=[ref],
            )
            return result
        except Exception as exc:  # noqa: BLE001 - never persist transport errors containing credentials
            if isinstance(exc, BusinessError):
                error = exc
            elif isinstance(exc, httpx.TimeoutException):
                error = BusinessError("CONNECTOR_TIMEOUT", "HTTP 查询超时")
            else:
                error = BusinessError("CONNECTOR_UNAVAILABLE", "无法连接已配置的 HTTP 服务")
            repo.update(
                "invocation",
                invocation_id,
                status="FAILED",
                finished_at=now(),
                error={"code": error.code, "message": error.message},
            )
            repo.event(
                run_id,
                "tool.failed",
                node_id,
                {"invocation_id": invocation_id, "code": error.code, "message": error.message},
            )
            raise error from None
