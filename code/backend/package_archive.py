"""Bounded, non-extracting portable package container and content protocol."""

import gzip
import hashlib
import io
import json
import re
import stat
import tarfile
import zipfile
from typing import Literal
from uuid import UUID

import rfc8785
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from backend.schemas import BusinessError

COMPRESSED = 10 * 1024 * 1024
EXPANDED = 50 * 1024 * 1024
FILE_LIMIT = 5 * 1024 * 1024
ENTRY_LIMIT = 256
ALGORITHM = "fastflow-package-jcs-sha256-1"
WORKFLOW_PATH = "releases/main/workflow.json"


def invalid(message):
    raise BusinessError("PACKAGE_INVALID", message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    try:
        return rfc8785.dumps(value)
    except (ValueError, TypeError):
        invalid("JSON 无法规范化")


def json_read(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                invalid("JSON 包含重复字段")
            result[key] = value
        return result

    def bounded(value, depth=0):
        if depth > 32:
            invalid("JSON 嵌套层数超过限制")
        if isinstance(value, dict):
            return 1 + sum(bounded(v, depth + 1) for v in value.values())
        if isinstance(value, list):
            return 1 + sum(bounded(v, depth + 1) for v in value)
        return 1

    try:
        value = json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: invalid("JSON 包含非有限数值"))
        if bounded(value) > 50000:
            invalid("JSON 对象过于复杂")
        canonical(value)
        return value
    except (ValueError, UnicodeError, RecursionError):
        invalid("JSON 格式不合法")


def safe_path(path):
    if (
        not isinstance(path, str)
        or len(path) > 240
        or not re.fullmatch(r"[A-Za-z0-9_./-]+", path)
        or path.startswith("/")
        or any(part in ("", ".", "..") for part in path.split("/"))
        or len(path.split("/")) > 16
        or any(part.endswith((".", " ")) for part in path.split("/"))
    ):
        invalid("压缩包含不安全的文件路径")
    return path


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class FileEntry(Contract):
    path: str
    size_bytes: int = Field(ge=0, le=FILE_LIMIT)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class Source(Contract):
    application_version: str
    release_ref: str
    release_digest_algorithm: Literal["fastflow-v2-semantic-1"]
    release_digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class DefinitionDigest(Contract):
    algorithm: Literal["fastflow-v2-semantic-1"]
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class Entrypoint(Contract):
    name: Literal["run"]
    workflow_path: Literal["releases/main/workflow.json"]


class RuntimeContract(Contract):
    contract_version: Literal["1.0"]
    certified_profile: str
    required_capabilities: list[str] = Field(max_length=80)


class ValidationContract(Contract):
    source_attestation: Literal["validation/source-attestation.json"]
    required_target_checks: list[Literal["static", "connector", "smoke"]]


class Manifest(Contract):
    package_schema_version: Literal["1.0"]
    package_id: str
    package_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    display_name: str = Field(min_length=1, max_length=80)
    source: Source
    definition_digest: DefinitionDigest
    entrypoint: Entrypoint
    workflow_schema_version: Literal["2.0"]
    runtime_contract: RuntimeContract
    resource_contracts: Literal["contracts/resources.json"]
    executor_contracts: Literal["contracts/executors.json"]
    requested_policy: dict
    validation: ValidationContract
    files: list[FileEntry] = Field(max_length=ENTRY_LIMIT - 1)
    digest_algorithm: Literal["fastflow-package-jcs-sha256-1"]
    package_digest: str = Field(pattern=r"^[a-f0-9]{64}$")


def manifest_digest(manifest):
    return sha(canonical({k: v for k, v in manifest.items() if k != "package_digest"}))


def read_archive(data):
    if not data or len(data) > COMPRESSED:
        invalid("压缩包超过 10 MiB 或为空")
    files, names, total = {}, set(), 0

    def add(path, size, stream, directory=False):
        nonlocal total
        path = safe_path(path.rstrip("/") if directory else path)
        if path.casefold() in names or len(names) >= ENTRY_LIMIT:
            invalid("压缩包含重复路径或文件数量超过限制")
        names.add(path.casefold())
        if directory:
            return
        if size < 0 or size > FILE_LIMIT:
            invalid("单文件超过 5 MiB")
        content = stream.read(FILE_LIMIT + 1)
        total += len(content)
        if len(content) != size or total > EXPANDED or total > len(data) * 100:
            invalid("解压大小或压缩比超过限制")
        files[path] = content

    try:
        if data.startswith(b"PK"):
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for entry in archive.infolist():
                    mode = entry.external_attr >> 16
                    if (
                        entry.flag_bits & 1
                        or stat.S_ISLNK(mode)
                        or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)
                    ):
                        invalid("ZIP 不允许加密、链接或特殊文件")
                    with archive.open(entry) as stream:
                        add(entry.filename, entry.file_size, stream, entry.is_dir())
        elif data.startswith(b"\x1f\x8b"):
            # Bound the complete tar stream, including headers and padding, before parsing PAX paths.
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
                raw = stream.read(EXPANDED + 1)
            if len(raw) > EXPANDED or len(raw) > len(data) * 100:
                invalid("TAR 解压大小或压缩比超过限制")
            with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
                for entry in archive:
                    if not entry.isfile() and not entry.isdir():
                        invalid("TAR 不允许链接或特殊文件")
                    add(entry.name, entry.size, archive.extractfile(entry) if entry.isfile() else None, entry.isdir())
        else:
            invalid("仅支持 .tar.gz 和 .zip")
    except (OSError, EOFError, tarfile.TarError, zipfile.BadZipFile, RuntimeError, NotImplementedError):
        invalid("压缩包损坏或使用了不支持的压缩方式")
    if "manifest.json" not in files:
        invalid("缺少 manifest.json")
    manifest = json_read(files["manifest.json"])
    try:
        Manifest.model_validate(manifest)
        UUID(manifest["package_id"])
    except (ValidationError, ValueError, TypeError):
        invalid("发布包清单不符合 1.0 协议")
    if manifest_digest(manifest) != manifest["package_digest"]:
        invalid("清单摘要不匹配")
    entries = manifest["files"]
    if [e["path"] for e in entries] != sorted({e["path"] for e in entries}):
        invalid("文件清单必须唯一且按路径排序")
    if set(files) != {"manifest.json", *(e["path"] for e in entries)}:
        invalid("文件清单与包内容不一致")
    for entry in entries:
        content = files[entry["path"]]
        if len(content) != entry["size_bytes"] or sha(content) != entry["sha256"]:
            invalid("文件摘要或大小不匹配")
    return manifest, files


def write_archive(manifest, files, container="tar.gz"):
    payload = {**files, "manifest.json": canonical(manifest)}
    buffer = io.BytesIO()
    if container == "zip":
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in sorted(payload.items()):
                info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, content)
    elif container == "tar.gz":
        with (
            gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0, filename="") as compressed,
            tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive,
        ):
            for name, content in sorted(payload.items()):
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(content), 0o600
                archive.addfile(info, io.BytesIO(content))
    else:
        invalid("仅支持 .tar.gz 和 .zip")
    result = buffer.getvalue()
    read_archive(result)
    return result
