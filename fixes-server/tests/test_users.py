from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from fixes_server.ids import new_id
from tests.conftest import MakeClient
from tests.helpers import assert_error, linked_user, login, register


def test_me(client: TestClient) -> None:
    account, device = linked_user(client)
    response = client.get("/v1/users/me", headers=device.headers)
    assert response.status_code == 200
    assert response.json() == {
        "id": account.id,
        "username": account.username,
        "avatar_url": None,
        "identity_key": account.identity_key,
    }


def test_user_by_id(client: TestClient) -> None:
    _, device = linked_user(client)
    other = register(client)
    response = client.get(f"/v1/users/{other.id}", headers=device.headers)
    assert response.status_code == 200
    assert response.json() == {"id": other.id, "username": other.username, "avatar_url": None}
    assert_error(client.get(f"/v1/users/{new_id()}", headers=device.headers), 404, "not_found")
    assert_error(client.get(f"/v1/users/{other.id}"), 401, "unauthorized")


def test_search(client: TestClient) -> None:
    me = register(client, "Searcher_zq")
    device = login(client, me)
    for name in ("zq_Delta", "ZQ_alpha", "beta_zq_x", "zz_unrelated"):
        register(client, name)
    response = client.get("/v1/users", params={"q": "zQ"}, headers=device.headers)
    assert response.status_code == 200
    names = [u["username"] for u in response.json()["users"]]
    # Case-insensitive substring, ordered by username, without the caller.
    assert names == ["beta_zq_x", "ZQ_alpha", "zq_Delta"]
    assert all(set(u) == {"id", "username", "avatar_url"} for u in response.json()["users"])


def test_search_limit_is_20(client: TestClient) -> None:
    me = register(client)
    device = login(client, me)
    for i in range(22):
        register(client, f"lim_{i:02d}_user")
    users = client.get("/v1/users", params={"q": "lim_"}, headers=device.headers).json()["users"]
    assert [u["username"] for u in users] == [f"lim_{i:02d}_user" for i in range(20)]


@pytest.mark.parametrize("q", ["", "a" * 31, "has space", ".*", "a-b", "ü"])
def test_search_validation(client: TestClient, q: str) -> None:
    _, device = linked_user(client)
    response = client.get("/v1/users", params={"q": q}, headers=device.headers)
    assert "q" in assert_error(response, 422, "validation_error")["fields"]


def test_q_and_ids_are_exclusive_and_one_is_required(client: TestClient) -> None:
    account, device = linked_user(client)
    both = client.get("/v1/users", params={"q": "abc", "ids": account.id}, headers=device.headers)
    assert set(assert_error(both, 422, "validation_error")["fields"]) == {"q", "ids"}
    neither = client.get("/v1/users", headers=device.headers)
    assert_error(neither, 422, "validation_error")


def test_ids_lookup(client: TestClient) -> None:
    me, device = linked_user(client)
    first, second = register(client), register(client)
    ids = ",".join([second.id, new_id(), first.id, me.id, second.id])
    response = client.get("/v1/users", params={"ids": ids}, headers=device.headers)
    assert response.status_code == 200
    assert [u["id"] for u in response.json()["users"]] == [second.id, first.id, me.id]


@pytest.mark.parametrize(
    "ids",
    [
        "",
        "not-a-uuid",
        "A0B1C2D3-0000-4000-8000-000000000000",
        ",".join([new_id()] * 101),
        f"{new_id()},",
    ],
)
def test_ids_validation(client: TestClient, ids: str) -> None:
    _, device = linked_user(client)
    response = client.get("/v1/users", params={"ids": ids}, headers=device.headers)
    assert "ids" in assert_error(response, 422, "validation_error")["fields"]


def test_hundred_ids_allowed(client: TestClient) -> None:
    _, device = linked_user(client)
    ids = ",".join(new_id() for _ in range(100))
    response = client.get("/v1/users", params={"ids": ids}, headers=device.headers)
    assert response.status_code == 200
    assert response.json() == {"users": []}


def test_lookup_rate_limit(make_client: MakeClient) -> None:
    with make_client(rate_limit_user_lookup="2/60") as client:
        account, device = linked_user(client)
        assert (
            client.get("/v1/users", params={"q": "abc"}, headers=device.headers).status_code == 200
        )
        assert (
            client.get("/v1/users", params={"ids": account.id}, headers=device.headers).status_code
            == 200
        )
        limited = client.get("/v1/users", params={"q": "abc"}, headers=device.headers)
        assert_error(limited, 429, "rate_limited")
        assert int(limited.headers["Retry-After"]) >= 1
        # Per user: someone else is unaffected.
        _, other = linked_user(client)
        assert (
            client.get("/v1/users", params={"q": "abc"}, headers=other.headers).status_code == 200
        )
