import importlib.metadata
from itertools import pairwise

from backend.registry import FUNCTIONS, skills
from backend.repository import digest, now


def ref(node_id, *path):
    return {"source": "node", "node_id": node_id, "path": list(path)}


def node(key, kind, title, inputs=None, config=None):
    return {
        "id": key,
        "type": kind,
        "type_version": "1",
        "title": title,
        "inputs": inputs or {},
        "config": config or {},
    }


def workflow(key, nodes, edges=None, tools=None):
    return {
        "schema_version": "1.0",
        "workflow_id": key,
        "entry_node": "n_input",
        "nodes": nodes,
        "edges": edges or [{"from": a["id"], "to": b["id"]} for a, b in pairwise(nodes)],
        "policy": {
            "tools": tools or ["project.query_status@1"],
            "objects": ["PRJ-1001", "PRJ-1002"],
            "max_model_calls": 6,
            "max_tool_calls": 6,
        },
        "evaluation_ref": "project-evaluation@1",
        "skill_refs": [],
        "child_agent_refs": [],
    }


def manifest(wf):
    return {
        "packages": {p: importlib.metadata.version(p) for p in ("langgraph", "langchain", "deepagents", "fastapi")},
        "node_plugins": {n["type"]: "1" for n in wf["nodes"]},
        "functions": sorted({n["config"]["function_ref"] for n in wf["nodes"] if "function_ref" in n["config"]}),
        "skills": {s["id"]: s["sha256"] for s in skills() if s["id"] in wf.get("skill_refs", [])},
        "prompt_version": "project-analysis@1",
        "executor_config_version": "1",
    }


def templates():
    start = node("n_input", "input", "接收项目参数")
    query = node(
        "n_query",
        "python",
        "查询项目状态",
        {"project_id": ref("n_input", "project_id")},
        {"function_ref": "project.query_status@1", "effect": "read_only"},
    )
    verify = node("n_verify", "verify", "读回与业务核验", {"result": ref("n_query")})
    output = node("n_output", "output", "返回业务结果", {"result": ref("n_query"), "verification": ref("n_verify")})
    simple = workflow("project-status", [start, query, verify, output])
    model_workflows = []
    for key, executor, kind, title in [
        ("material-analysis", "langchain_agent", "agent", "多轮工具分析"),
        ("deep-analysis", "deep_agent", "agent", "Deep Agents 材料分析"),
        ("model-summary", "direct_model", "llm", "结构化模型摘要"),
    ]:
        analysis = node(
            "n_analysis",
            kind,
            title,
            {"project_id": ref("n_input", "project_id"), "task": ref("n_input", "task")},
            {
                "executor": executor,
                "tools": ["project.query_status@1"] if kind == "agent" else [],
                "skills": ["project-analysis@1"],
            },
        )
        wf = workflow(
            key,
            [
                start,
                query,
                analysis,
                node("n_verify", "verify", "分析结果核验", {"result": ref("n_analysis")}),
                node(
                    "n_output", "output", "返回分析报告", {"result": ref("n_analysis"), "verification": ref("n_verify")}
                ),
            ],
        )
        analysis["inputs"]["project"] = ref("n_query")
        wf["skill_refs"] = ["project-analysis@1"]
        model_workflows.append(wf)
    update = workflow(
        "approved-update",
        [
            start,
            node(
                "n_plan",
                "python",
                "生成测试数据修改方案",
                {"project_id": ref("n_input", "project_id"), "progress": ref("n_input", "progress")},
                {"function_ref": "project.prepare_update@1", "effect": "read_only"},
            ),
            node("n_approval", "approval", "人工确认修改", {"plan": ref("n_plan")}),
            node(
                "n_commit",
                "python",
                "提交已批准的修改",
                {"plan": ref("n_plan")},
                {"function_ref": "project.update_progress@1", "effect": "idempotent_write"},
            ),
            node("n_verify", "verify", "读回确认修改结果", {"result": ref("n_commit")}),
            node(
                "n_output", "output", "返回修改与核验结果", {"result": ref("n_commit"), "verification": ref("n_verify")}
            ),
        ],
        tools=list(FUNCTIONS),
    )
    branch = workflow(
        "delivery-check",
        [
            start,
            query,
            node(
                "n_condition",
                "condition",
                "进度是否达到 60%",
                {"value": ref("n_query", "progress")},
                {"operator": "gte", "compare_to": 60},
            ),
            node(
                "n_ready",
                "python_workflow",
                "正常交付检查",
                {"project_id": ref("n_input", "project_id")},
                {"function_ref": "project.snapshot@1", "effect": "read_only"},
            ),
            node(
                "n_risk",
                "python_workflow",
                "延迟风险检查",
                {"project_id": ref("n_input", "project_id")},
                {"function_ref": "project.snapshot@1", "effect": "read_only"},
            ),
            verify,
            output,
        ],
        edges=[
            {"from": "n_input", "to": "n_query"},
            {"from": "n_query", "to": "n_condition"},
            {"from": "n_condition", "to": "n_ready", "branch": "true"},
            {"from": "n_condition", "to": "n_risk", "branch": "false"},
            {"from": "n_ready", "to": "n_verify"},
            {"from": "n_risk", "to": "n_verify"},
            {"from": "n_verify", "to": "n_output"},
        ],
        tools=["project.query_status@1", "project.snapshot@1"],
    )
    child = workflow(
        "project-assistant",
        [
            start,
            node(
                "n_child",
                "managed_agent",
                "调用项目查询子 Agent",
                {"project_id": ref("n_input", "project_id")},
                {"agent_id": "project-status", "version": "1.0.0"},
            ),
            node("n_verify", "verify", "核验子 Agent 结果", {"result": ref("n_child", "result")}),
            node(
                "n_output",
                "output",
                "返回综合结果",
                {
                    "result": ref("n_child", "result"),
                    "verification": ref("n_verify"),
                    "child_run_id": ref("n_child", "child_run_id"),
                },
            ),
        ],
    )
    child["child_agent_refs"] = [{"agent_id": "project-status", "version": "1.0.0"}]
    return [
        (simple, "项目状态查询", "纯 Python 快速查询，零执行期模型调用", "query"),
        (model_workflows[0], "业务材料分析", "LangChain 多轮查询与指定 Skill 分析", "analysis"),
        (model_workflows[1], "Deep Agents 分析", "Skill、长上下文与隔离文件后端", "deep"),
        (update, "测试数据修改", "方案 → 人工审批 → 提交 → 读回核验", "approval"),
        (branch, "交付条件分支", "确定性条件判断与 Python 子工作流", "branch"),
        (child, "项目协作 Agent", "固定版本子 Agent，父子证据可追溯", "child"),
        (model_workflows[2], "模型结构化摘要", "单次模型执行与结构化输出核验", "model"),
    ]


def default_layout(wf):
    positions = {}
    nodes = wf["nodes"]
    for index, n in enumerate(nodes):
        positions[n["id"]] = {"x": index * 310 + 60, "y": 200}
    if wf["workflow_id"] == "delivery-check":
        positions = {
            "n_input": {"x": 30, "y": 200},
            "n_query": {"x": 330, "y": 200},
            "n_condition": {"x": 630, "y": 200},
            "n_ready": {"x": 950, "y": 70},
            "n_risk": {"x": 950, "y": 340},
            "n_verify": {"x": 1270, "y": 200},
            "n_output": {"x": 1580, "y": 200},
        }
    return positions


def seed(repo):
    if not repo.get("project", "PRJ-1001"):
        for project in [
            {
                "project_id": "PRJ-1001",
                "name": "企业门户升级",
                "progress": 72,
                "status": "进行中",
                "owner": "平台工程组",
                "object_version": 1,
                "milestones": [
                    {"name": "需求确认", "done": True},
                    {"name": "核心开发", "done": True},
                    {"name": "集成验收", "done": False},
                ],
                "risks": ["第三方接口联调待完成"],
                "source": "local-test-adapter",
            },
            {
                "project_id": "PRJ-1002",
                "name": "客户服务平台",
                "progress": 38,
                "status": "存在风险",
                "owner": "业务系统组",
                "object_version": 1,
                "milestones": [{"name": "需求确认", "done": True}, {"name": "核心开发", "done": False}],
                "risks": ["关键模块延期", "测试资源不足"],
                "source": "local-test-adapter",
            },
        ]:
            repo.put("project", project["project_id"], project)
    for wf, name, desc, category in templates():
        agent_id = wf["workflow_id"]
        if repo.get("agent", agent_id):
            continue
        layout = default_layout(wf)
        agent = {
            "id": agent_id,
            "name": name,
            "description": desc,
            "category": category,
            "revision": 1,
            "workflow": wf,
            "layout": layout,
            "created_at": now(),
            "updated_at": now(),
            "latest_version": "1.0.0",
        }
        repo.put("agent", agent_id, agent)
        repo.put(
            "release",
            f"{agent_id}:1.0.0",
            {
                "agent_id": agent_id,
                "name": name,
                "version": "1.0.0",
                "workflow": wf,
                "layout": layout,
                "sha256": digest(wf),
                "dependency_manifest": manifest(wf),
                "created_at": now(),
                "revoked": False,
            },
        )
