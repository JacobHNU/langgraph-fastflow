from typing import Literal

from fastapi import Request
from fastapi.responses import Response
from pydantic import Field

from backend.package_archive import COMPRESSED, Contract, invalid, sha
from backend.packages import PackageService, capabilities, export_release
from backend.repository import now, uid


class ExportBody(Contract):
    container: Literal["tar.gz", "zip"] = "tar.gz"


class CommitBody(Contract):
    trust_unsigned: bool = False


class BindingBody(Contract):
    package_key: str
    mappings: dict[str, dict[str, str]]
    authorize_credentials: bool = False
    allow_model_substitution: bool = False
    effective_policy: dict | None = None


class DeploymentBody(Contract):
    binding_id: str
    name: str = Field(min_length=1, max_length=80)


class RevisionBody(Contract):
    revision: int = Field(ge=1)


class SubmitBody(Contract):
    inputs: dict
    idempotency_key: str = Field(min_length=8, max_length=128)


def register_package_api(app, runtime, *, studio=True):
    service, repo = PackageService(runtime), runtime.repo
    app.state.packages = service

    if studio:

        @app.post("/api/agents/{agent_id}/versions/{version}/export-jobs", status_code=201)
        def export(agent_id: str, version: str, body: ExportBody):
            manifest, data = export_release(repo, runtime.resources, agent_id, version, body.container)
            key = uid("export")
            path = service.storage / (sha(data) + ".archive")
            # Reuse the atomic, validated content store used by imports.
            staged = service.stage(data)
            value = {
                "id": key,
                "agent_id": agent_id,
                "version": version,
                "container": body.container,
                "package_digest": manifest["package_digest"],
                "archive_digest": staged["archive_digest"],
                "status": "COMPLETED",
                "size_bytes": path.stat().st_size,
                "created_at": now(),
            }
            repo.put("export_job", key, value)
            return value

        @app.get("/api/export-jobs/{job_id}/download")
        def download(job_id: str, inline: bool = False):
            job = service.get("export_job", job_id)
            data = (service.storage / (job["archive_digest"] + ".archive")).read_bytes()
            if sha(data) != job["archive_digest"]:
                invalid("导出文件摘要不匹配")
            if inline:
                return Response(data, media_type="application/octet-stream", headers={"Cache-Control": "no-store"})
            return Response(
                data,
                media_type="application/zip" if job["container"] == "zip" else "application/gzip",
                headers={"Content-Disposition": f'attachment; filename="fastflow-{job_id}.{job["container"]}"'},
            )

    @app.get("/api/runtime/capabilities")
    def profile():
        return capabilities()

    @app.post("/api/runtime/import-jobs", status_code=201)
    async def preview(request: Request):
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > COMPRESSED:
                invalid("上传超过 10 MiB")
            data.extend(chunk)
        return service.stage(bytes(data))

    @app.get("/api/runtime/import-jobs/{job_id}")
    def import_job(job_id: str):
        return service.get("import_job", job_id)

    @app.post("/api/runtime/import-jobs/{job_id}/commit", status_code=201)
    def commit(job_id: str, body: CommitBody):
        return service.commit(job_id, body.trust_unsigned)

    @app.get("/api/runtime/packages")
    def packages():
        return repo.list("package")

    @app.get("/api/runtime/packages/{package_id}/versions/{version}")
    def package(package_id: str, version: str):
        return service.get("package", f"{package_id}:{version}")

    @app.post("/api/runtime/bindings", status_code=201)
    def bind(body: BindingBody):
        return service.bind(**body.model_dump())

    @app.get("/api/runtime/bindings")
    def bindings():
        return repo.list("binding")

    @app.get("/api/runtime/bindings/{binding_id}/revisions")
    def binding_revisions(binding_id: str):
        return [service.get("binding", binding_id)]

    @app.post("/api/runtime/deployments", status_code=201)
    def deploy(body: DeploymentBody):
        return service.deploy(body.binding_id, body.name)

    @app.get("/api/runtime/deployments")
    def deployments():
        return repo.list("deployment")

    @app.get("/api/runtime/deployments/{deployment_id}/revisions")
    def deployment_revisions(deployment_id: str):
        service.get("deployment", deployment_id)
        return [service.get("deployment_revision", deployment_id + ":1")]

    @app.post("/api/runtime/deployments/{deployment_id}/validate")
    def validate(deployment_id: str):
        deployment = service.get("deployment", deployment_id)
        binding = service.get("binding", deployment["binding_id"])
        service.payload(service.get("package", deployment["package_key"]))
        return {
            "static": "PASSED",
            "binding_digest": binding["binding_digest"],
            "connector": "REQUIRES_TEST_RUN",
            "smoke": "REQUIRES_TEST_RUN",
        }

    for action in ("activate", "disable", "revoke"):

        def handler(action):
            def transition(deployment_id: str, body: RevisionBody):
                return service.lifecycle(deployment_id, body.revision, action)

            return transition

        app.add_api_route(f"/api/runtime/deployments/{{deployment_id}}/{action}", handler(action), methods=["POST"])

    @app.post("/api/runtime/deployments/{deployment_id}/test-runs", status_code=202)
    def test_run(deployment_id: str, body: SubmitBody):
        return service.submit(deployment_id, body.inputs, body.idempotency_key, test_run=True)

    @app.post("/api/runtime/deployments/{deployment_id}/runs", status_code=202)
    def run(deployment_id: str, body: SubmitBody):
        return service.submit(deployment_id, body.inputs, body.idempotency_key)
