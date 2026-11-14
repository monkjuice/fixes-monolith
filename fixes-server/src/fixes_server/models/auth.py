"""Bodies of the ``/v1/auth`` endpoints."""

from __future__ import annotations

from pydantic import Field

from fixes_server.models.common import (
    DeviceName,
    LoginPassword,
    LoginUsername,
    Me,
    MyDevice,
    Password,
    PublicKeyB64,
    RequestModel,
    SignatureB64,
    Tokens,
    Username,
)
from fixes_server.security.refresh_tokens import REFRESH_TOKEN_LENGTH


class RegisterRequest(RequestModel):
    username: Username
    password: Password


class NewDevice(RequestModel):
    name: DeviceName
    public_key: PublicKeyB64


class LoginRequest(RequestModel):
    username: LoginUsername
    password: LoginPassword
    device: NewDevice


class LoginResponse(Tokens):
    user: Me
    device: MyDevice


class RefreshRequest(RequestModel):
    refresh_token: str = Field(min_length=1, max_length=REFRESH_TOKEN_LENGTH * 2)


class PasswordChangeRequest(RequestModel):
    current_password: LoginPassword
    new_password: Password


class ResetIdentityRequest(RequestModel):
    password: LoginPassword
    identity_key: PublicKeyB64
    device_certificate: SignatureB64
