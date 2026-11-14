"""The single error body of protocol §5.1 and the handlers that force every failure into it."""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)

_GENERIC_CODES: dict[int, str] = {
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    413: "payload_too_large",
    429: "rate_limited",
    503: "service_unavailable",
}
_BEARER_CHALLENGE = {"WWW-Authenticate": "Bearer"}
# A body full of unknown keys gets one error per key, and unknown keys are named: listing them
# all, or naming a huge one in full, would make a 422 as large as the request or larger.
MAX_REPORTED_FIELDS = 20
MAX_FIELD_NAME_LENGTH = 64


class ApiError(StarletteHTTPException):
    """An error with a stable machine-readable ``code``.

    Subclassing Starlette's HTTPException matters: FastAPI re-raises that type unchanged
    while it reads request bodies, so an ApiError raised from inside ``receive`` (the body
    size limit) still reaches the client as itself instead of a generic 400.
    """

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(status_code=status_code, detail=message, headers=dict(headers or {}))
        self.code = code
        self.message = message
        self.details: dict[str, Any] = dict(details or {})


def error_body(code: str, message: str, details: Mapping[str, Any] | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": dict(details or {})}}


def error_response(
    status_code: int,
    code: str,
    message: str,
    *,
    details: Mapping[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        error_body(code, message, details), status_code=status_code, headers=headers
    )


# Constructors for the codes in the §5.1 table, so call sites stay short and consistent.


def unauthorized(message: str = "Missing, invalid or expired access token") -> ApiError:
    return ApiError(401, "unauthorized", message, headers=_BEARER_CHALLENGE)


def invalid_credentials() -> ApiError:
    return ApiError(401, "invalid_credentials", "Wrong username or password")


def invalid_refresh_token() -> ApiError:
    return ApiError(401, "invalid_refresh_token", "Unknown, expired or reused refresh token")


def device_revoked() -> ApiError:
    return ApiError(
        401, "device_revoked", "This device has been signed out", headers=_BEARER_CHALLENGE
    )


def forbidden(message: str = "Forbidden") -> ApiError:
    return ApiError(403, "forbidden", message)


def not_friends() -> ApiError:
    return ApiError(403, "not_friends", "That user is not your friend")


def device_not_linked() -> ApiError:
    return ApiError(
        403, "device_not_linked", "This device must be linked before it can message other users"
    )


def not_found(message: str = "Not found") -> ApiError:
    return ApiError(404, "not_found", message)


def conflict(code: str, message: str, details: Mapping[str, Any] | None = None) -> ApiError:
    return ApiError(409, code, message, details=details)


def bad_request(code: str, message: str) -> ApiError:
    return ApiError(400, code, message)


def payload_too_large(message: str = "Request body is too large") -> ApiError:
    return ApiError(413, "payload_too_large", message)


def rate_limited(retry_after_seconds: int) -> ApiError:
    return ApiError(
        429,
        "rate_limited",
        "Too many requests, try again later",
        details={"retry_after": retry_after_seconds},
        headers={"Retry-After": str(retry_after_seconds)},
    )


def validation_error(fields: Mapping[str, str]) -> ApiError:
    return ApiError(422, "validation_error", "Request is invalid", details={"fields": dict(fields)})


def _field_name(loc: tuple[int | str, ...]) -> str:
    parts = list(loc)
    if parts and parts[0] in {"body", "query", "path", "header", "cookie"}:
        source = parts.pop(0)
        # JSON decode errors carry a character offset instead of a field name.
        if not parts or all(isinstance(part, int) for part in parts):
            return str(source)
    return ".".join(str(part) for part in parts) or "body"


def _shortened(name: str) -> str:
    if len(name) <= MAX_FIELD_NAME_LENGTH:
        return name
    return name[: MAX_FIELD_NAME_LENGTH - 3] + "..."


def validation_details(errors: Iterable[Any]) -> dict[str, Any]:
    """The ``details`` of a 422: ``fields`` maps at most ``MAX_REPORTED_FIELDS`` field paths
    (cut to ``MAX_FIELD_NAME_LENGTH`` characters) to their distinct messages, and
    ``omitted_fields`` counts the other invalid fields, if any. Inputs are never echoed: they
    may contain passwords."""
    messages: dict[str, list[str]] = {}
    omitted: set[str] = set()
    for error in errors:
        name = _shortened(_field_name(tuple(error.get("loc", ()))))
        message = str(error.get("msg", "Invalid value"))
        if name in messages:
            if message not in messages[name]:
                messages[name].append(message)
        elif len(messages) < MAX_REPORTED_FIELDS:
            messages[name] = [message]
        else:
            omitted.add(name)
    details: dict[str, Any] = {
        "fields": {name: "; ".join(found) for name, found in messages.items()}
    }
    if omitted:
        details["omitted_fields"] = len(omitted)
    return details


async def _unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    # Logged with the traceback for operators; the client only ever sees a generic message.
    logger.error("unhandled error on %s %s", request.method, request.url.path, exc_info=exc)
    return error_response(500, "internal_error", "Internal server error")


# Starlette types every handler as (Request, Exception); each one narrows the type and treats
# anything unexpected as an unhandled error rather than trusting the registration.


async def _api_error_handler(request: Request, exc: Exception) -> JSONResponse:
    if not isinstance(exc, ApiError):
        return await _unhandled_error_handler(request, exc)
    return error_response(
        exc.status_code, exc.code, exc.message, details=exc.details, headers=exc.headers
    )


async def _http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    if not isinstance(exc, StarletteHTTPException):
        return await _unhandled_error_handler(request, exc)
    if exc.status_code == 400:
        # Framework 400s come from unparseable bodies (e.g. broken multipart); §5.1 calls that
        # a validation error.
        return error_response(
            422,
            "validation_error",
            "Request body could not be parsed",
            details={"fields": {"body": "could not be parsed"}},
        )
    status = exc.status_code
    code = _GENERIC_CODES.get(status, "internal_error" if status >= 500 else "http_error")
    try:
        message = HTTPStatus(status).phrase
    except ValueError:
        message = "Error"
    return error_response(status, code, message, headers=exc.headers)


async def _validation_error_handler(request: Request, exc: Exception) -> JSONResponse:
    if not isinstance(exc, RequestValidationError):
        return await _unhandled_error_handler(request, exc)
    return error_response(
        422, "validation_error", "Request is invalid", details=validation_details(exc.errors())
    )


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _api_error_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)
    app.add_exception_handler(Exception, _unhandled_error_handler)
