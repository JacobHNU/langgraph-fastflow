import asyncio
import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pwdlib import PasswordHash
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.demo_orders import start_demo_orders
from backend.executors.models import model_mode
from backend.identity import principal
from backend.repository import dump, now, uid

COOKIE = "workflow_session"
SESSION_SECONDS = 12 * 3600
passwords = PasswordHash.recommended()
DUMMY_HASH = passwords.hash(secrets.token_urlsafe(32))
DEFAULT_PREFS = {"theme": "system", "accent": "teal", "default_workspace_id": None}
SAFE = {"GET", "HEAD", "OPTIONS"}


def fail(status, message):
    raise HTTPException(status, message)


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


class ControlStore:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.depth = 0
        self.db = sqlite3.connect(self.root / "control.db", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.execute("CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,data TEXT NOT NULL,PRIMARY KEY(kind,id))")
        self.db.commit()

    @contextmanager
    def transaction(self):
        with self.lock:
            outer = self.depth == 0
            self.depth += 1
            try:
                yield
            except BaseException:
                if outer:
                    self.db.rollback()
                raise
            else:
                if outer:
                    self.db.commit()
            finally:
                self.depth -= 1

    def get(self, kind, key):
        with self.lock:
            row = self.db.execute("SELECT data FROM records WHERE kind=? AND id=?", (kind, key)).fetchone()
            return json.loads(row[0]) if row else None

    def list(self, kind):
        with self.lock:
            return [
                json.loads(r[0])
                for r in self.db.execute("SELECT data FROM records WHERE kind=? ORDER BY rowid", (kind,))
            ]

    def put(self, kind, key, value):
        with self.transaction():
            self.db.execute(
                "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
                (kind, key, dump(value)),
            )
        return value

    def delete(self, kind, key):
        with self.transaction():
            self.db.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, key))

    def audit(self, action, actor, target):
        key = uid("audit")
        self.put(
            "audit", key, {"id": key, "action": action, "actor_ref": actor, "target_ref": target, "created_at": now()}
        )

    def user_by_name(self, name):
        return next((u for u in self.list("user") if u["username"].casefold() == name.strip().casefold()), None)

    def revoke(self, user_id):
        for session in self.list("session"):
            if session["user_id"] == user_id:
                self.delete("session", session["id"])

    def public_user(self, user):
        return {
            key: user[key]
            for key in (
                "id",
                "username",
                "display_name",
                "email",
                "avatar",
                "avatar_color",
                "is_admin",
                "disabled",
                "must_change_password",
                "revision",
                "preferences",
            )
        }

    def authenticate(self, token):
        session = self.get("session", hashed(token)) if token else None
        if not session or session["expires_at"] <= time.time():
            return None
        user = self.get("user", session["user_id"])
        if not user or user["disabled"]:
            return None
        return user, session


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoginBody(StrictBody):
    username: str = Field(min_length=1, max_length=40)
    password: SecretStr = Field(max_length=1024)


class UserBody(StrictBody):
    username: str = Field(pattern=r"^[A-Za-z0-9_.-]{3,40}$")
    display_name: str = Field(min_length=1, max_length=80)
    email: str = Field(default="", max_length=254)
    avatar: Literal["initials", "user", "bot", "flower", "star"] = "initials"
    avatar_color: Literal["teal", "blue", "rose", "amber"] = "teal"

    @field_validator("email")
    @classmethod
    def email_format(cls, value):
        if value and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("邮箱格式不正确")
        return value

    @field_validator("display_name")
    @classmethod
    def name_not_blank(cls, value):
        if not value.strip():
            raise ValueError("请输入名称")
        return value.strip()


class CreateUser(UserBody):
    password: SecretStr = Field(min_length=12, max_length=1024)


class UpdateUser(UserBody):
    revision: int
    current_password: SecretStr | None = None


class PasswordBody(StrictBody):
    current_password: SecretStr
    new_password: SecretStr = Field(min_length=12, max_length=1024)


class ResetPassword(StrictBody):
    new_password: SecretStr = Field(min_length=12, max_length=1024)
    revision: int


class RevisionBody(StrictBody):
    revision: int


class Preferences(StrictBody):
    theme: Literal["light", "dark", "system"]
    accent: Literal["teal", "blue", "rose", "amber"]
    default_workspace_id: str | None = None


class WorkspaceBody(StrictBody):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=1000)
    template: Literal["empty", "demo"] = "empty"

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value):
        if not value.strip():
            raise ValueError("请输入工作区名称")
        return value.strip()


class WorkspaceUpdate(StrictBody):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=1000)
    revision: int


class WorkspaceManager:
    def __init__(self, root, factory):
        self.control = ControlStore(root)
        self.factory = factory
        self.pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="workspace-worker")
        self.pool.workflow_slots = threading.BoundedSemaphore(3)
        self.apps = {}
        self.tasks = {}
        self.lock = threading.RLock()
        self.loop = None
        self.mutation_locks = {}
        self.open({"id": "ws_legacy", "template": "demo"})

    def open(self, workspace):
        key = workspace["id"]
        with self.lock:
            if key not in self.apps:
                root = self.control.root if key == "ws_legacy" else self.control.root / "workspaces" / key
                self.apps[key] = self.factory(
                    root, examples=workspace["template"] == "demo", pool=self.pool, workspace_id=key
                )
                if self.loop:
                    self.loop.call_soon_threadsafe(self.start_worker, key)
            return self.apps[key]

    def start_worker(self, key):
        if key not in self.tasks:
            self.tasks[key] = asyncio.create_task(self.apps[key].state.runtime.worker())

    def owned(self, workspace_id, user):
        workspace = self.control.get("workspace", workspace_id)
        if not workspace or workspace["owner_id"] != user["id"]:
            fail(404, "工作区不存在")
        return workspace

    def create_workspace(self, user_id, name, description="", template="empty", key=None):
        key = key or uid("ws")
        workspace = {
            "id": key,
            "owner_id": user_id,
            "name": name,
            "description": description,
            "template": template,
            "archived_at": None,
            "revision": 1,
            "created_at": now(),
        }
        self.open(workspace)
        self.control.put("workspace", key, workspace)
        return workspace

    def blockers(self, workspace):
        repo = self.open(workspace).state.repo
        runs = repo.list("run")
        unresolved = {o["run_id"] for o in repo.list("operation") if o["status"] in ("UNKNOWN", "SENT")}
        blocked = [
            r
            for r in runs
            if r["status"] in ("QUEUED", "RUNNING", "AWAITING_APPROVAL", "AWAITING_INPUT")
            or r["id"] in unresolved
            or r.get("evaluation_status") in ("PENDING", "RUNNING")
        ]
        return [
            {"run_id": r["id"], "status": r["status"], "evaluation_status": r.get("evaluation_status")} for r in blocked
        ]


class SystemBoundary:
    def __init__(self, app, manager):
        self.app, self.manager = app, manager

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        if not path.startswith("/api/"):
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        cookie_name = getattr(self.manager, "cookie_name", COOKIE)
        try:
            cookies = SimpleCookie(headers.get(b"cookie", b"").decode())
            token = cookies[cookie_name].value if cookie_name in cookies else ""
        except (ValueError, KeyError):
            token = ""
        control = self.manager.control
        authenticated = control.authenticate(token)
        public = path in ("/api/auth/status", "/api/auth/setup", "/api/auth/login", "/api/health")
        held_locks = []
        try:
            if scope["method"] not in SAFE:
                origin = headers.get(b"origin", b"").decode()
                if origin and not re.fullmatch(r"http://(?:127\.0\.0\.1|localhost):\d{1,5}", origin):
                    fail(403, "仅接受本机界面的操作请求")
            if not authenticated and not public:
                fail(401, "请登录")
            if authenticated:
                user, session = authenticated
                if scope["method"] not in SAFE:
                    owners = {user["id"]}
                    target = re.match(r"^/api/admin/users/([^/]+)", path)
                    if target and user["is_admin"]:
                        owners.add(target[1])
                    for owner in sorted(owners):
                        lock = self.manager.mutation_locks.setdefault(owner, asyncio.Lock())
                        await lock.acquire()
                        held_locks.append(lock)
                    authenticated = control.authenticate(token)
                    if not authenticated:
                        fail(401, "请登录")
                    user, session = authenticated
                scope["user"] = user
                scope["auth_session"] = session
                scope["session_guard"] = lambda: bool(control.authenticate(token))
                if scope["method"] not in SAFE and path not in ("/api/auth/setup", "/api/auth/login"):
                    csrf = headers.get(b"x-csrf-token", b"").decode()
                    if not secrets.compare_digest(csrf, session["csrf_token"]):
                        fail(403, "请求校验失败，请刷新后重试")
                if user["must_change_password"] and path not in (
                    "/api/auth/me",
                    "/api/auth/password",
                    "/api/auth/logout",
                    "/api/auth/status",
                    "/api/health",
                ):
                    fail(403, "请先修改临时密码")
            control_path = (
                public or path.startswith(("/api/auth/", "/api/me", "/api/admin/")) or path == "/api/workspaces"
            )
            workspace = None
            tail = ""
            if path.startswith("/api/workspaces/"):
                parts = path.split("/", 4)
                workspace = self.manager.owned(parts[3], user)
                tail = parts[4] if len(parts) > 4 else ""
                control_path = tail in ("", "archive", "restore")
            elif not control_path:
                workspace = self.manager.owned("ws_legacy", user)
                tail = path[len("/api/") :]
            if workspace and not control_path:
                if workspace["archived_at"] and scope["method"] not in SAFE:
                    fail(409, "工作区已归档，请先恢复")
                destination = self.manager.open(workspace)
                routed = dict(scope)
                routed["path"] = "/api/" + tail
                routed["raw_path"] = routed["path"].encode()
            else:
                destination, routed = self.app, scope
            context = principal.set(authenticated[0] if authenticated else None)
            try:
                await destination(routed, receive, send)
            finally:
                principal.reset(context)
        except HTTPException as exc:
            await JSONResponse({"message": exc.detail}, status_code=exc.status_code)(scope, receive, send)
        finally:
            for lock in reversed(held_locks):
                lock.release()


def create_system_app(data_dir, factory, *, headless=False):
    root = Path(data_dir or os.getenv("WORKFLOW_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
    manager = WorkspaceManager(root, factory)
    cookie_name = "runtime_session_" + hashed(str(root.resolve()))[:12] if headless else COOKIE
    manager.cookie_name = cookie_name
    control = manager.control

    @asynccontextmanager
    async def lifespan(app):
        manager.loop = asyncio.get_running_loop()
        for workspace in control.list("workspace"):
            manager.open(workspace)
        for key in list(manager.apps):
            manager.start_worker(key)
        order_service = (
            None if headless else start_demo_orders(os.getenv("WORKFLOW_DEMO_ORDERS_URL", "http://127.0.0.1:18765"))
        )
        yield
        manager.loop = None
        for workspace_app in manager.apps.values():
            workspace_app.state.runtime.stopping = True
        await asyncio.gather(*manager.tasks.values())
        await asyncio.to_thread(manager.pool.shutdown, wait=True)
        if order_service:
            await asyncio.to_thread(order_service.shutdown)
            order_service.server_close()
        for workspace_app in manager.apps.values():
            workspace_app.state.repo.close()
        control.db.close()

    app = FastAPI(title="FastFlow Runtime" if headless else "Workflow Studio", version="0.2.0", lifespan=lifespan)
    app.state.manager = manager
    app.state.control = control
    app.state.repo = manager.apps["ws_legacy"].state.repo
    app.state.runtime = manager.apps["ws_legacy"].state.runtime
    app.add_middleware(SystemBoundary, manager=manager)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return JSONResponse(
            {
                "message": "输入格式不正确",
                "errors": [{"field": str(e["loc"][-1]), "message": e["msg"]} for e in exc.errors()],
            },
            status_code=422,
        )

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return JSONResponse({"message": exc.detail}, status_code=exc.status_code)

    def me(request):
        return control.get("user", request.scope["user"]["id"])

    def admin(request):
        user = me(request)
        if not user["is_admin"]:
            fail(403, "需要管理员权限")
        return user

    def revision(value, expected):
        if value["revision"] != expected:
            fail(409, "资料已变化，请重新加载")

    def issue(user, response):
        token = secrets.token_urlsafe(32)
        session = {
            "id": hashed(token),
            "user_id": user["id"],
            "csrf_token": secrets.token_urlsafe(32),
            "expires_at": time.time() + SESSION_SECONDS,
        }
        control.put("session", session["id"], session)
        response.set_cookie(cookie_name, token, max_age=SESSION_SECONDS, httponly=True, samesite="lax", path="/")
        return {
            "user": control.public_user(user),
            "csrf_token": session["csrf_token"],
            "expires_at": session["expires_at"],
        }

    def create_user(body, is_admin=False):
        if control.user_by_name(body.username):
            fail(409, "用户名已存在")
        key = uid("user")
        return control.put(
            "user",
            key,
            {
                **body.model_dump(exclude={"password"}),
                "id": key,
                "password_hash": passwords.hash(body.password.get_secret_value()),
                "is_admin": is_admin,
                "disabled": False,
                "must_change_password": not is_admin,
                "revision": 1,
                "preferences": dict(DEFAULT_PREFS),
                "created_at": now(),
            },
        )

    @app.get("/api/health")
    def health(request: Request):
        result = {
            "service": "fastflow-runtime" if headless else "workflow-studio",
            "status": "ok",
            "initialized": bool(control.list("user")),
        }
        user = request.scope.get("user")
        legacy = control.get("workspace", "ws_legacy")
        if user and legacy and legacy["owner_id"] == user["id"]:
            result["model_mode"] = model_mode(app.state.runtime.model_settings.current())
        return result

    @app.get("/api/auth/status")
    def status():
        return {"initialized": bool(control.list("user"))}

    @app.post("/api/auth/setup", status_code=201)
    def setup(body: CreateUser, response: Response):
        with control.transaction():
            if control.list("user"):
                fail(409, "管理员已初始化")
            user = create_user(body, True)
            workspace = manager.create_workspace(user["id"], "本地工作空间", "原有流程与历史运行", "demo", "ws_legacy")
            user["preferences"]["default_workspace_id"] = workspace["id"]
            control.put("user", user["id"], user)
            control.audit("system.setup", user["id"], workspace["id"])
            return issue(user, response)

    @app.post("/api/auth/login")
    def login(body: LoginBody, request: Request, response: Response):
        attempt_keys = [
            hashed("name:" + body.username.strip().casefold()),
            hashed("ip:" + (request.client.host if request.client else "local")),
        ]
        with control.transaction():
            for key, limit in zip(attempt_keys, (5, 20), strict=True):
                attempts = control.get("attempts", key) or {"times": []}
                attempts["times"] = [t for t in attempts["times"] if t > time.time() - 600]
                if len(attempts["times"]) >= limit:
                    fail(429, "登录尝试过多，请在 10 分钟后重试")
            user = control.user_by_name(body.username)
            valid = passwords.verify(body.password.get_secret_value(), user["password_hash"] if user else DUMMY_HASH)
            if not user or not valid or user["disabled"]:
                for key in attempt_keys:
                    attempts = control.get("attempts", key) or {"times": []}
                    control.put(
                        "attempts",
                        key,
                        {"times": [t for t in attempts["times"] if t > time.time() - 600] + [time.time()]},
                    )
                # Failed attempt counters must survive the HTTP error.
                control.db.commit()
                fail(401, "用户名或密码不正确")
            control.delete("attempts", attempt_keys[0])
            control.audit("auth.login", user["id"], user["id"])
            return issue(user, response)

    @app.get("/api/auth/me")
    def current(request: Request):
        session = request.scope["auth_session"]
        return {
            "user": control.public_user(me(request)),
            "csrf_token": session["csrf_token"],
            "expires_at": session["expires_at"],
        }

    @app.post("/api/auth/logout")
    def logout(request: Request, response: Response):
        with control.transaction():
            control.delete("session", request.scope["auth_session"]["id"])
            control.audit("auth.logout", me(request)["id"], me(request)["id"])
        response.delete_cookie(cookie_name, path="/")
        return {"ok": True}

    @app.post("/api/auth/password")
    def change_password(body: PasswordBody, request: Request, response: Response):
        with control.transaction():
            user = me(request)
            if not passwords.verify(body.current_password.get_secret_value(), user["password_hash"]):
                fail(403, "当前密码不正确")
            control.put(
                "user",
                user["id"],
                {
                    **user,
                    "password_hash": passwords.hash(body.new_password.get_secret_value()),
                    "must_change_password": False,
                    "revision": user["revision"] + 1,
                },
            )
            control.revoke(user["id"])
            control.audit("user.password", user["id"], user["id"])
        response.delete_cookie(cookie_name, path="/")
        return {"ok": True}

    @app.get("/api/me")
    def profile(request: Request):
        return control.public_user(me(request))

    def update_user(target, body, actor, own):
        revision(target, body.revision)
        other = control.user_by_name(body.username)
        if other and other["id"] != target["id"]:
            fail(409, "用户名已存在")
        if (
            own
            and body.username != target["username"]
            and (
                not body.current_password
                or not passwords.verify(body.current_password.get_secret_value(), target["password_hash"])
            )
        ):
            fail(403, "修改登录名需要验证当前密码")
        target = {
            **target,
            **body.model_dump(exclude={"current_password", "revision"}),
            "revision": target["revision"] + 1,
        }
        control.put("user", target["id"], target)
        control.audit("user.profile", actor["id"], target["id"])
        return control.public_user(target)

    @app.patch("/api/me")
    def update_profile(body: UpdateUser, request: Request):
        with control.transaction():
            user = me(request)
            return update_user(user, body, user, True)

    @app.get("/api/me/preferences")
    def preferences(request: Request):
        return me(request)["preferences"]

    @app.put("/api/me/preferences")
    def save_preferences(body: Preferences, request: Request):
        with control.transaction():
            user = me(request)
            if body.default_workspace_id:
                workspace = manager.owned(body.default_workspace_id, user)
                if workspace["archived_at"]:
                    fail(409, "不能将已归档工作区设为默认")
            control.put("user", user["id"], {**user, "preferences": body.model_dump()})
            control.audit("user.preferences", user["id"], user["id"])
            return body

    @app.get("/api/workspaces")
    def workspaces(request: Request):
        return [w for w in control.list("workspace") if w["owner_id"] == me(request)["id"]]

    @app.post("/api/workspaces", status_code=201)
    def new_workspace(body: WorkspaceBody, request: Request):
        with control.transaction():
            user = me(request)
            workspace = manager.create_workspace(user["id"], body.name, body.description, body.template)
            control.audit("workspace.create", user["id"], workspace["id"])
            return workspace

    @app.get("/api/workspaces/{workspace_id}")
    def workspace_detail(workspace_id: str, request: Request):
        workspace = manager.owned(workspace_id, me(request))
        repo = manager.open(workspace).state.repo
        return {**workspace, "counts": {kind: len(repo.list(kind)) for kind in ("agent", "release", "run", "evidence")}}

    @app.patch("/api/workspaces/{workspace_id}")
    def update_workspace(workspace_id: str, body: WorkspaceUpdate, request: Request):
        with control.transaction():
            user = me(request)
            workspace = manager.owned(workspace_id, user)
            revision(workspace, body.revision)
            if workspace["archived_at"]:
                fail(409, "请先恢复工作区")
            if not body.name.strip():
                fail(422, "请输入工作区名称")
            workspace = {
                **workspace,
                "name": body.name.strip(),
                "description": body.description,
                "revision": workspace["revision"] + 1,
            }
            control.put("workspace", workspace_id, workspace)
            control.audit("workspace.update", user["id"], workspace_id)
            return workspace

    @app.post("/api/workspaces/{workspace_id}/archive")
    def archive_workspace(workspace_id: str, body: RevisionBody, request: Request):
        with control.transaction():
            user = me(request)
            workspace = manager.owned(workspace_id, user)
            revision(workspace, body.revision)
            if workspace["archived_at"]:
                fail(409, "工作区已归档")
            active = [w for w in control.list("workspace") if w["owner_id"] == user["id"] and not w["archived_at"]]
            if len(active) <= 1:
                fail(409, "至少保留一个可用工作区")
            blocked = manager.blockers(workspace)
            if blocked:
                fail(409, {"reason": "工作区仍有未结束任务、评估或待处理对账", "runs": blocked})
            workspace = {**workspace, "archived_at": now(), "revision": workspace["revision"] + 1}
            control.put("workspace", workspace_id, workspace)
            if user["preferences"]["default_workspace_id"] == workspace_id:
                user["preferences"]["default_workspace_id"] = next(w["id"] for w in active if w["id"] != workspace_id)
                control.put("user", user["id"], user)
            control.audit("workspace.archive", user["id"], workspace_id)
            return workspace

    @app.post("/api/workspaces/{workspace_id}/restore")
    def restore_workspace(workspace_id: str, body: RevisionBody, request: Request):
        with control.transaction():
            user = me(request)
            workspace = manager.owned(workspace_id, user)
            revision(workspace, body.revision)
            workspace = {**workspace, "archived_at": None, "revision": workspace["revision"] + 1}
            control.put("workspace", workspace_id, workspace)
            control.audit("workspace.restore", user["id"], workspace_id)
            return workspace

    @app.get("/api/admin/users")
    def users(request: Request):
        admin(request)
        return [control.public_user(u) for u in control.list("user")]

    @app.post("/api/admin/users", status_code=201)
    def add_user(body: CreateUser, request: Request):
        with control.transaction():
            actor = admin(request)
            user = create_user(body)
            workspace = manager.create_workspace(user["id"], "我的工作区")
            user["preferences"]["default_workspace_id"] = workspace["id"]
            control.put("user", user["id"], user)
            control.audit("user.create", actor["id"], user["id"])
            return control.public_user(user)

    def target_user(key):
        user = control.get("user", key)
        if not user:
            fail(404, "用户不存在")
        return user

    @app.patch("/api/admin/users/{user_id}")
    def edit_user(user_id: str, body: UpdateUser, request: Request):
        with control.transaction():
            actor = admin(request)
            return update_user(target_user(user_id), body, actor, actor["id"] == user_id)

    @app.post("/api/admin/users/{user_id}/reset-password")
    def reset_password(user_id: str, body: ResetPassword, request: Request):
        with control.transaction():
            actor = admin(request)
            user = target_user(user_id)
            revision(user, body.revision)
            user = {
                **user,
                "password_hash": passwords.hash(body.new_password.get_secret_value()),
                "must_change_password": True,
                "revision": user["revision"] + 1,
            }
            control.put("user", user_id, user)
            control.revoke(user_id)
            control.audit("user.reset_password", actor["id"], user_id)
            return control.public_user(user)

    @app.post("/api/admin/users/{user_id}/{action}")
    def user_state(user_id: str, action: Literal["disable", "restore"], body: RevisionBody, request: Request):
        with control.transaction():
            actor = admin(request)
            user = target_user(user_id)
            revision(user, body.revision)
            if action == "disable":
                if (
                    user["is_admin"]
                    and len([u for u in control.list("user") if u["is_admin"] and not u["disabled"]]) <= 1
                ):
                    fail(409, "不能停用最后一个管理员")
                blocked = [
                    {"workspace_id": w["id"], "count": len(manager.blockers(w))}
                    for w in control.list("workspace")
                    if w["owner_id"] == user_id
                ]
                blocked = [w for w in blocked if w["count"]]
                if blocked:
                    fail(409, {"reason": "用户仍有未结束任务，请先处理", "workspaces": blocked})
            user = {**user, "disabled": action == "disable", "revision": user["revision"] + 1}
            control.put("user", user_id, user)
            control.revoke(user_id)
            control.audit("user." + action, actor["id"], user_id)
            return control.public_user(user)

    app.mount("/", manager.apps["ws_legacy"])
    return app
