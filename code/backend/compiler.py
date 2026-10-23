from collections import defaultdict, deque
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from backend.registry import FUNCTIONS, skills
from backend.schemas import BusinessError, Workflow


class WorkflowState(TypedDict, total=False):
    run_id: str
    inputs: dict
    results: dict
    final: dict


def references(value: Any):
    if isinstance(value, dict):
        if value.get("source") in ("node", "input", "constant"):
            yield value
        else:
            for child in value.values():
                yield from references(child)
    elif isinstance(value, list):
        for child in value:
            yield from references(child)


def validate(workflow: Workflow) -> list[dict]:
    errors = []

    def error(message, node_id=None):
        errors.append({"node_id": node_id, "code": "DSL_INVALID", "message": message})

    nodes = {n.id: n for n in workflow.nodes}
    if len(nodes) != len(workflow.nodes):
        error("节点 ID 重复")
    entry = nodes.get(workflow.entry_node)
    if not entry or entry.type != "input":
        error("入口必须是 input 节点")
    if sum(n.type == "input" for n in nodes.values()) != 1:
        error("只允许一个输入入口")
    outgoing, incoming = defaultdict(list), defaultdict(list)
    for edge in workflow.edges:
        if edge.source not in nodes or edge.target not in nodes:
            error("连线引用不存在的节点", edge.source)
            continue
        outgoing[edge.source].append(edge)
        incoming[edge.target].append(edge.source)
    degree = {key: len(incoming[key]) for key in nodes}
    queue = deque(key for key, count in degree.items() if count == 0)
    order = []
    while queue:
        key = queue.popleft()
        order.append(key)
        for edge in outgoing[key]:
            degree[edge.target] -= 1
            if degree[edge.target] == 0:
                queue.append(edge.target)
    if len(order) != len(nodes):
        error("不支持循环或递归连线")
        return errors
    dom = {}
    reachable = {workflow.entry_node}
    for key in order:
        parents = incoming[key]
        if key != workflow.entry_node and not parents:
            error("节点不可达", key)
        if any(p in reachable for p in parents):
            reachable.add(key)
        dom[key] = set.intersection(*(dom[p] | {p} for p in parents)) if parents else set()
    if len(reachable) != len(nodes):
        error("存在不可达节点")
    if incoming[workflow.entry_node]:
        error("入口不能有入边")
    allowed_tools = workflow.policy.get("tools", [])
    if not isinstance(allowed_tools, list) or any(t not in FUNCTIONS for t in allowed_tools):
        error("策略包含未注册工具")
        allowed_tools = []
    if not set(workflow.policy.get("objects", [])).issubset({"PRJ-1001", "PRJ-1002"}):
        error("策略不能扩展服务端对象授权")
    for field in ("max_model_calls", "max_tool_calls"):
        limit = workflow.policy.get(field, 6)
        if not isinstance(limit, int) or not 1 <= limit <= 6:
            error(f"{field} 必须在 1 到 6 之间")
    if not set(workflow.skill_refs).issubset({s["id"] for s in skills()}):
        error("Skill 不在白名单中")
    for key, node in nodes.items():
        edges = outgoing[key]
        if node.type == "condition":
            if len(edges) != 2 or {e.branch for e in edges} != {"true", "false"}:
                error("条件节点需要 true 和 false 两条分支", key)
            if node.config.get("operator", "gte") not in ("eq", "neq", "gt", "gte", "lt", "lte", "contains"):
                error("条件操作符不支持", key)
        elif node.type == "output":
            if edges:
                error("输出节点不能有后续节点", key)
            if not any(nodes[p].type == "verify" for p in dom[key]):
                error("每条结束路径必须经过业务核验", key)
        elif len(edges) != 1 or edges[0].branch is not None:
            error("普通节点必须有一条无条件出边；不支持并行扇出", key)
        for ref in references(node.inputs):
            if ref["source"] == "node" and ref.get("node_id") not in dom[key]:
                error("输入引用必须指向当前路径必经的上游节点", key)
            if not isinstance(ref.get("path", []), list):
                error("引用 path 必须是数组", key)
        if node.type in ("python", "python_workflow"):
            fn = node.config.get("function_ref")
            if fn not in FUNCTIONS:
                error("函数未注册", key)
            else:
                if fn not in allowed_tools:
                    error("函数超出业务包工具权限", key)
                if any(arg not in node.inputs for arg in FUNCTIONS[fn]["required"]):
                    error("缺少函数必需参数", key)
                if node.config.get("effect", FUNCTIONS[fn]["effect"]) != FUNCTIONS[fn]["effect"]:
                    error("函数副作用声明不匹配", key)
                if FUNCTIONS[fn]["effect"] != "read_only":
                    if not any(nodes[p].type == "approval" for p in dom[key]):
                        error("写操作之前必须有审批", key)
                    verify_after = False
                    pending = [e.target for e in edges]
                    while pending:
                        target = pending.pop()
                        if nodes[target].type == "verify":
                            verify_after = True
                            continue
                        if nodes[target].type == "output":
                            error("写操作的每条路径必须在写入后核验", key)
                        pending.extend(e.target for e in outgoing[target])
                    if not verify_after:
                        error("写操作后缺少核验", key)
        if node.type in ("agent", "llm"):
            if node.config.get("executor", "langchain_agent") not in ("direct_model", "langchain_agent", "deep_agent"):
                error("未知模型执行器", key)
            requested = node.config.get("tools", ["project.query_status@1"])
            if not isinstance(requested, list) or any(
                t != "project.query_status@1" or t not in allowed_tools for t in requested
            ):
                error("模型只允许已授权的只读查询工具", key)
            if not set(node.config.get("skills", [])).issubset(workflow.skill_refs):
                error("节点 Skill 未绑定到业务包", key)
        if node.type in ("managed_agent", "subworkflow"):
            ref = {"agent_id": node.config.get("agent_id"), "version": node.config.get("version")}
            if ref not in workflow.child_agent_refs:
                error("子 Agent 未绑定固定发布版本", key)
    if not any(n.type == "output" for n in nodes.values()):
        error("流程需要输出节点")
    from backend.repository import dump

    text = dump(workflow.model_dump()).lower()
    if any(secret in text for secret in ('"api_key"', '"password"', '"authorization"', "sk-")):
        error("流程定义中禁止保存凭据")
    return errors


def resolve(value: Any, state: WorkflowState) -> Any:
    if isinstance(value, dict):
        source = value.get("source")
        if source == "constant":
            return value.get("value")
        if source in ("node", "input"):
            try:
                data = state["results"][value["node_id"]] if source == "node" else state["inputs"]
                for part in value.get("path", []):
                    data = data[int(part)] if isinstance(data, list) else data[part]
                return data
            except (KeyError, IndexError, ValueError, TypeError) as exc:
                raise BusinessError("INPUT_INVALID", "变量引用路径不存在") from exc
        return {k: resolve(v, state) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, state) for v in value]
    return value


def compile_workflow(workflow: Workflow, executor, checkpointer):
    errors = validate(workflow)
    if errors:
        raise BusinessError("DSL_INVALID", "; ".join(e["message"] for e in errors))
    graph = StateGraph(WorkflowState)
    for spec in workflow.nodes:
        graph.add_node(spec.id, executor(spec))
    graph.add_edge(START, workflow.entry_node)
    for spec in workflow.nodes:
        edges = [e for e in workflow.edges if e.source == spec.id]
        if spec.type == "condition":

            def route(state, key=spec.id):
                return state["results"][key]["branch"]

            graph.add_conditional_edges(spec.id, route, {e.branch: e.target for e in edges})
        elif spec.type == "output":
            graph.add_edge(spec.id, END)
        else:
            graph.add_edge(spec.id, edges[0].target)
    return graph.compile(checkpointer=checkpointer)
