"""Run a throwaway fixes-server for the app's end-to-end suite (``fixes-app/e2e``).

Starts Uvicorn from this project's virtual environment against a new, uniquely named MongoDB
database, with a JWT secret generated here and never printed, local avatar storage in a new
temporary directory and rate limits raised so one suite run cannot hit them. It waits for
``/healthz``, then either runs a command with ``FIXES_E2E_API_URL`` set, or serves until a stop
file appears (or Ctrl+C). On the way out it stops the server gracefully, checks that the
``envelopes`` collection is empty (every device drained its mailbox), drops the database and
deletes the media directory.

    python scripts/e2e_server.py --mongodb-uri mongodb://127.0.0.1:27099 \
        --cwd ../fixes-app -- npm run test:e2e

Exit status: the command's status, or 3 when envelopes were left behind, or 2 when the server
did not start.
"""

from __future__ import annotations

import argparse
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from pymongo import MongoClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
HEALTH_TIMEOUT_SECONDS = 60.0
SHUTDOWN_TIMEOUT_SECONDS = 30.0
EXIT_ENVELOPES_LEFT = 3
EXIT_NO_SERVER = 2

# High enough that a full suite run (several users, devices, reconnects and history batches)
# never sees a 429; the suite itself does not test rate limiting.
E2E_RATE_LIMITS = {
    "FIXES_RATE_LIMIT_REGISTER": "1000/3600",
    "FIXES_RATE_LIMIT_LOGIN_FAILURES_USER_IP": "1000/900",
    "FIXES_RATE_LIMIT_LOGIN_FAILURES_IP": "1000/3600",
    "FIXES_RATE_LIMIT_LOGIN_SUCCESS": "1000/3600",
    "FIXES_RATE_LIMIT_REFRESH": "1000/3600",
    "FIXES_RATE_LIMIT_ENVELOPES": "10000/60",
    "FIXES_RATE_LIMIT_USER_LOOKUP": "1000/60",
    "FIXES_RATE_LIMIT_FRIEND_REQUESTS": "1000/86400",
    "FIXES_RATE_LIMIT_AVATAR": "1000/3600",
    "FIXES_RATE_LIMIT_WS_CONNECT": "1000/60",
    "FIXES_WS_MAX_UNAUTHENTICATED_PER_IP": "200",
}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--mongodb-uri", default=os.environ.get("FIXES_MONGODB_URI"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--log", type=Path, help="server log file (default: a temporary file)")
    parser.add_argument("--cwd", type=Path, help="working directory of the command")
    parser.add_argument(
        "--stop-file",
        type=Path,
        help="without a command: serve until this file exists, then tear down",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER, help="-- command to run")
    args = parser.parse_args(argv)
    if not args.mongodb_uri:
        parser.error("--mongodb-uri (or FIXES_MONGODB_URI) is required")
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command and args.stop_file is None:
        parser.error("give a command after -- or a --stop-file")
    return args


def server_environment(args: argparse.Namespace, db_name: str, media_dir: Path) -> dict[str, str]:
    env = dict(os.environ)
    env.update(E2E_RATE_LIMITS)
    env.update(
        {
            # 48 random characters, generated per run and only ever passed to the child.
            "FIXES_JWT_SECRET": secrets.token_urlsafe(36),
            "FIXES_MONGODB_URI": args.mongodb_uri,
            "FIXES_MONGODB_DB": db_name,
            "FIXES_STORAGE_BACKEND": "local",
            "FIXES_STORAGE_LOCAL_DIR": str(media_dir),
            "FIXES_PUBLIC_BASE_URL": f"http://{args.host}:{args.port}",
        }
    )
    return env


def wait_for_health(base_url: str, server: subprocess.Popen[bytes]) -> bool:
    deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if server.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(f"{base_url}/healthz", timeout=2) as response:  # noqa: S310 - our own http URL
                if response.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            # Not listening yet (or MongoDB not reachable yet: /healthz answers 503).
            pass
        time.sleep(0.25)
    return False


def stop_server(server: subprocess.Popen[bytes]) -> None:
    if server.poll() is not None:
        return
    # Graceful first, so open sockets get 1012 and the lifespan shuts down cleanly. Uvicorn
    # handles Ctrl+Break on Windows (the child runs in its own process group) and SIGINT elsewhere.
    if sys.platform == "win32":
        server.send_signal(signal.CTRL_BREAK_EVENT)
    else:
        server.send_signal(signal.SIGINT)
    try:
        server.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        print("e2e-server: server did not stop in time; killing it", file=sys.stderr)
        server.kill()
        server.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)


def run_command(command: list[str], cwd: Path | None, base_url: str) -> int:
    executable = shutil.which(command[0])
    if executable is None:
        print(f"e2e-server: command not found: {command[0]}", file=sys.stderr)
        return 127
    env = dict(os.environ, FIXES_E2E_API_URL=base_url)
    # The command comes from the developer's own command line.
    return subprocess.call([executable, *command[1:]], cwd=cwd, env=env)  # noqa: S603


def serve_until(stop_file: Path, server: subprocess.Popen[bytes]) -> int:
    try:
        while not stop_file.exists():
            if server.poll() is not None:
                print("e2e-server: the server exited on its own", file=sys.stderr)
                return EXIT_NO_SERVER
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    return 0


def remaining_envelopes(mongo: MongoClient[dict[str, Any]], db_name: str) -> int:
    return mongo[db_name]["envelopes"].count_documents({})


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    db_name = f"fixes_e2e_{secrets.token_hex(8)}"
    media_dir = Path(tempfile.mkdtemp(prefix="fixes-e2e-media-"))
    base_url = f"http://{args.host}:{args.port}"
    log_path = args.log or Path(tempfile.mkstemp(prefix="fixes-e2e-server-", suffix=".log")[1])
    command = [
        sys.executable, "-m", "uvicorn", "--factory", "fixes_server.main:app_from_env",
        "--host", args.host, "--port", str(args.port), "--ws-max-size", "65536",
    ]  # fmt: skip
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
    mongo: MongoClient[dict[str, Any]] = MongoClient(
        args.mongodb_uri, serverSelectionTimeoutMS=5000
    )
    status = 0
    print(f"e2e-server: database {db_name}, log {log_path}", flush=True)
    try:
        with log_path.open("wb") as log:
            server = subprocess.Popen(  # noqa: S603 - fixed argv: this interpreter + uvicorn
                command,
                cwd=PROJECT_ROOT,
                env=server_environment(args, db_name, media_dir),
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
            try:
                if not wait_for_health(base_url, server):
                    print("e2e-server: the server did not become healthy", file=sys.stderr)
                    return EXIT_NO_SERVER
                print(f"e2e-server: healthy at {base_url}", flush=True)
                if args.command:
                    status = run_command(args.command, args.cwd, base_url)
                else:
                    status = serve_until(args.stop_file, server)
            finally:
                stop_server(server)
                print(f"e2e-server: server stopped (exit code {server.returncode})", flush=True)
        left = remaining_envelopes(mongo, db_name)
        print(f"e2e-server: envelopes left in the database: {left}", flush=True)
        if left and status == 0:
            status = EXIT_ENVELOPES_LEFT
    finally:
        mongo.drop_database(db_name)
        dropped = db_name not in mongo.list_database_names()
        print(f"e2e-server: dropped database {db_name}: {'yes' if dropped else 'NO'}", flush=True)
        mongo.close()
        shutil.rmtree(media_dir, onexc=_report_cleanup_error)
    return status


def _report_cleanup_error(_function: object, path: str, error: BaseException) -> None:
    # A leftover temp directory is not worth failing the run for, but it must not go unnoticed.
    print(f"e2e-server: could not delete {path}: {error}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
