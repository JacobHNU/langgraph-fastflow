import json
import os
import re
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field

from backend.model_settings import ModelConfig, require_model_key
from backend.repository import dump, uid
from backend.schemas import Assessment, BusinessError


class DemoChatModel(BaseChatModel):
    """Deterministic offline fixture; the surrounding agent/tool graph is real."""

    bound_tools: list[str] = Field(default_factory=list)

    @property
    def _llm_type(self):
        return "offline-demo-fixture"

    def bind_tools(self, tools, **kwargs):
        names = [t.get("function", t).get("name", "") if isinstance(t, dict) else getattr(t, "name", "") for t in tools]
        return self.model_copy(update={"bound_tools": names})

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        last_human = next((str(m.content) for m in reversed(messages) if m.type == "human"), "")
        try:
            bundle = json.loads(last_human)
            bundle = bundle if isinstance(bundle, dict) else {}
        except ValueError:
            bundle = {}
        if bundle.get("WORKFLOW_BUILDER_BUNDLE") is True:
            from backend.workflow_assistant import demo_proposal

            return ChatResult(
                generations=[ChatGeneration(message=AIMessage(content=dump(demo_proposal(json.loads(last_human)))))]
            )
        project_match = re.search(r"PRJ-\d{4}", last_human)
        project_id = project_match.group(0) if project_match else "PRJ-1001"
        last_human_idx = max((i for i, m in enumerate(messages) if m.type == "human"), default=0)
        tool_results = [
            m for m in messages[last_human_idx:] if isinstance(m, ToolMessage) and m.name == "query_project"
        ]
        if "query_project" in self.bound_tools and not tool_results:
            message = AIMessage(
                content="",
                tool_calls=[{"name": "query_project", "args": {"project_id": project_id}, "id": uid("call")}],
            )
        else:
            evidence = {}
            if tool_results:
                try:
                    evidence = json.loads(str(tool_results[-1].content))
                except ValueError:
                    pass
            if bundle.get("GENERIC_WORKFLOW_BUNDLE") is True:
                inputs = bundle["inputs"]
                material = inputs.get("data") if isinstance(inputs.get("data"), dict) else {}
                orders = inputs.get("orders", material.get("orders", []))
                counts = {
                    status: sum(o.get("status") == status for o in orders) for status in ("paid", "shipped", "pending")
                }
                content = {
                    "summary": f"离线演示摘要：客户 {inputs.get('customer_id', material.get('customer_id', ''))} 共 {len(orders)} 笔订单，已支付 {counts['paid']} 笔、已发货 {counts['shipped']} 笔、待支付 {counts['pending']} 笔。"
                }
            elif bundle.get("EVALUATION_BUNDLE") is True:
                content = Assessment(
                    assessment="SUPPORTED",
                    summary="离线规则演示：根据提供的证据索引整理检查结论，不代表真实模型评审。",
                    risk_level="low",
                    recommendations=["上线前使用真实模型复核，并替换测试软件适配器。"],
                ).model_dump()
            else:
                content = {
                    "project_id": project_id,
                    "summary": f"离线演示分析：{evidence.get('name', project_id)} 当前进度 {evidence.get('progress', '待查询')}%。",
                    "risk_level": "medium" if evidence.get("progress", 100) < 60 else "low",
                    "recommendations": ["核对关键里程碑的交付证据", "优先处理存在阻塞的任务"],
                    "source": "offline-demo-fixture",
                    "context_messages": len(messages),
                }
            message = AIMessage(content=dump(content))
        message.usage_metadata = {
            "input_tokens": sum(len(str(m.content)) for m in messages) // 3 + 1,
            "output_tokens": len(str(message.content)) // 3 + 1,
            "total_tokens": (sum(len(str(m.content)) for m in messages) + len(str(message.content))) // 3 + 2,
        }
        return ChatResult(generations=[ChatGeneration(message=message)])


def model_mode(config=None):
    return config.mode if config is not None else os.getenv("MODEL_MODE", "demo")


def get_model(config=None):
    config = config or ModelConfig.from_environment()
    mode = model_mode(config)
    if mode == "demo":
        return DemoChatModel()
    if mode == "unavailable":
        raise BusinessError("MODEL_UNAVAILABLE", "模型不可用（故障演示模式）")
    require_model_key(config)
    from langchain_openai import ChatOpenAI

    options = {"temperature": config.temperature} if config.temperature is not None else {}
    return ChatOpenAI(
        model=config.model,
        api_key=config.api_key.get_secret_value() or "local-no-key",
        base_url=config.base_url,
        timeout=config.timeout_seconds,
        max_retries=0,
        max_tokens=config.max_tokens,
        **options,
    )


def parse_json(content: Any) -> dict:
    if isinstance(content, list):
        content = "".join(c.get("text", "") for c in content if isinstance(c, dict))
    content = str(content).strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content)
    try:
        result = json.loads(content)
        if not isinstance(result, dict):
            raise TypeError("not an object")
        return result
    except (ValueError, TypeError) as exc:
        raise BusinessError("OUTPUT_INVALID", "模型未返回合法 JSON 对象") from exc
