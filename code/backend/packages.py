"""Release export and target-side immutable package/binding/deployment records."""

import json
import os
import re
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from pydantic import Field, ValidationError

from backend.compiler import validate
from backend.data_policy import BUSINESS_DATA_POLICY
from backend.identity import actor_ref
from backend.package_archive import (
    ALGORITHM,
    WORKFLOW_PATH,
    Contract,
    canonical,
    invalid,
    json_read,
    manifest_digest,
    read_archive,
    sha,
    write_archive,
)
from backend.repository import digest, now, uid
from backend.resources import OperationSpec
from backend.schema_validation import validate_data
from backend.schemas import BusinessError, Workflow
from backend.skill_resources import SkillContract, check_skill, skill_contract
from backend.v2 import V2Policy, semantic_digest

PROFILE = "fastflow-local-r0-v1"
PROFILE_FILES = (
    "compiler.py",
    "runtime.py",
    "v2.py",
    "transforms.py",
    "invocations.py",
    "resources.py",
    "schema_validation.py",
    "executors/generic.py",
    "executors/models.py",
    "executors/agents.py",
    "packages.py",
    "package_archive.py",
    "schemas.py",
    "model_settings.py",
    "repository.py",
    "data_policy.py",
    "skill_resources.py",
)


def check_deployment_boundary(repo, run):
    if run.get("deployment_id"):
        if run.get("profile", {}).get("implementation_digest") != capabilities()["implementation_digest"]:
            raise BusinessError("CAPABILITY_UNAVAILABLE", "运行环境版本已变化，须使用匹配发行版或重新导出、绑定并验证")
        deployment = repo.get("deployment", run["deployment_id"])
        if not deployment or deployment["status"] == "REVOKED":
            raise BusinessError("CANCELLED", "部署已撤销，在执行边界停止")


def capabilities():
    root = Path(__file__).parent
    implementation = sha(
        canonical(
            {
                "files": {name: sha((root / name).read_bytes()) for name in PROFILE_FILES},
                "dependency_lock": sha((root.parent / "uv.lock").read_bytes()),
                "python": f"{sys.version_info.major}.{sys.version_info.minor}",
            }
        )
    )
    return {
        "contract_version": "1.0",
        "profile": PROFILE,
        "implementation_digest": implementation,
        "capabilities": [
            *(
                f"node:{name}@1"
                for name in (
                    "input",
                    "output",
                    "http",
                    "transform",
                    "llm",
                    "agent",
                    "verify",
                    "condition",
                    "human_input",
                )
            ),
            "executor:direct_model@1",
            "executor:langchain_agent@1",
            "executor:deep_agent@1",
            "validator:schema@1",
            "validator:order-summary@1",
            "evaluator:generic-result-evaluation@1",
            "skill:instructions-http@1",
        ],
        "containers": ["tar.gz", "zip"],
        "trust_policy": "explicit-manual-unsigned",
        "max_concurrent_tasks": 3,
        "deployment_mode": "single-process-loopback",
    }


class InferenceContract(Contract):
    mode: str = Field(pattern=r"^(demo|openai|unavailable)$")
    model: str = Field(min_length=1, max_length=200)
    temperature: float | int | None = Field(ge=0, le=2)
    max_tokens: int = Field(ge=1, le=128000)


class ModelContract(Contract):
    ref: str
    inference: InferenceContract


class ConnectionContract(Contract):
    ref: str
    operations: list[OperationSpec] = Field(min_length=1, max_length=20)


class ResourcesContract(Contract):
    models: list[ModelContract]
    connections: list[ConnectionContract]
    validators: list[str]
    tools: list[str]
    skills: list[SkillContract] = Field(default_factory=list, max_length=10)


class ExecutorsContract(Contract):
    profile: str
    implementation_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    capabilities: list[str]


class SourceAttestation(Contract):
    definition_digest: str
    resource_contract_digest: str
    executor_contract_digest: str
    checks: dict


def inference(config):
    return {key: config.get(key) for key in ("mode", "model", "temperature", "max_tokens")}


class PackageResourceResolver:
    """Keep original DSL refs; resolve them against one frozen target binding."""

    def __init__(self, bindings):
        self.frozen = bindings
        self.repo = self

    def get(self, kind, key):
        group = {"connection_version": "connections", "model_profile_version": "models", "skill_version": "skills"}.get(
            kind
        )
        return self.frozen.get(group, {}).get(key) if group else None

    def bindings(self, workflow):
        return self.frozen


def scan_secrets(files, resources=None):
    text = b"\n".join(files.values()).decode("utf-8")
    if re.search(r"(?i)(?:sk-[a-z0-9_-]{12,}|Bearer\s+[a-z0-9_.-]{8,}|https?://[^\s/@]+:[^\s/@]+@)", text):
        invalid("发布定义含疑似凭据，请将凭据改为目标连接配置")
    if re.search(r'(?i)"(?:password|api_key|access_token|authorization|secret)"\s*:\s*"[^"\s]+"', text):
        invalid("发布定义含凭据常量")
    if resources:
        refs = {"legacy-default"}
        for kind in ("model_profile_version", "connection_version"):
            refs.update(v["credential_ref"] for v in resources.repo.list(kind))
        secrets = [resources.secret(ref) for ref in refs] + list(resources.legacy.credential_values())
        for secret in secrets:
            if secret and len(secret) >= 8 and (secret in text or json.dumps(secret)[1:-1] in text):
                invalid("发布定义含已保存的连接凭据")


def export_release(repo, resources, agent_id, version, container="tar.gz"):
    release = repo.get("release", f"{agent_id}:{version}")
    agent = repo.get("agent", agent_id)
    if not release or not agent or agent.get("deleted_at") or release.get("revoked"):
        raise HTTPException(404, "发布版本不存在或不可导出")
    workflow = Workflow.model_validate(release["workflow"])
    if workflow.schema_version != "2.0":
        raise BusinessError("CAPABILITY_UNAVAILABLE", "首期发布包仅支持 V2，请保留 V1 在 Studio 运行")
    bound = release["resolved_bindings"]
    if not bound.get("models"):
        raise BusinessError(
            "CAPABILITY_UNAVAILABLE", "Runtime R0 需显式绑定一个模型供结果评估使用，请补充模型依赖后重新发布"
        )
    ops = {n.config["operation_ref"] for n in workflow.nodes if n.type == "http"}
    ops.update(t for n in workflow.nodes for t in n.config.get("tools", []))
    contracts = {
        "models": [
            {"ref": ref, "inference": inference(value["config"])} for ref, value in sorted(bound["models"].items())
        ],
        "connections": [
            {"ref": ref, "operations": [op for op in value["operations"] if op["id"] in ops]}
            for ref, value in sorted(bound["connections"].items())
            if any(op["id"] in ops for op in value["operations"])
        ],
        "validators": sorted(bound["validators"]),
        "tools": sorted(ops),
        "skills": [skill_contract(value) for _, value in sorted(bound.get("skills", {}).items())],
    }
    # Unused environment refs cannot be satisfied implicitly on another host.
    if {c["ref"] for c in contracts["connections"]} != set(workflow.dependency_refs.get("connections", [])):
        invalid("请先移除发布定义中未使用的连接依赖，再重新发布")
    caps = capabilities()
    required = sorted(
        {
            *(f"node:{n.type}@1" for n in workflow.nodes),
            *(
                f"executor:{n.config.get('executor', 'direct_model')}@1"
                for n in workflow.nodes
                if n.type in ("llm", "agent")
            ),
            *(f"validator:{ref}" for ref in contracts["validators"]),
            f"evaluator:{workflow.evaluation_ref}",
            *(["skill:instructions-http@1"] if contracts["skills"] else []),
        }
    )
    definition = semantic_digest(release["workflow"])
    if definition != release["sha256"]:
        invalid("源发布快照摘要不一致")
    executors = {"profile": PROFILE, "implementation_digest": caps["implementation_digest"], "capabilities": required}
    files = {
        WORKFLOW_PATH: canonical(release["workflow"]),
        "contracts/resources.json": canonical(contracts),
        "contracts/executors.json": canonical(executors),
        "validation/source-attestation.json": canonical(
            {
                "definition_digest": definition,
                "resource_contract_digest": sha(canonical(contracts)),
                "executor_contract_digest": sha(canonical(executors)),
                "checks": {
                    "source_published_static_check": True,
                    "target_connector": "required",
                    "target_smoke": "required",
                },
            }
        ),
        "ui/layout.json": canonical(release["layout"]),
        "docs/README.md": b"FastFlow portable V2 release. Explicit target binding and successful smoke test required.\n",
    }
    scan_secrets(files, resources)
    with repo.transaction():
        lineage = repo.get("package_lineage", agent_id) or {"package_id": str(uuid4())}
        repo.put("package_lineage", agent_id, lineage)
    manifest = {
        "package_schema_version": "1.0",
        "package_id": lineage["package_id"],
        "package_version": version,
        "display_name": release["name"],
        "source": {
            "application_version": "0.2.0",
            "release_ref": f"{agent_id}:{version}",
            "release_digest_algorithm": "fastflow-v2-semantic-1",
            "release_digest": definition,
        },
        "definition_digest": {"algorithm": "fastflow-v2-semantic-1", "sha256": definition},
        "entrypoint": {"name": "run", "workflow_path": WORKFLOW_PATH},
        "workflow_schema_version": "2.0",
        "runtime_contract": {
            "contract_version": "1.0",
            "certified_profile": PROFILE,
            "required_capabilities": required,
        },
        "resource_contracts": "contracts/resources.json",
        "executor_contracts": "contracts/executors.json",
        "requested_policy": workflow.policy,
        "validation": {
            "source_attestation": "validation/source-attestation.json",
            "required_target_checks": ["static", "connector", "smoke"],
        },
        "files": [{"path": path, "size_bytes": len(data), "sha256": sha(data)} for path, data in sorted(files.items())],
        "digest_algorithm": ALGORITHM,
    }
    manifest["package_digest"] = manifest_digest(manifest)
    data = write_archive(manifest, files, container)
    return manifest, data


def inspect_package(data):
    manifest, files = read_archive(data)
    workflow = Workflow.model_validate(json_read(files[WORKFLOW_PATH]))
    contracts = ResourcesContract.model_validate(json_read(files["contracts/resources.json"])).model_dump(mode="json")
    if not contracts["models"]:
        invalid("Runtime R0 必须显式绑定结果评估模型")
    executors = ExecutorsContract.model_validate(json_read(files["contracts/executors.json"])).model_dump()
    caps = capabilities()
    if manifest["runtime_contract"]["certified_profile"] != PROFILE or executors["profile"] != PROFILE:
        invalid("Runtime profile 不兼容")
    if executors["implementation_digest"] != caps["implementation_digest"]:
        invalid("执行器实现摘要不一致，请使用匹配的 Runtime 发行版")
    required = manifest["runtime_contract"]["required_capabilities"]
    if set(required) - set(caps["capabilities"]) or required != executors["capabilities"]:
        invalid("发布包要求未知能力或执行器合同不一致")
    if workflow.schema_version != "2.0" or manifest["requested_policy"] != workflow.policy:
        invalid("工作流版本或权限合同不一致")
    definition = semantic_digest(json_read(files[WORKFLOW_PATH]))
    if definition != manifest["definition_digest"]["sha256"] or definition != manifest["source"]["release_digest"]:
        invalid("工作流语义摘要不一致")
    if manifest["validation"]["required_target_checks"] != ["static", "connector", "smoke"]:
        invalid("发布包不能跳过目标验证")
    attestation = SourceAttestation.model_validate(json_read(files["validation/source-attestation.json"]))
    if (
        attestation.definition_digest != definition
        or attestation.resource_contract_digest != sha(files["contracts/resources.json"])
        or attestation.executor_contract_digest != sha(files["contracts/executors.json"])
        or attestation.checks
        != {"source_published_static_check": True, "target_connector": "required", "target_smoke": "required"}
    ):
        invalid("源验证声明与发布内容不一致")
    actual_required = {
        *(f"node:{n.type}@1" for n in workflow.nodes),
        *(
            f"executor:{n.config.get('executor', 'direct_model')}@1"
            for n in workflow.nodes
            if n.type in ("llm", "agent")
        ),
        *(f"validator:{ref}" for ref in contracts["validators"]),
        f"evaluator:{workflow.evaluation_ref}",
        *(["skill:instructions-http@1"] if contracts["skills"] else []),
    }
    if set(required) != actual_required or set(contracts["tools"]) != set(workflow.dependency_refs.get("tools", [])):
        invalid("能力合同与实际工作流不一致")
    if set(files) - {
        "manifest.json",
        WORKFLOW_PATH,
        "contracts/resources.json",
        "contracts/executors.json",
        "validation/source-attestation.json",
        "ui/layout.json",
        "docs/README.md",
        "examples/input.json",
    }:
        invalid("当前 Runtime 不支持此包中的额外文件或扩展")
    scan_secrets({k: v for k, v in files.items() if k != "manifest.json"})
    bound = {"models": {}, "connections": {}, "validators": {}, "tools": contracts["tools"], "skills": {}}
    for skill in contracts["skills"]:
        check_skill(skill)
        if skill["ref"] in bound["skills"]:
            invalid("Skill 版本引用重复")
        bound["skills"][skill["ref"]] = skill
    if set(bound["skills"]) != set(workflow.dependency_refs.get("skills", [])):
        invalid("Skill 合同必须精确覆盖依赖引用")
    for group in ("models", "connections"):
        refs = [item["ref"] for item in contracts[group]]
        if len(refs) != len(set(refs)) or set(refs) != set(workflow.dependency_refs.get(group, [])):
            invalid("资源合同必须精确覆盖依赖引用")
        for item in contracts[group]:
            bound[group][item["ref"]] = {**item, "config": item.get("inference", {})}
    if set(contracts["validators"]) != set(workflow.dependency_refs.get("validators", [])):
        invalid("核验器合同不一致")
    bound["validators"] = {ref: {"ref": ref, "version": "1"} for ref in contracts["validators"]}
    errors = validate(workflow, PackageResourceResolver(bound))
    if errors:
        invalid("; ".join(e["message"] for e in errors))
    return manifest, files, contracts


class PackageService:
    def __init__(self, runtime):
        self.runtime, self.repo = runtime, runtime.repo
        self.storage = self.repo.root / "packages"
        self.storage.mkdir(exist_ok=True)

    def get(self, kind, key):
        value = self.repo.get(kind, key)
        if not value:
            raise HTTPException(404, "对象不存在")
        return value

    def stage(self, data):
        manifest, _, contracts = inspect_package(data)
        job_id = uid("import")
        job = {
            "id": job_id,
            "manifest": manifest,
            "resources": contracts,
            "status": "PREVIEW",
            "trust": "UNSIGNED_UNTRUSTED",
            "archive_digest": sha(data),
            "created_at": now(),
        }
        # Content-addressed atomic writes; never unpack untrusted paths to disk.
        path = self.storage / (sha(data) + ".archive")
        if not path.exists():
            with tempfile.NamedTemporaryFile(dir=self.storage, delete=False) as stream:
                temp = Path(stream.name)
                try:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                except BaseException:
                    temp.unlink(missing_ok=True)
                    raise
            os.replace(temp, path)
        self.repo.put("import_job", job_id, job)
        return job

    def commit(self, job_id, trust_unsigned):
        if not trust_unsigned:
            raise BusinessError("POLICY_DENIED", "请明确确认发布者及未签名包信任；摘要校验不代表发布者可信")
        with self.repo.transaction():
            job = self.get("import_job", job_id)
            manifest = job["manifest"]
            key = f"{manifest['package_id']}:{manifest['package_version']}"
            existing = self.repo.get("package", key)
            if existing and existing["manifest"]["package_digest"] != manifest["package_digest"]:
                raise BusinessError("PACKAGE_CONFLICT", "相同包 ID 和版本已存在不同内容")
            if existing:
                return existing
            value = {
                "id": key,
                "manifest": manifest,
                "resources": job["resources"],
                "status": "BINDING_REQUIRED",
                "archive_digest": job["archive_digest"],
                "imported_by": actor_ref(),
                "created_at": now(),
                "trust": "MANUALLY_TRUSTED_UNSIGNED",
            }
            self.repo.put("package", key, value)
            self.repo.update("import_job", job_id, status="COMMITTED")
            return value

    def payload(self, package):
        data = (self.storage / (package["archive_digest"] + ".archive")).read_bytes()
        if sha(data) != package["archive_digest"]:
            invalid("已保存压缩包被修改")
        return inspect_package(data)

    def bind(self, package_key, mappings, authorize_credentials, allow_model_substitution=False, effective_policy=None):
        if not authorize_credentials:
            raise BusinessError("POLICY_DENIED", "必须显式授权使用目标凭据")
        package = self.get("package", package_key)
        manifest, files, contracts = self.payload(package)
        workflow = Workflow.model_validate(json_read(files[WORKFLOW_PATH]))
        policy = workflow.policy if effective_policy is None else effective_policy
        try:
            V2Policy.model_validate(policy)
        except ValidationError:
            raise BusinessError("POLICY_DENIED", "目标策略字段、类型或预算不合法") from None
        for key in ("capability_refs", "resource_scopes"):
            if not set(policy.get(key, [])) <= set(workflow.policy.get(key, [])):
                raise BusinessError("POLICY_DENIED", "目标策略不能扩大源策略")
        for key, default in (("max_model_calls", 6), ("max_tool_calls", 6), ("active_timeout_ms", 120000)):
            if policy.get(key, default) > workflow.policy.get(key, default):
                raise BusinessError("POLICY_DENIED", "目标预算不能扩大源预算")
        if set(policy) != set(workflow.policy):
            raise BusinessError("POLICY_DENIED", "目标策略字段必须与源策略一致")
        resolved = {
            "models": {},
            "connections": {},
            "validators": {ref: {"ref": ref, "version": "1"} for ref in contracts["validators"]},
            "tools": contracts["tools"],
            "skills": {s["ref"]: s for s in contracts["skills"]},
        }
        diffs = []
        if set(mappings) != {"models", "connections"}:
            invalid("请显式提交模型和连接映射")
        for group, kind in (("models", "model_profile_version"), ("connections", "connection_version")):
            if set(mappings[group]) != {c["ref"] for c in contracts[group]}:
                invalid("目标映射必须精确覆盖源引用")
            for item in contracts[group]:
                target = self.get(kind, mappings[group][item["ref"]])
                if group == "models":
                    actual = inference(target["config"])
                    if actual != item["inference"]:
                        diffs.append({"source_ref": item["ref"], "expected": item["inference"], "target": actual})
                        if not allow_model_substitution:
                            raise BusinessError(
                                "MODEL_CONTRACT_CONFLICT", "模型或推理参数不同，需明确允许替换并重新测试"
                            )
                else:
                    operations = {op["id"]: op for op in target["operations"]}
                    for op in item["operations"]:
                        actual = operations.get(op["id"])
                        # Display names may differ; execution semantics must be identical.
                        if not actual or {k: v for k, v in op.items() if k != "name"} != {
                            k: v for k, v in actual.items() if k != "name"
                        }:
                            raise BusinessError(
                                "RESOURCE_CONTRACT_CONFLICT", "目标 HTTP 操作方法、路径、映射或 Schema 不匹配"
                            )
                    target = {**target, "operations": [operations[op["id"]] for op in item["operations"]]}
                # Credential versions are target-local and immutable for this binding.
                credential_ref = uid("cred")
                self.runtime.resources.write_secret(
                    credential_ref, self.runtime.resources.secret(target["credential_ref"], target.get("config"))
                )
                resolved[group][item["ref"]] = {**target, "credential_ref": credential_ref}
        execution = workflow.model_copy(update={"policy": policy})
        errors = validate(execution, PackageResourceResolver(resolved))
        if errors:
            raise BusinessError("DSL_INVALID", "; ".join(e["message"] for e in errors))
        value = {
            "id": uid("binding"),
            "revision": 1,
            "package_key": package_key,
            "package_digest": manifest["package_digest"],
            "mappings": mappings,
            "resolved_bindings": resolved,
            "effective_policy": policy,
            "profile": capabilities(),
            "model_substitutions": diffs,
            "credential_use_authorized_by": actor_ref(),
            "created_at": now(),
        }
        value["binding_digest"] = sha(canonical(value))
        self.repo.put("binding", value["id"], value)
        return value

    def deploy(self, binding_id, name):
        binding = self.get("binding", binding_id)
        value = {
            "id": uid("deployment"),
            "name": name,
            "revision": 1,
            "active_revision": None,
            "binding_id": binding_id,
            "package_key": binding["package_key"],
            "status": "READY",
            "created_at": now(),
        }
        revision = {**value, "deployment_id": value["id"], "binding_digest": binding["binding_digest"]}
        self.repo.put("deployment_revision", value["id"] + ":1", revision)
        return self.repo.put("deployment", value["id"], value)

    def lifecycle(self, deployment_id, revision, action):
        with self.repo.transaction():
            deployment = self.get("deployment", deployment_id)
            if revision != deployment["revision"]:
                raise BusinessError("REVISION_CONFLICT", "部署资料已变化")
            if deployment["status"] == "REVOKED":
                raise BusinessError("POLICY_DENIED", "已撤销部署不可重新启用，请新建部署")
            if action == "activate":
                binding = self.get("binding", deployment["binding_id"])
                tested = [
                    r
                    for r in self.repo.list("run")
                    if r.get("deployment_id") == deployment_id
                    and r.get("test_run")
                    and r.get("binding_digest") == binding["binding_digest"]
                    and r["status"] == "SUCCEEDED"
                    and r.get("evaluation_status") == "PASSED"
                ]
                if not tested:
                    raise BusinessError("TARGET_TEST_REQUIRED", "须先完成当前绑定的真实链路试运行、人工确认及评估")
                status = "ACTIVE"
            else:
                status = "REVOKED" if action == "revoke" else "DISABLED"
            value = self.repo.update(
                "deployment",
                deployment_id,
                status=status,
                revision=revision + 1,
                active_revision=1 if status == "ACTIVE" else None,
            )
            self.repo.put(
                "deployment_audit",
                uid("audit"),
                {"deployment_id": deployment_id, "action": action, "actor_ref": actor_ref(), "created_at": now()},
            )
            return value

    def submit(self, deployment_id, inputs, idempotency_key, test_run=False):
        with self.repo.transaction():
            actor = actor_ref()
            scope = digest(
                {
                    "actor": actor,
                    "deployment": deployment_id,
                    "entrypoint": "run",
                    "test": test_run,
                    "key": idempotency_key,
                }
            )
            request_hash = digest(inputs)
            existing = self.repo.get("deployment_idempotency", scope)
            if existing:
                if existing["request_hash"] != request_hash:
                    raise BusinessError("IDEMPOTENCY_CONFLICT", "相同幂等键不能提交不同输入")
                return self.get("run", existing["run_id"])
            deployment = self.get("deployment", deployment_id)
            if deployment["status"] == "REVOKED" or (not test_run and deployment["status"] != "ACTIVE"):
                raise BusinessError("DEPLOYMENT_UNAVAILABLE", "部署尚未启用或已停止接收新任务")
            binding = self.get("binding", deployment["binding_id"])
            package = self.get("package", deployment["package_key"])
            manifest, files, _ = self.payload(package)
            workflow = Workflow.model_validate(json_read(files[WORKFLOW_PATH]))
            validate_data(workflow.input_schema, inputs)
            spec = {
                "package_id": manifest["package_id"],
                "package_version": manifest["package_version"],
                "package_digest": manifest["package_digest"],
                "binding_id": binding["id"],
                "binding_digest": binding["binding_digest"],
                "deployment_id": deployment_id,
                "deployment_revision": 1,
                "effective_policy": binding["effective_policy"],
                "resolved_bindings": binding["resolved_bindings"],
                "profile": binding["profile"],
                "submitted_by": actor,
                "workflow": json_read(files[WORKFLOW_PATH]),
            }
            run_id = uid("run")
            run = {
                **spec,
                "id": run_id,
                "execution_snapshot_digest": sha(canonical(spec)),
                "execution_source": "package",
                "agent_id": manifest["package_id"],
                "agent_name": manifest["display_name"],
                "version": manifest["package_version"],
                "entrypoint": "run",
                "inputs": inputs,
                "business_data_policy": BUSINESS_DATA_POLICY,
                "test_run": test_run,
                "workflow": json_read(files[WORKFLOW_PATH]),
                "layout": json_read(files.get("ui/layout.json", b"{}")),
                "release_digest": manifest["source"]["release_digest"],
                "skill_hashes": [
                    {"ref": ref, "sha256": s["sha256"]}
                    for ref, s in binding["resolved_bindings"].get("skills", {}).items()
                ],
                "status": "QUEUED",
                "evaluation_status": "PENDING",
                "created_at": now(),
                "parent_run_id": None,
                "conversation_id": None,
                "checkpoint_thread_id": run_id,
                "cancel_requested": False,
                "result": None,
                "node_results": {},
                "error": None,
                "model_mode": next(iter(binding["resolved_bindings"]["models"].values()), {"config": {"mode": "demo"}})[
                    "config"
                ]["mode"],
                "active_elapsed_ms": 0,
                "depth": 0,
            }
            self.repo.put("run", run_id, run)
            self.repo.put("deployment_idempotency", scope, {"request_hash": request_hash, "run_id": run_id})
            self.repo.event(
                run_id,
                "run.created",
                payload={
                    "engine": "LangGraph",
                    "source": "package",
                    "package_digest": run["package_digest"],
                    "binding_digest": run["binding_digest"],
                    "deployment_id": deployment_id,
                    "test_run": test_run,
                },
            )
            return run
