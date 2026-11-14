"""The §5.1 error body for framework errors (404, 405, 422, 500) and authentication failures."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import ANY

import jwt
from starlette.testclient import TestClient

from fixes_server.config import Settings
from fixes_server.errors import MAX_FIELD_NAME_LENGTH, MAX_REPORTED_FIELDS
from fixes_server.ids import new_id
from fixes_server.main import create_app
from tests.conftest import MakeSettings
from tests.helpers import ClientIpOverride, assert_error, linked_user, random_password


def test_unknown_path_is_404(client: TestClient) -> None:
    assert_error(client.get("/v1/nothing-here"), 404, "not_found")


def test_wrong_method_is_405_with_allow_header(client: TestClient) -> None:
    response = client.delete("/healthz")
    assert_error(response, 405, "method_not_allowed")
    assert response.headers["allow"] == "GET"


def test_validation_error_lists_fields_without_echoing_input(client: TestClient) -> None:
    password = random_password()
    response = client.post("/v1/auth/register", json={"username": "a!", "password": password})
    details = assert_error(response, 422, "validation_error")
    assert set(details["fields"]) == {"username"}
    assert password not in response.text
    assert "a!" not in response.text


def test_nested_field_names_and_missing_fields(client: TestClient) -> None:
    response = client.post(
        "/v1/auth/login", json={"username": "abc", "password": "x", "device": {"name": ""}}
    )
    details = assert_error(response, 422, "validation_error")
    assert set(details["fields"]) == {"device.name", "device.public_key"}


def test_malformed_json_is_validation_error(client: TestClient) -> None:
    response = client.post(
        "/v1/auth/register", content=b"{not json", headers={"Content-Type": "application/json"}
    )
    details = assert_error(response, 422, "validation_error")
    assert "body" in details["fields"]


def test_unknown_fields_are_rejected(client: TestClient) -> None:
    response = client.post(
        "/v1/auth/register",
        json={"username": "someone", "password": random_password(), "admin": True},
    )
    details = assert_error(response, 422, "validation_error")
    assert "admin" in details["fields"]


def test_a_validation_error_lists_a_bounded_number_of_fields(client: TestClient) -> None:
    """Each unknown key is an error of its own: listing them all would make a 422 several
    times larger than the request, on routes that need no account at all."""
    password = random_password()
    extra = {f"k{index:04d}": 0 for index in range(5000)}
    response = client.post(
        "/v1/auth/register", json={"username": "someone", "password": password, **extra}
    )
    assert len(response.request.content) < 64 * 1024
    details = assert_error(response, 422, "validation_error")
    assert len(response.content) < 8 * 1024
    assert len(details["fields"]) == MAX_REPORTED_FIELDS
    assert set(details["fields"]) <= set(extra)
    assert details["omitted_fields"] == len(extra) - MAX_REPORTED_FIELDS
    assert password not in response.text
    # Only an error with fields left out says so.
    few = client.post("/v1/auth/register", json={"username": "a!", "password": password, "x": 1})
    assert assert_error(few, 422, "validation_error") == {
        "fields": {"username": ANY, "x": "Extra inputs are not permitted"}
    }


def test_a_validation_error_names_fields_briefly(client: TestClient) -> None:
    """Unknown keys are named, so a huge one would come back whole: names are cut short, and
    names that become the same carry each message once."""
    huge = "k" * 30_000
    response = client.post(
        "/v1/auth/register",
        json={"username": "someone", "password": random_password(), huge + "1": 0, huge + "2": 0},
    )
    details = assert_error(response, 422, "validation_error")
    assert len(response.content) < 1024
    [(name, message)] = details["fields"].items()
    assert len(name) == MAX_FIELD_NAME_LENGTH
    assert name.startswith("kkkk")
    assert message == "Extra inputs are not permitted"


def test_invalid_path_id_is_validation_error(client: TestClient) -> None:
    _, device = linked_user(client)
    response = client.get("/v1/users/not-a-uuid", headers=device.headers)
    assert "user_id" in assert_error(response, 422, "validation_error")["fields"]


def test_unhandled_exception_is_generic_500(make_settings: MakeSettings) -> None:
    app = create_app(make_settings())

    async def explode() -> None:
        raise RuntimeError("secret internal detail")

    app.add_api_route("/explode", explode)
    with TestClient(ClientIpOverride(app), raise_server_exceptions=False) as client:
        response = client.get("/explode")
    assert_error(response, 500, "internal_error")
    assert "secret internal detail" not in response.text


def test_missing_token_is_unauthorized(client: TestClient) -> None:
    response = client.get("/v1/users/me")
    assert_error(response, 401, "unauthorized")
    assert response.headers["www-authenticate"] == "Bearer"


def test_garbage_and_wrong_scheme_tokens(client: TestClient) -> None:
    assert_error(
        client.get("/v1/users/me", headers={"Authorization": "Bearer nope"}), 401, "unauthorized"
    )
    assert_error(
        client.get("/v1/users/me", headers={"Authorization": "Basic dXNlcjpwYXNz"}),
        401,
        "unauthorized",
    )


def _forge(settings: Settings, **claims: object) -> dict[str, str]:
    now = datetime.now(UTC)
    payload = {
        "sub": new_id(),
        "did": new_id(),
        "typ": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=5)).timestamp()),
        **claims,
    }
    token = jwt.encode(payload, settings.jwt_secret.get_secret_value(), algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


def test_expired_wrong_type_and_unknown_device_tokens(
    client: TestClient, settings: Settings
) -> None:
    account, device = linked_user(client)
    past = datetime.now(UTC) - timedelta(minutes=20)
    expired = _forge(
        settings,
        sub=account.id,
        did=device.id,
        iat=int(past.timestamp()),
        exp=int((past + timedelta(minutes=15)).timestamp()),
    )
    assert_error(client.get("/v1/users/me", headers=expired), 401, "unauthorized")
    wrong_type = _forge(settings, sub=account.id, did=device.id, typ="refresh")
    assert_error(client.get("/v1/users/me", headers=wrong_type), 401, "unauthorized")
    unknown_device = _forge(settings, sub=account.id)
    assert_error(client.get("/v1/users/me", headers=unknown_device), 401, "unauthorized")
    other_user = _forge(settings, did=device.id)
    assert_error(client.get("/v1/users/me", headers=other_user), 401, "unauthorized")
    # The same claims signed correctly are accepted, proving the forger itself is sound.
    valid = _forge(settings, sub=account.id, did=device.id)
    assert client.get("/v1/users/me", headers=valid).status_code == 200


def test_token_signed_with_another_secret_is_rejected(
    client: TestClient, make_settings: MakeSettings
) -> None:
    account, device = linked_user(client)
    other = make_settings()
    forged = _forge(other, sub=account.id, did=device.id)
    assert_error(client.get("/v1/users/me", headers=forged), 401, "unauthorized")
