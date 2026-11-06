import argparse
import getpass
import os
from pathlib import Path

from backend.system import ControlStore, passwords


def main():
    parser = argparse.ArgumentParser(description="Local administrator password recovery")
    parser.add_argument("command", choices=["reset-password"])
    parser.add_argument("--username", required=True)
    parser.add_argument("--data-dir", default=os.getenv("WORKFLOW_DATA_DIR", "data"))
    args = parser.parse_args()
    store = ControlStore(Path(args.data_dir))
    try:
        user = store.user_by_name(args.username)
        if not user or not user["is_admin"]:
            parser.error("Administrator not found")
        password = getpass.getpass("New password (at least 12 characters): ")
        if len(password) < 12 or len(password) > 1024 or password != getpass.getpass("Confirm password: "):
            parser.error("Passwords do not match or length is invalid")
        with store.transaction():
            store.put(
                "user",
                user["id"],
                {
                    **user,
                    "password_hash": passwords.hash(password),
                    "must_change_password": False,
                    "disabled": False,
                    "revision": user["revision"] + 1,
                },
            )
            store.revoke(user["id"])
            store.audit("user.local_password_recovery", "local-console", user["id"])
        print("Administrator password reset. Previous sessions were revoked.")
    finally:
        store.db.close()


if __name__ == "__main__":
    main()
