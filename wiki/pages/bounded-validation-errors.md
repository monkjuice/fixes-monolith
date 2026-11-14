---
title: 422 responses must not grow with the body
type: gotcha
summary: "Pydantic reports every unknown key and FastAPI builds all reports before the 422 handler, so a 9 MiB envelope batch of ~786k unknown keys cost seconds of event-loop time and produced a 34 MB 422 that a never-reading client could pin in memory; 422 details now list at most 20 fields (omitted_fields counts the rest) and batches with far too many keys are refused before validation (protocol rev 2.2 §5.1)."
tags: [v2, server, fastapi, pydantic, security, abuse-limits, gotcha]
sources: []
updated: 2026-11-13
---

# 422 responses must not grow with the body

Found by code-review round 3; fixed as of 2026-11-13 (`docs/protocol.md` rev 2.2 §5.1).

## Pitfall

Request models forbid unknown fields, and pydantic emits one error per offending key. FastAPI builds the whole error
list before any exception handler runs, so a 9 MiB `POST /v1/envelopes` body holding ~786 000 unknown keys meant
~800 000 error objects (~1 GB, seconds of event-loop time) and a 34 MB 422 body. A client that never reads its
responses could keep such bodies pinned in server memory.

## Fix (`fixes-server/src/fixes_server/`)

- **Capped details** (`errors.py`, `validation_details()`): `details.fields` names at most 20 fields (names cut to 64
  characters, each distinct message once); `details.omitted_fields` counts the rest. A 422 stays a few KB whatever
  the body. Inputs are never echoed (they may contain passwords).
- **Cheap pre-check** (`models/envelopes.py`, `has_too_many_keys()`): an object (the batch, or one of its first 101
  envelopes) with more than `MAX_UNKNOWN_KEYS` (10) keys beyond its model's fields is refused whole as 422
  `details.fields.body = "has too many fields"`, before pydantic sees it. It is hooked in through a custom route class
  (`_BatchRoute` in `routers/envelopes.py`) whose `Request.json()` checks right after decoding, so the route keeps its
  typed body and OpenAPI schema.

## Rule

Error output and validation work must be bounded independently of the input size; check cheaply before handing an
attacker-sized body to pydantic. Related to, but separate from, the pre-auth parsing cost in
[FastAPI parses the body before auth](fastapi-parses-body-before-auth.md).

Related: [fixes-server](fixes-server.md), [v2 architecture](v2-architecture.md).
