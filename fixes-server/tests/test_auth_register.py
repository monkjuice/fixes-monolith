from __future__ import annotations

from typing import Any

import pytest
from pymongo.database import Database
from starlette.testclient import TestClient

from fixes_server.ids import is_uuid4
from tests.conftest import MakeClient
from tests.helpers import CLIENT_IP_HEADER, assert_error, random_password, random_username


def test_register_ok(client: TestClient, db: Database[dict[str, Any]]) -> None:
    username = "Alice_" + random_username("x")[-6:]
    password = random_password()
    response = client.post("/v1/auth/register", json={"username": username, "password": password})
    assert response.status_code == 201, response.text
    user = response.json()["user"]
    assert set(user) == {"id", "username", "avatar_url"}
    assert is_uuid4(user["id"])
    assert user["username"] == username
    assert user["avatar_url"] is None

    stored = db.users.find_one({"_id": user["id"]})
    assert stored is not None
    assert stored["username_lower"] == username.lower()
    assert stored["identity_key"] is None
    assert password not in str(stored)
    # argon2id with the §5.5 parameters.
    assert stored["password_hash"].startswith("$argon2id$v=19$m=65536,t=3,p=1$")


def test_duplicate_username_is_case_insensitive(client: TestClient) -> None:
    username = random_username("Bob")
    first = client.post(
        "/v1/auth/register", json={"username": username, "password": random_password()}
    )
    assert first.status_code == 201
    for variant in (username, username.upper(), username.lower()):
        response = client.post(
            "/v1/auth/register", json={"username": variant, "password": random_password()}
        )
        assert_error(response, 409, "username_taken")


@pytest.mark.parametrize(
    "username",
    ["ab", "a" * 31, "has space", "dash-name", "dot.name", "héllo", "abc\n", "", "émoji😀"],
)
def test_invalid_usernames(client: TestClient, username: str) -> None:
    response = client.post(
        "/v1/auth/register", json={"username": username, "password": random_password()}
    )
    assert "username" in assert_error(response, 422, "validation_error")["fields"]


@pytest.mark.parametrize("username", ["abc", "A" * 30, "under_score_9"])
def test_valid_username_edges(client: TestClient, username: str) -> None:
    response = client.post(
        "/v1/auth/register", json={"username": username, "password": random_password()}
    )
    assert response.status_code == 201, response.text


@pytest.mark.parametrize("password", ["", "short77", "x" * 129])
def test_invalid_passwords(client: TestClient, password: str) -> None:
    response = client.post(
        "/v1/auth/register", json={"username": random_username(), "password": password}
    )
    assert "password" in assert_error(response, 422, "validation_error")["fields"]


@pytest.mark.parametrize("length", [8, 128])
def test_password_length_edges(client: TestClient, length: int) -> None:
    response = client.post(
        "/v1/auth/register", json={"username": random_username(), "password": "p" * length}
    )
    assert response.status_code == 201, response.text


def test_wrong_types_are_rejected(client: TestClient) -> None:
    response = client.post("/v1/auth/register", json={"username": 12345, "password": 12345678})
    assert set(assert_error(response, 422, "validation_error")["fields"]) == {
        "username",
        "password",
    }


def test_register_rate_limit_per_ip(make_client: MakeClient) -> None:
    with make_client(rate_limit_register="2/3600") as client:
        for _ in range(2):
            ok = client.post(
                "/v1/auth/register",
                json={"username": random_username(), "password": random_password()},
            )
            assert ok.status_code == 201
        limited = client.post(
            "/v1/auth/register", json={"username": random_username(), "password": random_password()}
        )
        assert_error(limited, 429, "rate_limited")
        retry_after = int(limited.headers["Retry-After"])
        assert 1 <= retry_after <= 3600
        # Another client IP has its own bucket.
        other_ip = client.post(
            "/v1/auth/register",
            json={"username": random_username(), "password": random_password()},
            headers={CLIENT_IP_HEADER: "203.0.113.9"},
        )
        assert other_ip.status_code == 201
