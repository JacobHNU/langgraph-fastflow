from fastapi import HTTPException
from pydantic import BaseModel, Field

from backend.repository import now, uid
from backend.schemas import BusinessError, Workflow


def active_agent(repo, agent_id):
    agent = repo.get("agent", agent_id)
    if not agent:
        raise HTTPException(404, "工作流不存在")
    if agent.get("deleted_at"):
        raise BusinessError("WORKFLOW_DELETED", "工作流已移入回收站，请先恢复")
    return agent


def blank_workflow(schema_version="1.0"):
    workflow = Workflow(
        workflow_id=uid("workflow").replace("_", "-"),
        entry_node="n_input",
        nodes=[
            {"id": "n_input", "type": "input", "title": "输入参数"},
            {
                "id": "n_output",
                "type": "output",
                "title": "输出结果",
                "inputs": {
                    "result": {"source": "constant", "value": {}},
                    "verification": {"source": "constant", "value": {}},
                },
            },
        ],
        edges=[],
    )
    if schema_version == "2.0":
        workflow.schema_version = "2.0"
        workflow.input_schema = {"type": "object", "properties": {}, "additionalProperties": False}
        workflow.output_schema = {"type": "object", "properties": {}, "additionalProperties": False}
        workflow.nodes[-1].inputs = {}
        workflow.policy = {
            "capability_refs": [],
            "resource_scopes": [],
            "max_model_calls": 6,
            "max_tool_calls": 6,
            "active_timeout_ms": 120000,
        }
        workflow.evaluation_ref = "generic-result-evaluation@1"
    return workflow


class MetadataRequest(BaseModel):
    revision: int
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=1000)


class RevisionRequest(BaseModel):
    revision: int


def register_management(app, repo):
    def check_revision(agent, revision):
        if agent["revision"] != revision:
            raise BusinessError("REVISION_CONFLICT", "工作流版本已变化，请重新载入")

    @app.patch("/api/agents/{agent_id}")
    def metadata(agent_id: str, body: MetadataRequest):
        with repo.transaction():
            agent = active_agent(repo, agent_id)
            check_revision(agent, body.revision)
            if not body.name.strip():
                raise BusinessError("INPUT_INVALID", "请输入工作流名称")
            return repo.update(
                "agent",
                agent_id,
                name=body.name.strip(),
                description=body.description,
                revision=agent["revision"] + 1,
                updated_at=now(),
            )

    @app.delete("/api/agents/{agent_id}")
    def archive(agent_id: str, revision: int):
        with repo.transaction():
            agent = active_agent(repo, agent_id)
            check_revision(agent, revision)
            running = [
                r["id"]
                for r in repo.list("run")
                if r["agent_id"] == agent_id and r["status"] in ("QUEUED", "RUNNING", "AWAITING_APPROVAL", "AWAITING_INPUT")
            ]
            dependencies = [
                f"{r['name']} v{r['version']}"
                for r in repo.list("release")
                if r["agent_id"] != agent_id
                and not r.get("revoked")
                and not (repo.get("agent", r["agent_id"]) or {}).get("deleted_at")
                and any(c["agent_id"] == agent_id for c in r["workflow"].get("child_agent_refs", []))
            ]
            if running or dependencies:
                raise BusinessError(
                    "WORKFLOW_CONFLICT",
                    "无法删除；未结束运行："
                    + (", ".join(running) or "无")
                    + "；被已发布工作流引用："
                    + (", ".join(dependencies) or "无"),
                )
            return repo.update("agent", agent_id, deleted_at=now(), updated_at=now(), revision=agent["revision"] + 1)

    @app.post("/api/agents/{agent_id}/restore")
    def restore(agent_id: str, body: RevisionRequest):
        with repo.transaction():
            agent = repo.get("agent", agent_id)
            if not agent:
                raise HTTPException(404, "工作流不存在")
            check_revision(agent, body.revision)
            return repo.update("agent", agent_id, deleted_at=None, updated_at=now(), revision=agent["revision"] + 1)
