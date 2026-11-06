"""Versioned workspace skills: instructions plus explicitly registered HTTP tools."""

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from backend.data_policy import validate_business_data
from backend.repository import digest, now, uid
from backend.schema_validation import check_schema
from backend.schemas import BusinessError


class SkillRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=2000)
    revision: int | None = None
    content: str = Field(min_length=1, max_length=32000)
    tools: list[str] = Field(default_factory=list, max_length=20)
    connection_refs: list[str] = Field(default_factory=list, max_length=20)
    input_schema: dict = Field(default_factory=lambda: {"type": "object", "properties": {}})


class SkillContract(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ref: str = Field(pattern=r"^skill_[a-f0-9]{16}@[1-9][0-9]*$")
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=2000)
    content: str = Field(min_length=1, max_length=32000)
    tools: list[str] = Field(max_length=20)
    connection_refs: list[str] = Field(max_length=20)
    input_schema: dict
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


def skill_contract(value):
    return {key: value[key] for key in SkillContract.model_fields}


def skill_digest(value):
    return digest({key: value[key] for key in SkillContract.model_fields if key not in ("sha256", "ref")})


def check_skill(value):
    contract = SkillContract.model_validate(skill_contract(value)).model_dump()
    validate_business_data(contract)
    check_schema(contract["input_schema"])
    if contract["input_schema"].get("type") != "object":
        raise BusinessError("SCHEMA_INVALID", "Skill 输入必须为 object")
    if len(set(contract["tools"])) != len(contract["tools"]) or len(set(contract["connection_refs"])) != len(
        contract["connection_refs"]
    ):
        raise BusinessError("REFERENCE_INVALID", "Skill 工具和连接版本不能重复")
    if contract["sha256"] != skill_digest(contract):
        raise BusinessError("REFERENCE_INVALID", "Skill 内容摘要不一致")
    return contract


def save_skill(resources, body, skill_id=None):
    with resources.repo.transaction():
        current = resources.repo.get("skill", skill_id) if skill_id else None
        if skill_id and not current:
            raise HTTPException(404, "Skill 不存在")
        if current and body.revision != current["revision"]:
            raise BusinessError("REVISION_CONFLICT", "Skill 已变化，请重新加载后编辑")
        skill_id = skill_id or uid("skill")
        revision = current["revision"] + 1 if current else 1
        value = {
            **body.model_dump(exclude={"revision"}),
            "id": skill_id,
            "revision": revision,
            "ref": f"{skill_id}@{revision}",
            "updated_at": now(),
        }
        value["sha256"] = skill_digest(value)
        check_skill(value)
        operations = {}
        for ref in value["connection_refs"]:
            connection = resources.repo.get("connection_version", ref)
            if not connection:
                raise BusinessError("REFERENCE_INVALID", f"Skill 连接版本不存在：{ref}")
            for op in connection["operations"]:
                operations.setdefault(op["id"], []).append(ref)
        if any(len(operations.get(tool, [])) != 1 for tool in value["tools"]):
            raise BusinessError("REFERENCE_INVALID", "Skill 工具必须唯一匹配所选连接中的注册操作")
        if any(
            not any(op in value["tools"] for op, refs in operations.items() if ref in refs)
            for ref in value["connection_refs"]
        ):
            raise BusinessError("REFERENCE_INVALID", "请移除 Skill 未使用的连接")
        resources.repo.put("skill_version", value["ref"], value)
        return resources.repo.put("skill", skill_id, value)


def register_skills(app, resources):
    @app.get("/api/skills")
    def skills():
        return resources.repo.list("skill")

    @app.post("/api/skills", status_code=201)
    def create(body: SkillRequest):
        return save_skill(resources, body)

    @app.put("/api/skills/{skill_id}")
    def update(skill_id: str, body: SkillRequest):
        return save_skill(resources, body, skill_id)

    @app.get("/api/skills/{skill_id}/versions")
    def versions(skill_id: str):
        return [s for s in resources.repo.list("skill_version") if s["id"] == skill_id]
