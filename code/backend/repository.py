from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def now() -> str:
    return datetime.now(UTC).isoformat()


def uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def digest(value: Any) -> str:
    return hashlib.sha256(dump(value).encode()).hexdigest()


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            k: "[REDACTED]"
            if any(s in k.lower() for s in ("api_key", "secret", "password", "authorization", "access_token"))
            and not (k in ("requires_api_key", "api_key_configured") and isinstance(v, bool))
            else redact(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        import re

        return re.sub(r"(?i)(?:sk-[a-z0-9_-]{12,}|Bearer\s+[a-z0-9_.-]+)", "[REDACTED]", value)
    return value


class Repository:
    def __init__(self, root: str | Path | None = None):
        self.root = Path(root or os.getenv("WORKFLOW_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.transaction_depth = 0
        self.db = sqlite3.connect(self.root / "studio.db", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS records(kind TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS events_run ON events(run_id,sequence);
        """)
        self.db.commit()
        self._number_existing_evidence()

    def _number_existing_evidence(self):
        with self.transaction():
            groups = {}
            for item in self.list("evidence"):
                groups.setdefault(item["run_id"], []).append(item)
            for items in groups.values():
                number = max((e.get("number", 0) for e in items), default=0)
                for item in sorted(items, key=lambda e: (e.get("created_at", ""), e["id"])):
                    if not item.get("number"):
                        number += 1
                        self.put("evidence", item["id"], {**item, "number": number})

    def evidence_index(self, run_id):
        run = self.get("run", run_id) or {}
        nodes = {n["id"]: n.get("title", n["id"]) for n in run.get("workflow", {}).get("nodes", [])}
        labels = {
            "model.called": "模型输入",
            "model.completed": "模型响应",
            "node.completed": "节点结果",
            "tool.completed": "工具结果",
            "operation.reconciled": "读回对账",
        }
        kinds = {
            ref: labels.get(e["event_type"], "执行证据")
            for e in self.events(run_id)
            for ref in e.get("evidence_refs", [])
        }
        return sorted(
            [
                {**e, "title": f"{kinds.get(e['id'], '上下文记录')} · {nodes.get(e['node_id'], e['node_id'])}"}
                for e in self.list("evidence")
                if e["run_id"] == run_id
            ],
            key=lambda e: e["number"],
        )

    def put(self, kind: str, key: str, value: dict) -> dict:
        with self.transaction():
            self.db.execute(
                "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
                (kind, key, dump(redact(value))),
            )
        return value

    @contextmanager
    def transaction(self):
        with self.lock:
            outermost = self.transaction_depth == 0
            self.transaction_depth += 1
            try:
                yield
            except BaseException:
                if outermost:
                    self.db.rollback()
                raise
            else:
                if outermost:
                    self.db.commit()
            finally:
                self.transaction_depth -= 1

    def get(self, kind: str, key: str) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT data FROM records WHERE kind=? AND id=?", (kind, key)).fetchone()
        value = json.loads(row[0]) if row else None
        if value and kind == "evidence" and value.get("storage") == "file":
            if not re.fullmatch(r"ev_[0-9a-f]{16}", key):
                raise ValueError("Invalid evidence ID")
            value["data"] = json.loads((self.root / "evidence" / f"{key}.json").read_text(encoding="utf-8"))
        return value

    def list(self, kind: str) -> list[dict]:
        with self.lock:
            return [
                json.loads(r[0])
                for r in self.db.execute("SELECT data FROM records WHERE kind=? ORDER BY rowid DESC", (kind,))
            ]

    def update(self, kind: str, key: str, **changes) -> dict:
        with self.lock:
            value = self.get(kind, key)
            if value is None:
                raise KeyError(key)
            return self.put(kind, key, {**value, **changes})

    def event(
        self, run_id: str, event_type: str, node_id: str | None = None, payload: dict | None = None, **extra
    ) -> dict:
        with self.transaction():
            run = self.get("run", run_id) or {}
            value = redact(
                {
                    "event_id": uid("evt"),
                    "run_id": run_id,
                    "occurred_at": now(),
                    "event_type": event_type,
                    "node_id": node_id,
                    "agent_version": run.get("version"),
                    "parent_run_id": run.get("parent_run_id"),
                    "actor_ref": "local-demo-operator",
                    "attempt_id": extra.pop("attempt_id", None),
                    "operation_id": extra.pop("operation_id", None),
                    "evidence_refs": extra.pop("evidence_refs", []),
                    "payload": payload or {},
                    **extra,
                }
            )
            cur = self.db.execute("INSERT INTO events(run_id,data) VALUES(?,?)", (run_id, dump(value)))
            value["sequence"] = cur.lastrowid
        return value

    def events(self, run_id: str, after: int = 0) -> list[dict]:
        with self.lock:
            rows = self.db.execute(
                "SELECT sequence,data FROM events WHERE run_id=? AND sequence>? ORDER BY sequence", (run_id, after)
            ).fetchall()
        return [{**json.loads(r["data"]), "sequence": r["sequence"]} for r in rows]

    def evidence(self, run_id: str, node_id: str, data: Any) -> str:
        evidence_id = uid("ev")
        value = {"id": evidence_id, "run_id": run_id, "node_id": node_id, "created_at": now(), "data": redact(data)}
        value["sha256"] = digest(value["data"])
        encoded = dump(value["data"])
        value["size_bytes"] = len(encoded.encode("utf-8"))
        if value["size_bytes"] > 16384:
            directory = self.root / "evidence"
            directory.mkdir(exist_ok=True)
            (directory / f"{evidence_id}.json").write_text(encoded, encoding="utf-8")
            value.pop("data")
            value["storage"] = "file"
        else:
            value["storage"] = "sqlite"
        with self.transaction():
            value["number"] = (
                max((e.get("number", 0) for e in self.list("evidence") if e["run_id"] == run_id), default=0) + 1
            )
            self.put("evidence", evidence_id, value)
        return evidence_id

    def close(self):
        self.db.close()
