"""Local, authenticated headless Runtime. No editor build or demo services required."""

import argparse
import os
from contextlib import asynccontextmanager
from pathlib import Path


class RuntimeLock:
    def __init__(self, root):
        Path(root).mkdir(parents=True, exist_ok=True)
        self.stream = open(Path(root) / "runtime.lock", "a+b")  # noqa: SIM115 - held for the process lifespan
        if os.fstat(self.stream.fileno()).st_size == 0:
            self.stream.write(b"0")
            self.stream.flush()
        self.stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.stream.close()
            raise RuntimeError("此数据目录已有 Runtime 调度进程，首期仅支持一个进程") from None

    def close(self):
        self.stream.close()


def create_app(data_dir=None):
    from backend.api import create_workspace_app
    from backend.system import create_system_app

    root = Path(data_dir or os.getenv("WORKFLOW_DATA_DIR", "data/runtime"))

    def factory(data_dir, *, examples=True, **kwargs):
        return create_workspace_app(data_dir, examples=False, headless=True, **kwargs)

    app = create_system_app(root, factory, headless=True)
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        lock = RuntimeLock(root)
        try:
            async with original(app):
                yield
        finally:
            lock.close()

    app.router.lifespan_context = lifespan
    return app


def main():
    parser = argparse.ArgumentParser(description="FastFlow local headless Runtime")
    parser.add_argument("--data-dir", default="data/runtime")
    parser.add_argument("--port", type=int, default=8010)
    args = parser.parse_args()
    os.environ["WORKFLOW_DATA_DIR"] = str(Path(args.data_dir).resolve())
    import uvicorn

    uvicorn.run("backend.headless:create_app", factory=True, host="127.0.0.1", port=args.port, workers=1)


if __name__ == "__main__":
    main()
