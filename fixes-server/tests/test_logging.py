"""``FIXES_LOG_LEVEL`` applies to the server's own loggers; libraries that log database
commands or request contents never get below WARNING (README "Security notes", §15)."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager

import pytest

from fixes_server.main import configure_logging
from tests.conftest import MakeClient
from tests.helpers import register

PINNED = ("pymongo", "botocore", "boto3", "s3transfer", "urllib3")


@contextmanager
def fresh_process_logging() -> Iterator[None]:
    """Logging as in a fresh Uvicorn process (a root logger at WARNING without handlers), then
    pytest's state restored. Used inside the test body: pytest re-adds its capture handlers at
    the start of every test phase, and with those present ``basicConfig`` does nothing."""
    root = logging.getLogger()
    handlers = root.handlers[:]
    levels = {name: logging.getLogger(name).level for name in ("", "fixes_server", *PINNED)}
    root.handlers.clear()
    root.setLevel(logging.WARNING)
    for name in ("fixes_server", *PINNED):
        logging.getLogger(name).setLevel(logging.NOTSET)
    try:
        yield
    finally:
        for handler in root.handlers[:]:
            root.removeHandler(handler)
            handler.close()
        root.handlers[:] = handlers
        for name, level in levels.items():
            logging.getLogger(name).setLevel(level)


class _Collect(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def test_debug_level_never_logs_database_commands(make_client: MakeClient) -> None:
    collect = _Collect()
    with fresh_process_logging():
        configure_logging("DEBUG")
        assert logging.getLogger().handlers, "basicConfig must have installed its handler"
        logging.getLogger().addHandler(collect)
        with make_client() as client:
            register(client)
        server_debug = logging.getLogger("fixes_server.services.accounts").isEnabledFor(
            logging.DEBUG
        )
    # The account's argon2 hash travels in an insert command; pymongo logs those at DEBUG.
    assert not [r for r in collect.records if "$argon2id$" in r.getMessage()]
    assert not [
        record
        for record in collect.records
        if record.name.split(".")[0] in PINNED and record.levelno < logging.WARNING
    ]
    # The server's own loggers do follow the configured level.
    assert server_debug


@pytest.mark.parametrize("level", ["DEBUG", "INFO", "WARNING", "ERROR"])
def test_level_applies_to_the_server_and_never_lowers_pinned_libraries(level: str) -> None:
    numeric = logging.getLevelNamesMapping()[level]
    with fresh_process_logging():
        configure_logging(level)
        assert logging.getLogger("fixes_server.realtime.session").getEffectiveLevel() == numeric
        for name in PINNED:
            effective = logging.getLogger(f"{name}.command").getEffectiveLevel()
            assert effective >= max(logging.WARNING, numeric), name
