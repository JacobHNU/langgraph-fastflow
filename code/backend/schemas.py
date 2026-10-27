from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Node(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-zA-Z][\w-]{0,63}$")
    type: Literal[
        "input",
        "python",
        "python_workflow",
        "condition",
        "llm",
        "agent",
        "approval",
        "verify",
        "output",
        "managed_agent",
        "subworkflow",
        "http",
        "human_input",
    ]
    type_version: Literal["1"] = "1"
    title: str = ""
    inputs: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)
    timeout_ms: int = Field(default=30000, ge=100, le=120000)
    input_schema_ref: str | None = None
    output_schema_ref: str | None = None
    input_schema: dict[str, Any] | None = None
    output_schema: dict[str, Any] | None = None


class Edge(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    source: str = Field(alias="from")
    target: str = Field(alias="to")
    branch: Literal["true", "false"] | None = None


class Workflow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["1.0", "2.0"] = "1.0"
    workflow_id: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    entry_node: str
    nodes: list[Node] = Field(min_length=2, max_length=40)
    edges: list[Edge] = Field(max_length=80)
    policy: dict[str, Any] = Field(
        default_factory=lambda: {
            "tools": ["project.query_status@1"],
            "objects": ["PRJ-1001", "PRJ-1002"],
            "max_model_calls": 6,
            "max_tool_calls": 6,
        }
    )
    evaluation_ref: str = "project-evaluation@1"
    skill_refs: list[str] = Field(default_factory=list)
    child_agent_refs: list[dict[str, str]] = Field(default_factory=list)
    input_schema: dict[str, Any] | None = None
    output_schema: dict[str, Any] | None = None
    state_fields: list[dict[str, Any]] = Field(default_factory=list)
    dependency_refs: dict[str, list[str]] = Field(default_factory=dict)


class DraftRequest(BaseModel):
    revision: int
    workflow: Workflow
    layout: dict[str, Any] = Field(default_factory=dict)
    name: str | None = Field(default=None, max_length=80)


class CreateAgent(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    workflow: Workflow
    layout: dict[str, Any] = Field(default_factory=dict)


class RunRequest(BaseModel):
    agent_id: str
    version: str
    entrypoint: Literal["run"] = "run"
    inputs: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str = Field(min_length=8, max_length=128)
    conversation_id: str | None = Field(default=None, max_length=100)


class ProjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str = Field(pattern=r"^PRJ-\d{4}$")
    progress: int | None = Field(default=None, ge=0, le=100)
    task: str = Field(default="分析项目进度、风险和下一步建议", max_length=12000)
    simulate_unknown: bool = False


class Assessment(BaseModel):
    assessment: Literal["SUPPORTED", "CONCERNS", "INSUFFICIENT_EVIDENCE"]
    summary: str
    risk_level: Literal["low", "medium", "high"]
    recommendations: list[str]


class BusinessError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)
