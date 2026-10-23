from pathlib import Path

from backend.repository import digest

FUNCTIONS = {
    "project.query_status@1": {"label": "查询项目状态", "effect": "read_only", "required": ["project_id"]},
    "project.prepare_update@1": {
        "label": "生成修改方案",
        "effect": "read_only",
        "required": ["project_id", "progress"],
    },
    "project.update_progress@1": {"label": "提交已批准修改", "effect": "idempotent_write", "required": ["plan"]},
    "project.snapshot@1": {"label": "项目综合查询流程", "effect": "read_only", "required": ["project_id"]},
}
NODE_TYPES = [
    {"type": t, "type_version": "1", "label": label, "description": desc}
    for t, label, desc in [
        ("input", "输入", "校验业务入口参数"),
        ("python", "Python 函数", "调用已注册业务函数"),
        ("python_workflow", "Python 工作流", "调用已注册代码流程"),
        ("condition", "条件分支", "有限操作符判断"),
        ("llm", "模型生成", "一次结构化生成"),
        ("agent", "Agent", "受限工具循环 / Deep Agents"),
        ("approval", "人工审批", "持久化中断与恢复"),
        ("verify", "业务核验", "结果读回和规则检查"),
        ("output", "输出", "返回已核验结果"),
        ("managed_agent", "固定子 Agent", "调用绑定发布版本"),
        ("subworkflow", "固定子流程", "调用绑定发布版本"),
    ]
]
SKILL_PATH = Path(__file__).resolve().parent.parent / "skills" / "project-analysis" / "SKILL.md"


def skills():
    content = SKILL_PATH.read_text(encoding="utf-8")
    return [
        {
            "id": "project-analysis@1",
            "name": "项目风险分析",
            "sha256": digest(content),
            "tools": ["project.query_status@1"],
            "content": content,
        }
    ]
