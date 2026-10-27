import json
from pathlib import Path
from typing import Any, Literal

import rfc8785
from jinja2 import StrictUndefined, TemplateError, meta, nodes
from jinja2.sandbox import SandboxedEnvironment
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from backend.schema_validation import check_schema, validate_data
from backend.schemas import BusinessError


class V2Policy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    capability_refs: list[str] = Field(default_factory=list, max_length=20)
    resource_scopes: list[Literal["orders:customer", "http:registered"]] = Field(default_factory=list)
    max_model_calls: int = Field(default=6, ge=1, le=6)
    max_tool_calls: int = Field(default=6, ge=1, le=6)
    active_timeout_ms: int = Field(default=120000, ge=1000, le=900000)


class ModelNodeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    executor: Literal["direct_model", "langchain_agent", "deep_agent"] = "direct_model"
    model_ref: str
    system_prompt: str = Field(min_length=1, max_length=16000)
    user_prompt_template: str = Field(max_length=16000)
    tools: list[str] = Field(default_factory=list, max_length=20)
    skills: list[str] = Field(default_factory=list)


class HttpNodeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_ref: str
    operation_ref: str
    on_error: Literal["fail"] = "fail"


class HumanNodeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["review"] = "review"
    reject_behavior: Literal["cancel"] = "cancel"
    form_schema: dict = Field(default_factory=lambda: {"type": "object", "properties": {}})
    wait_ttl_seconds: int = Field(default=86400, ge=60, le=604800)


class VerifyNodeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    validator_ref: Literal["order-summary@1", "schema@1"]
    value_schema: dict | None = Field(default=None, alias="schema")
    on_failure: Literal["fail"] = "fail"


class ConditionNodeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operator: Literal["eq", "neq", "gt", "gte", "lt", "lte", "contains"] = "gte"
    compare_to: Any = 60


CONFIG_MODELS = {
    "llm": ModelNodeConfig,
    "agent": ModelNodeConfig,
    "http": HttpNodeConfig,
    "human_input": HumanNodeConfig,
    "verify": VerifyNodeConfig,
    "condition": ConditionNodeConfig,
}


def semantic_digest(workflow):
    import hashlib

    definition = json.loads(json.dumps(workflow))
    for node in definition["nodes"]:
        node.pop("title", None)
    return hashlib.sha256(rfc8785.dumps(definition)).hexdigest()


def template_environment():
    env = SandboxedEnvironment(undefined=StrictUndefined, autoescape=False)
    env.globals.clear()
    env.filters = {"tojson": lambda value: json.dumps(value, ensure_ascii=False)}
    return env


def check_template(text, fields):
    if not isinstance(text, str) or len(text) > 16000:
        raise BusinessError("SCHEMA_INVALID", "提示词模板必须是不超过 16000 字符的文本")
    try:
        parsed = template_environment().parse(text)
        # Only interpolation, field lookup and the JSON filter are enabled.
        allowed = (
            nodes.Template,
            nodes.Output,
            nodes.TemplateData,
            nodes.Name,
            nodes.Getitem,
            nodes.Const,
            nodes.Filter,
        )
        for item in [parsed, *parsed.find_all(nodes.Node)]:
            if not isinstance(item, allowed) or isinstance(item, nodes.Filter) and item.name != "tojson":
                raise BusinessError("SCHEMA_INVALID", "模板只允许字段插值和 tojson 过滤器")
        if meta.find_undeclared_variables(parsed) - set(fields):
            raise BusinessError("REFERENCE_INVALID", "模板使用了未映射的输入变量")
    except TemplateError:
        raise BusinessError("SCHEMA_INVALID", "提示词模板格式不合法") from None


def render_template(text, inputs):
    check_template(text, inputs)
    try:
        rendered = template_environment().from_string(text).render(**inputs)
    except TemplateError:
        raise BusinessError("INPUT_INVALID", "提示词变量缺失或类型错误") from None
    if len(rendered) > 60000:
        raise BusinessError("BUDGET_EXCEEDED", "渲染后的提示词超过大小限制")
    return rendered


def validate_v2(workflow, resources, error):
    try:
        try:
            V2Policy.model_validate(workflow.policy)
        except ValidationError:
            raise BusinessError("POLICY_DENIED", "V2 策略字段、类型或预算不符合授权规则") from None
        check_schema(workflow.input_schema)
        check_schema(workflow.output_schema)
        if workflow.input_schema.get("type") != "object" or workflow.output_schema.get("type") != "object":
            raise BusinessError("SCHEMA_INVALID", "首期输入输出 Schema 必须为 object")
        if workflow.state_fields or workflow.child_agent_refs or workflow.skill_refs:
            raise BusinessError("CAPABILITY_UNAVAILABLE", "V2 首期尚未开放业务 State、Skill 和子图")
        if workflow.evaluation_ref != "generic-result-evaluation@1":
            raise BusinessError("CAPABILITY_UNAVAILABLE", "V2 请使用 generic-result-evaluation@1")
        if set(workflow.dependency_refs) - {"models", "connections", "validators", "tools", "skills", "subgraphs"}:
            raise BusinessError("CAPABILITY_UNAVAILABLE", "依赖分组不可用")
        if workflow.dependency_refs.get("skills") or workflow.dependency_refs.get("subgraphs"):
            raise BusinessError("CAPABILITY_UNAVAILABLE", "V2 首期尚未开放 Skill 和子图依赖")
        if set(workflow.policy) - {
            "tools",
            "objects",
            "capability_refs",
            "resource_scopes",
            "max_model_calls",
            "max_tool_calls",
            "active_timeout_ms",
        }:
            raise BusinessError("POLICY_DENIED", "V2 策略包含未知字段")
        if workflow.policy.get("tools") or workflow.policy.get("objects"):
            raise BusinessError("POLICY_DENIED", "V2 使用 capability_refs 和 resource_scopes 授权")
        scopes = workflow.policy.get("resource_scopes", [])
        if not isinstance(scopes, list) or set(scopes) - {"orders:customer", "http:registered"}:
            raise BusinessError("POLICY_DENIED", "资源作用域超出本地工作空间授权")
        capabilities = workflow.policy.get("capability_refs", [])
        if not isinstance(capabilities, list) or not set(capabilities).issubset(
            workflow.dependency_refs.get("tools", [])
        ):
            raise BusinessError("POLICY_DENIED", "能力授权必须绑定已注册工具版本")
        deadline = workflow.policy.get("active_timeout_ms", 120000)
        if not isinstance(deadline, int) or isinstance(deadline, bool) or not 1000 <= deadline <= 900000:
            raise BusinessError("SCHEMA_INVALID", "活动执行预算必须在 1000 到 900000 毫秒之间")
        bindings = resources.bindings(workflow) if resources else None
        operations = {}
        if bindings:
            for connection in bindings["connections"].values():
                for op in connection["operations"]:
                    operations.setdefault(op["id"], []).append((connection, op))
            for cap in capabilities:
                if cap not in operations:
                    raise BusinessError("CAPABILITY_UNAVAILABLE", f"能力缺少连接绑定：{cap}")
    except BusinessError as exc:
        error(exc.message)
        return
    used = {"models": set(), "connections": set(), "validators": set(), "tools": set()}
    for node in workflow.nodes:
        try:
            if node.type in CONFIG_MODELS:
                try:
                    CONFIG_MODELS[node.type].model_validate(node.config)
                except ValidationError:
                    raise BusinessError("SCHEMA_INVALID", "节点配置字段缺失、类型错误或含未支持选项") from None
            elif node.type in ("input", "output") and node.config:
                raise BusinessError("SCHEMA_INVALID", "输入输出节点使用工作流 Schema，无额外执行配置")
            if node.type not in ("input", "http", "llm", "agent", "verify", "human_input", "condition", "output"):
                raise BusinessError("CAPABILITY_UNAVAILABLE", "该节点尚未接入 V2 执行器，请继续使用 V1")
            for schema in (node.input_schema, node.output_schema):
                if schema is not None:
                    check_schema(schema)
            if node.type in ("llm", "agent"):
                ref = node.config.get("model_ref")
                if ref not in workflow.dependency_refs.get("models", []):
                    raise BusinessError("REFERENCE_INVALID", "模型节点必须绑定模型档案版本")
                used["models"].add(ref)
                if not node.output_schema:
                    raise BusinessError("SCHEMA_INVALID", "模型节点必须配置输出 Schema")
                if node.config.get("executor", "direct_model") not in ("direct_model", "langchain_agent", "deep_agent"):
                    raise BusinessError("CAPABILITY_UNAVAILABLE", "模型执行器不可用")
                if (
                    not isinstance(node.config.get("system_prompt"), str)
                    or not 1 <= len(node.config["system_prompt"]) <= 16000
                ):
                    raise BusinessError("SCHEMA_INVALID", "请填写节点系统提示词")
                check_template(node.config.get("user_prompt_template", ""), node.inputs)
                if node.config.get("skills"):
                    raise BusinessError("CAPABILITY_UNAVAILABLE", "V2 首期尚未开放 Skill 版本管理")
                requested = node.config.get("tools", [])
                if not isinstance(requested, list) or not set(requested).issubset(capabilities):
                    raise BusinessError("POLICY_DENIED", "Agent 工具必须属于工作流授权能力")
                if requested and (node.type == "llm" or node.config.get("executor") == "direct_model"):
                    raise BusinessError("SCHEMA_INVALID", "单次模型节点不调用工具，请使用多轮 Agent")
                for cap in requested:
                    if bindings and len(operations.get(cap, [])) != 1:
                        raise BusinessError("REFERENCE_INVALID", "Agent 工具必须唯一匹配已绑定连接")
                    used["tools"].add(cap)
            if node.type == "http":
                ref, cap = node.config.get("connection_ref"), node.config.get("operation_ref")
                if ref not in workflow.dependency_refs.get("connections", []) or cap not in capabilities:
                    raise BusinessError("POLICY_DENIED", "HTTP 节点未绑定连接或未授权操作")
                used["connections"].add(ref)
                used["tools"].add(cap)
                if bindings:
                    op = next((o for o in bindings["connections"][ref]["operations"] if o["id"] == cap), None)
                    if not op or op["effect"] != "read_only":
                        raise BusinessError("POLICY_DENIED", "首期仅支持已注册只读 GET 操作")
                    if set(op["input_schema"].get("required", [])) - set(node.inputs):
                        raise BusinessError("SCHEMA_INVALID", "HTTP 操作缺少必填参数映射")
            if node.type == "verify":
                ref = node.config.get("validator_ref")
                if ref not in workflow.dependency_refs.get("validators", []):
                    raise BusinessError("REFERENCE_INVALID", "核验节点未绑定核验器版本")
                used["validators"].add(ref)
                if ref == "schema@1":
                    check_schema(node.config.get("schema"))
                    if "value" not in node.inputs:
                        raise BusinessError("SCHEMA_INVALID", "Schema 核验需要 value 输入")
                elif ref == "order-summary@1":
                    if {"customer_id", "response", "analysis"} - set(node.inputs):
                        raise BusinessError("SCHEMA_INVALID", "订单核验需要 customer_id、response 和 analysis")
                else:
                    raise BusinessError("CAPABILITY_UNAVAILABLE", "核验器不可用")
            if node.type == "human_input":
                if (
                    node.config.get("mode", "review") != "review"
                    or node.config.get("reject_behavior", "cancel") != "cancel"
                ):
                    raise BusinessError("CAPABILITY_UNAVAILABLE", "首期人工节点只支持确认或拒绝取消")
                check_schema(node.config.get("form_schema", {"type": "object", "properties": {}}))
                form = node.config.get("form_schema", {"type": "object", "properties": {}})
                if form.get("type") != "object" or "accepted" in form.get("properties", {}):
                    raise BusinessError("SCHEMA_INVALID", "人工反馈 Schema 必须为 object，且不能使用保留字段 accepted")
                ttl = node.config.get("wait_ttl_seconds", 86400)
                if not isinstance(ttl, int) or not 60 <= ttl <= 604800:
                    raise BusinessError("SCHEMA_INVALID", "人工等待有效期必须在 60 到 604800 秒之间")
        except BusinessError as exc:
            error(exc.message, node.id)
    if bindings:
        for cap in used["tools"]:
            if cap not in operations:
                error(f"工具未绑定连接：{cap}")
        if used["tools"] and not scopes:
            error("HTTP 调用需要资源作用域授权")


def verify_result(node, inputs):
    ref = node.config["validator_ref"]
    if ref == "schema@1":
        validate_data(node.config["schema"], inputs.get("value"), "BUSINESS_VERIFICATION_FAILED")
        checks = {"schema_matches": True}
    else:
        response = inputs.get("response") if isinstance(inputs.get("response"), dict) else {}
        data = response.get("data") if isinstance(response.get("data"), dict) else {}
        analysis = inputs.get("analysis") if isinstance(inputs.get("analysis"), dict) else {}
        checks = {
            "http_success": response.get("ok") is True,
            "customer_matches": data.get("customer_id") == inputs.get("customer_id"),
            "orders_present": isinstance(data.get("orders"), list),
            "summary_present": isinstance(analysis.get("summary"), str) and bool(analysis["summary"].strip()),
        }
    return {"passed": all(checks.values()), "checks": checks, "validator_ref": ref}


def validate_references(workflow, node, error, resources=None):
    from backend.compiler import references

    by_id = {n.id: n for n in workflow.nodes}

    def output_schema(source):
        if source.type == "input":
            return workflow.input_schema
        if source.type == "human_input":
            return source.output_schema or {
                "type": "object",
                "properties": {
                    "accepted": {"type": "boolean"},
                    **source.config.get("form_schema", {}).get("properties", {}),
                },
                "additionalProperties": False,
            }
        if source.type == "verify":
            return {
                "type": "object",
                "properties": {
                    "passed": {"type": "boolean"},
                    "checks": {"type": "object"},
                    "validator_ref": {"type": "string"},
                },
                "additionalProperties": False,
            }
        if source.type == "condition":
            return {
                "type": "object",
                "properties": {"branch": {"type": "string"}, "operator": {"type": "string"}, "value": {}},
                "additionalProperties": False,
            }
        if source.type == "http" and resources:
            binding = resources.repo.get("connection_version", source.config["connection_ref"])
            if binding:
                operation = next(
                    (op for op in binding["operations"] if op["id"] == source.config["operation_ref"]), None
                )
                if operation:
                    return operation["response_schema"]
        return source.output_schema or {}

    def reference_schema(ref):
        schema = workflow.input_schema if ref["source"] == "input" else output_schema(by_id[ref["node_id"]])
        for part in ref.get("path", []):
            if schema.get("type") == "array":
                if not isinstance(part, (str, int)) or isinstance(part, bool) or not str(part).isdigit():
                    raise BusinessError("REFERENCE_INVALID", "数组引用必须使用非负整数下标")
                schema = schema.get("items", {})
            else:
                props = schema.get("properties", {})
                if part not in props and schema.get("additionalProperties") is False:
                    raise BusinessError("REFERENCE_INVALID", f"引用字段 {part} 不存在于上游 Schema")
                schema = props.get(part, {})
        return schema

    expected = node.input_schema
    if node.type == "output":
        expected = workflow.output_schema
    elif node.type == "http" and resources:
        connection = resources.repo.get("connection_version", node.config["connection_ref"])
        if connection:
            operation = next((op for op in connection["operations"] if op["id"] == node.config["operation_ref"]), None)
            expected = operation["input_schema"] if operation else expected
    try:
        if expected and set(expected.get("required", [])) - set(node.inputs):
            raise BusinessError("SCHEMA_INVALID", "节点输入映射缺少 Schema 必填字段")
        for ref in references(node.inputs):
            if ref["source"] in ("input", "node") and (ref["source"] != "node" or ref.get("node_id") in by_id):
                reference_schema(ref)
        for field, value in node.inputs.items():
            target = (expected or {}).get("properties", {}).get(field, {})
            if not isinstance(value, dict) or not target:
                continue
            if value.get("source") == "constant":
                validate_data(target, value.get("value"), "SCHEMA_INVALID")
            elif value.get("source") in ("node", "input") and (
                value["source"] != "node" or value.get("node_id") in by_id
            ):
                actual = reference_schema(value)
                a, b = actual.get("type"), target.get("type")
                if isinstance(a, str) and isinstance(b, str) and a != b and (a, b) != ("integer", "number"):
                    raise BusinessError("REFERENCE_INVALID", f"字段 {field} 的引用类型 {a} 与目标类型 {b} 不匹配")
    except (BusinessError, TypeError) as exc:
        error(exc.message if isinstance(exc, BusinessError) else "变量引用路径格式不合法", node.id)


def example_workflow(resources):
    path = Path(__file__).resolve().parent.parent / "docs/design/order-summary-v2.json"
    workflow = json.loads(path.read_text(encoding="utf-8"))
    model = resources.refresh_default()["ref"]
    connection = resources.repo.get("connection", "conn_orders")["ref"]
    workflow["dependency_refs"]["models"] = [model]
    workflow["dependency_refs"]["connections"] = [connection]
    for node in workflow["nodes"]:
        if node["type"] == "llm":
            node["config"]["model_ref"] = model
            node["timeout_ms"] = 120000
        if node["type"] == "http":
            node["config"]["connection_ref"] = connection
    return workflow


def seed_v2(repo, resources):
    from backend.repository import now
    from backend.seeds import default_layout, manifest

    if repo.get("agent", "customer-order-summary"):
        return
    workflow = example_workflow(resources)
    from backend.schemas import Workflow

    bindings = resources.bindings(Workflow.model_validate(workflow))
    agent = {
        "id": workflow["workflow_id"],
        "name": "客户订单摘要与确认",
        "description": "HTTP 查询 → 模型摘要 → 规则核验 → 人工确认",
        "category": "generic",
        "workflow": workflow,
        "layout": default_layout(workflow),
        "revision": 1,
        "latest_version": "1.0.0",
        "created_at": now(),
        "updated_at": now(),
        "deleted_at": None,
    }
    with repo.transaction():
        repo.put("agent", agent["id"], agent)
        repo.put(
            "release",
            f"{agent['id']}:1.0.0",
            {
                "agent_id": agent["id"],
                "name": agent["name"],
                "version": "1.0.0",
                "workflow": workflow,
                "layout": agent["layout"],
                "sha256": semantic_digest(workflow),
                "resolved_bindings": bindings,
                "dependency_manifest": {**manifest(workflow), "resources": bindings},
                "created_at": now(),
                "revoked": False,
            },
        )
