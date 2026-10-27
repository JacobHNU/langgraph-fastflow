import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from backend.repository import now
from backend.schemas import BusinessError


class ModelConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["demo", "openai", "unavailable"] = "demo"
    provider: str = Field(default="openai", max_length=40)
    base_url: str = Field(default="https://api.openai.com/v1", max_length=2048)
    model: str = Field(default="gpt-4.1-mini", min_length=1, max_length=200)
    api_key: SecretStr = Field(default_factory=lambda: SecretStr(""), max_length=4096)
    requires_api_key: bool = True
    timeout_seconds: float = Field(default=35, ge=1, le=300, allow_inf_nan=False)
    max_tokens: int = Field(default=1800, ge=1, le=128000)
    temperature: float | None = Field(default=None, ge=0, le=2, allow_inf_nan=False)

    @field_validator("base_url")
    @classmethod
    def validate_url(cls, value):
        value = value.strip().rstrip("/")
        parsed = urlsplit(value)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Base URL 必须是无凭据和查询参数的 HTTP(S) 地址")
        try:
            _ = parsed.port
        except ValueError as exc:
            raise ValueError("Base URL 端口不合法") from exc
        return value

    @field_validator("model")
    @classmethod
    def validate_model(cls, value):
        if not value.strip():
            raise ValueError("请输入模型名称")
        return value.strip()

    @classmethod
    def from_environment(cls):
        base_url = os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"
        provider = {
            "api.openai.com": "openai",
            "api.deepseek.com": "deepseek",
            "dashscope.aliyuncs.com": "aliyun",
            "api.siliconflow.cn": "siliconflow",
        }.get(urlsplit(base_url).hostname, "custom")
        return cls(
            mode=os.getenv("MODEL_MODE", "demo"),
            provider=provider,
            base_url=base_url,
            model=os.getenv("OPENAI_MODEL") or "gpt-4.1-mini",
            api_key=os.getenv("OPENAI_API_KEY") or "",
        )


class ModelSettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["demo", "openai", "unavailable"]
    provider: str = Field(default="openai", max_length=40)
    base_url: str
    model: str
    api_key: SecretStr | None = Field(default=None, max_length=4096)
    clear_api_key: bool = False
    requires_api_key: bool = True
    timeout_seconds: float = 35
    max_tokens: int = 1800
    temperature: float | None = None


class ModelSettingsStore:
    """Credentials stay in the local data directory, outside workflow/audit records."""

    def __init__(self, root: Path):
        self.path = root / "model-settings.json"
        self.lock = threading.RLock()

    def current(self) -> ModelConfig:
        with self.lock:
            if self.path.exists():
                return ModelConfig.model_validate(json.loads(self.path.read_text(encoding="utf-8"))["config"])
            return ModelConfig.from_environment()

    def public(self, config=None):
        with self.lock:
            config = config or self.current()
            updated_at = (
                json.loads(self.path.read_text(encoding="utf-8")).get("updated_at") if self.path.exists() else None
            )
            return {
                **config.model_dump(mode="json", exclude={"api_key"}),
                "api_key_configured": bool(config.api_key.get_secret_value()),
                "source": "settings" if self.path.exists() else "environment",
                "updated_at": updated_at,
            }

    def candidate(self, request: ModelSettingsRequest) -> ModelConfig:
        current = self.current()
        values = request.model_dump(exclude={"api_key", "clear_api_key"})
        # An empty password field keeps the saved key; deletion is always explicit.
        key = request.api_key.get_secret_value().strip() if request.api_key else ""
        values["api_key"] = "" if request.clear_api_key else key or current.api_key.get_secret_value()
        return ModelConfig.model_validate(values)

    def save(self, request: ModelSettingsRequest):
        with self.lock:
            config = self.candidate(request)
            values = config.model_dump(mode="json", exclude={"api_key"})
            values["api_key"] = config.api_key.get_secret_value()
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, delete=False) as f:
                    temporary = Path(f.name)
                    json.dump({"config": values, "updated_at": now()}, f, ensure_ascii=False)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(temporary, self.path)
            finally:
                if temporary:
                    temporary.unlink(missing_ok=True)
            return self.public(config)


def require_model_key(config):
    if config.requires_api_key and not config.api_key.get_secret_value():
        raise BusinessError("MODEL_UNAVAILABLE", "请在工作空间设置中填写 API Key，或选择无需密钥的服务")


def connection_error(exc):
    status = getattr(exc, "status_code", None)
    if status is None and getattr(exc, "response", None) is not None:
        status = exc.response.status_code
    if status in (401, 403):
        message = "认证失败，请检查 API Key 和模型访问权限"
    elif status == 404:
        message = "接口或模型不存在，请检查 Base URL 和模型名称"
    elif status == 429:
        message = "请求受限，请检查配额或稍后重试"
    elif "timeout" in type(exc).__name__.lower():
        message = "连接超时，请检查服务地址或请求超时设置"
    else:
        message = "无法连接模型服务，请检查地址、网络和模型配置"
    # Provider error text may contain credentials or request content.
    return BusinessError("MODEL_CONNECTION_FAILED", message)


def test_connection(config):
    from langchain_core.messages import HumanMessage

    from backend.executors.models import get_model

    started = time.monotonic()
    try:
        probe = config.model_copy(update={"timeout_seconds": min(config.timeout_seconds, 15), "max_tokens": 32})
        get_model(probe).invoke([HumanMessage(content="Reply with OK.")])
    except BusinessError:
        raise
    except Exception as exc:  # noqa: BLE001 - provider errors must never expose credentials
        raise connection_error(exc) from None
    return {
        "success": True,
        "mode": config.mode,
        "model": config.model,
        "latency_ms": round((time.monotonic() - started) * 1000),
        "message": "离线演示模型可用" if config.mode == "demo" else "模型连接成功",
    }


def list_models(config):
    require_model_key(config)
    try:
        headers = (
            {"Authorization": f"Bearer {config.api_key.get_secret_value()}"}
            if config.api_key.get_secret_value()
            else {}
        )
        with httpx.Client(timeout=min(config.timeout_seconds, 15), follow_redirects=False) as client:
            response = client.get(config.base_url + "/models", headers=headers)
            response.raise_for_status()
            payload = response.json()
        models = sorted({m["id"] for m in payload["data"] if isinstance(m.get("id"), str) and len(m["id"]) <= 200})
        return {"models": models[:500]}
    except Exception as exc:  # noqa: BLE001 - provider errors must never expose credentials
        raise connection_error(exc) from None
