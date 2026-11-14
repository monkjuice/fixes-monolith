"""Conversion of stored documents into the public shapes of protocol §5.2."""

from __future__ import annotations

from fixes_server.documents import DeviceDoc, EnvelopeDoc, FriendRequestDoc, UserDoc
from fixes_server.encoding import encode_base64
from fixes_server.models.common import (
    DeviceInfo,
    Envelope,
    FriendRequest,
    Me,
    MyDevice,
    PeerDevice,
    User,
)
from fixes_server.storage import AvatarStorage


def user_out(user: UserDoc, storage: AvatarStorage) -> User:
    avatar_key = user["avatar_key"]
    return User(
        id=user["_id"],
        username=user["username"],
        avatar_url=storage.avatar_url(avatar_key) if avatar_key else None,
    )


def me_out(user: UserDoc, storage: AvatarStorage) -> Me:
    public = user_out(user, storage)
    return Me(
        id=public.id,
        username=public.username,
        avatar_url=public.avatar_url,
        identity_key=user["identity_key"],
    )


def my_device_out(device: DeviceDoc, current_device_id: str) -> MyDevice:
    return MyDevice(
        id=device["_id"],
        name=device["name"],
        public_key=device["public_key"],
        certificate=device["certificate"],
        created_at=device["created_at"],
        last_seen_at=device["last_seen_at"],
        current=device["_id"] == current_device_id,
    )


def peer_device_out(device: DeviceDoc) -> PeerDevice:
    certificate = device["certificate"]
    if certificate is None:
        raise ValueError("only linked devices are shown to peers")
    return PeerDevice(id=device["_id"], public_key=device["public_key"], certificate=certificate)


def device_info_out(device: DeviceDoc) -> DeviceInfo:
    return DeviceInfo(
        id=device["_id"],
        user_id=device["user_id"],
        public_key=device["public_key"],
        certificate=device["certificate"],
        revoked_at=device["revoked_at"],
    )


def friend_request_out(
    request: FriendRequestDoc, users: dict[str, UserDoc], storage: AvatarStorage
) -> FriendRequest:
    return FriendRequest(
        id=request["_id"],
        from_user=user_out(users[request["from_user_id"]], storage),
        to_user=user_out(users[request["to_user_id"]], storage),
        created_at=request["created_at"],
    )


def envelope_out(envelope: EnvelopeDoc) -> Envelope:
    return Envelope(
        id=str(envelope["_id"]),
        sender_user_id=envelope["sender_user_id"],
        sender_device_id=envelope["sender_device_id"],
        recipient_device_id=envelope["recipient_device_id"],
        nonce=encode_base64(envelope["nonce"]),
        ciphertext=encode_base64(envelope["ciphertext"]),
        created_at=envelope["created_at"],
    )
