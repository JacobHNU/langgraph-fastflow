import json
import os
import re
import tempfile
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from backend.model_settings import ModelConfig, ModelSettingsRequest, test_connection
from backend.repository import now, uid
from backend.schema_validation import check_schema
from backend.schemas import BusinessError


class ProfileRequest(ModelSettingsRequest):
    name: str = Field(min_length=1, max_length=80)
    revision: int | None = None


class OperationSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-z][a-z0-9_.-]{0,60}@1$")
    name: str = Field(min_length=1, max_length=80)
    method: Literal["GET"] = "GET"
    path: str = Field(min_length=1, max_length=500)
    input_schema: dict
    response_schema: dict
    effect: Literal["read_only"] = "read_only"


class ConnectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    revision: int | None = None
    base_url: str = Field(max_length=2048)
    bearer_token: SecretStr | None = Field(default=None, max_length=4096)
    clear_token: bool = False
    timeout_seconds: float = Field(default=10, ge=1, le=60, allow_inf_nan=False)
    operations: list[OperationSpec] = Field(min_length=1, max_length=20)


class ResourceService:
    def __init__(self, repo, legacy):
        self.repo, self.legacy = repo, legacy
        self.vault = repo.root / "credentials"
        self.vault.mkdir(exist_ok=True)
        self.refresh_default()
        self.seed_orders_connection()

    def secret(self, credential_ref):
        if credential_ref == "legacy-default":
            return self.legacy.current().api_key.get_secret_value()
        if not re.fullmatch(r"cred_[a-f0-9]{16}", credential_ref):
            raise BusinessError("CREDENTIAL_UNAVAILABLE", "凭据引用不可用")
        path = self.vault / (credential_ref + ".json")
        return json.loads(path.read_text(encoding="utf-8"))["value"] if path.exists() else ""

    def write_secret(self, ref, value):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.vault, delete=False) as stream:
                temporary = Path(stream.name)
                json.dump({"value": value}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.vault / (ref + ".json"))
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)

    def refresh_default(self):
        config = self.legacy.current().model_dump(mode="json", exclude={"api_key"})
        current = self.repo.get("model_profile", "model_default")
        if current and current["config"] == config:
            return current
        revision = current["revision"] + 1 if current else 1
        value = {
            "id": "model_default",
            "name": "工作空间默认模型",
            "revision": revision,
            "ref": f"model_default@{revision}",
            "config": config,
            "credential_ref": "legacy-default",
            "updated_at": now(),
            "workspace_id": "local",
        }
        with self.repo.transaction():
            self.repo.put("model_profile_version", value["ref"], value)
            return self.repo.put("model_profile", value["id"], value)

    def public(self, value):
        return {**value, "credential_configured": bool(self.secret(value["credential_ref"]))}

    def save_profile(self, body, profile_id=None):
        with self.repo.transaction():
            current = self.repo.get("model_profile", profile_id) if profile_id else None
            if profile_id and not current:
                raise HTTPException(404, "模型档案不存在")
            if profile_id == "model_default":
                raise BusinessError("POLICY_DENIED", "默认档案请通过原有模型设置修改")
            if current and body.revision != current["revision"]:
                raise BusinessError("REVISION_CONFLICT", "模型档案已变化，请重新加载")
            config = ModelConfig.model_validate(
                body.model_dump(exclude={"name", "revision", "clear_api_key", "api_key"})
            )
            key = body.api_key.get_secret_value() if body.api_key else ""
            ref = current["credential_ref"] if current else uid("cred")
            key = "" if body.clear_api_key else key or (self.secret(ref) if current else "")
            self.write_secret(ref, key)
            profile_id = profile_id or uid("model")
            revision = current["revision"] + 1 if current else 1
            value = {
                "id": profile_id,
                "name": body.name,
                "revision": revision,
                "ref": f"{profile_id}@{revision}",
                "config": config.model_dump(mode="json", exclude={"api_key"}),
                "credential_ref": ref,
                "updated_at": now(),
                "workspace_id": "local",
            }
            self.repo.put("model_profile_version", value["ref"], value)
            self.repo.put("model_profile", profile_id, value)
            return self.public(value)

    def save_connection(self, body, connection_id=None, new_id=None):
        # Only registered GET operations are exposed in this first delivery.
        url = ModelConfig(base_url=body.base_url).base_url
        parsed = urlsplit(url)
        if not parsed.hostname or parsed.hostname in ("169.254.169.254", "metadata.google.internal"):
            raise BusinessError("POLICY_DENIED", "不允许访问元数据服务")
        names = [op.id for op in body.operations]
        if len(set(names)) != len(names):
            raise BusinessError("INPUT_INVALID", "操作 ID 重复")
        for op in body.operations:
            if not re.fullmatch(r"/(?:[a-zA-Z0-9_./-]|\{[a-zA-Z][a-zA-Z0-9_]*\})*", op.path) or ".." in op.path:
                raise BusinessError("INPUT_INVALID", "操作路径只允许相对路径和字段占位符")
            if op.path.startswith("//"):
                raise BusinessError("INPUT_INVALID", "操作不能更改目标主机")
            check_schema(op.input_schema)
            check_schema(op.response_schema)
            fields = set(re.findall(r"\{([a-zA-Z][a-zA-Z0-9_]*)\}", op.path))
            if fields != set(op.input_schema.get("properties", {})) or op.input_schema.get("type") != "object":
                raise BusinessError("INPUT_INVALID", "操作参数必须与路径占位符一致")
            if fields - set(op.input_schema.get("required", [])):
                raise BusinessError("INPUT_INVALID", "路径参数必须为必填字段")
        with self.repo.transaction():
            current = self.repo.get("connection", connection_id) if connection_id else None
            if connection_id and not current:
                raise HTTPException(404, "连接不存在")
            if current and current["revision"] != body.revision:
                raise BusinessError("REVISION_CONFLICT", "连接已变化，请重新加载")
            ref = current["credential_ref"] if current else uid("cred")
            key = body.bearer_token.get_secret_value() if body.bearer_token else ""
            self.write_secret(ref, "" if body.clear_token else key or (self.secret(ref) if current else ""))
            connection_id = connection_id or new_id or uid("conn")
            revision = current["revision"] + 1 if current else 1
            value = {
                "id": connection_id,
                "ref": f"{connection_id}@{revision}",
                "revision": revision,
                "name": body.name,
                "kind": "http",
                "base_url": url,
                "credential_ref": ref,
                "timeout_seconds": body.timeout_seconds,
                "operations": [op.model_dump() for op in body.operations],
                "updated_at": now(),
                "workspace_id": "local",
            }
            self.repo.put("connection_version", value["ref"], value)
            self.repo.put("connection", connection_id, value)
            return self.public(value)

    def seed_orders_connection(self):
        if self.repo.get("connection", "conn_orders"):
            return
        example = json.loads(
            (Path(__file__).resolve().parent.parent / "docs/design/order-summary-v2.json").read_text(encoding="utf-8")
        )
        http_node = next(node for node in example["nodes"] if node["type"] == "http")
        request = ConnectionRequest(
            name="本地订单示例服务",
            base_url=os.getenv("WORKFLOW_DEMO_ORDERS_URL", "http://127.0.0.1:18765"),
            operations=[
                OperationSpec(
                    id="orders.list@1",
                    name="查询客户订单",
                    path="/customers/{customer_id}/orders",
                    input_schema=example["input_schema"],
                    response_schema=http_node["output_schema"],
                )
            ],
        )
        self.save_connection(request, new_id="conn_orders")

    def bindings(self, workflow):
        refs = workflow.dependency_refs
        result = {"models": {}, "connections": {}, "validators": {}, "tools": refs.get("tools", [])}
        for group, kind in (("models", "model_profile_version"), ("connections", "connection_version")):
            for ref in refs.get(group, []):
                value = self.repo.get(kind, ref)
                if not value:
                    raise BusinessError("CAPABILITY_UNAVAILABLE", f"未注册的依赖：{ref}")
                result[group][ref] = value
        for ref in refs.get("validators", []):
            if ref not in ("order-summary@1", "schema@1"):
                raise BusinessError("CAPABILITY_UNAVAILABLE", f"核验器不可用：{ref}")
            result["validators"][ref] = {"ref": ref, "version": "1"}
        return result

    def model_config(self, binding, timeout_ms=None):
        config = ModelConfig.model_validate({**binding["config"], "api_key": self.secret(binding["credential_ref"])})
        if timeout_ms:
            config = config.model_copy(update={"timeout_seconds": min(config.timeout_seconds, timeout_ms / 1000)})
        return config


def register_resources(app, resources):
    @app.get("/api/model-profiles")
    def profiles():
        resources.refresh_default()
        return [resources.public(p) for p in resources.repo.list("model_profile")]

    @app.post("/api/model-profiles", status_code=201)
    def add_profile(body: ProfileRequest):
        return resources.save_profile(body)

    @app.put("/api/model-profiles/{profile_id}")
    def edit_profile(profile_id: str, body: ProfileRequest):
        return resources.save_profile(body, profile_id)

    @app.get("/api/model-profiles/{profile_id}/versions")
    def profile_versions(profile_id: str):
        return [resources.public(p) for p in resources.repo.list("model_profile_version") if p["id"] == profile_id]

    @app.post("/api/model-profiles/{profile_id}/test")
    def probe_profile(profile_id: str):
        profile = resources.repo.get("model_profile", profile_id)
        if not profile:
            raise HTTPException(404, "模型档案不存在")
        return test_connection(resources.model_config(profile))

    @app.get("/api/connections")
    def connections():
        return [resources.public(c) for c in resources.repo.list("connection")]

    @app.post("/api/connections", status_code=201)
    def add_connection(body: ConnectionRequest):
        return resources.save_connection(body)

    @app.put("/api/connections/{connection_id}")
    def edit_connection(connection_id: str, body: ConnectionRequest):
        return resources.save_connection(body, connection_id)

    @app.get("/api/connections/{connection_id}/versions")
    def connection_versions(connection_id: str):
        return [resources.public(c) for c in resources.repo.list("connection_version") if c["id"] == connection_id]
