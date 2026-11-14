"""Bodies of the user endpoints."""

from __future__ import annotations

from pydantic import BaseModel

from fixes_server.models.common import User


class UserList(BaseModel):
    users: list[User]
