"""Bodies of the friendship endpoints."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from fixes_server.models.common import FriendRequest, RequestModel, User, Uuid


class FriendList(BaseModel):
    friends: list[User]


class FriendRequestLists(BaseModel):
    incoming: list[FriendRequest]
    outgoing: list[FriendRequest]


class CreateFriendRequest(RequestModel):
    to_user_id: Uuid


class FriendRequestPending(BaseModel):
    status: Literal["pending"] = "pending"
    friend_request: FriendRequest


class FriendRequestAccepted(BaseModel):
    status: Literal["accepted"] = "accepted"
    friend: User


class FriendResponse(BaseModel):
    friend: User
