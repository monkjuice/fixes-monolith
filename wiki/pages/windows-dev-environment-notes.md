---
title: Windows development environment notes
type: gotcha
summary: "On the Windows dev machine Uvicorn exits with code 3 after Ctrl+Break even on a clean shutdown, and NODE_TLS_REJECT_UNAUTHORIZED=0 is set globally (an insecure machine setting, not the project's)."
tags: [windows, environment, server, app, gotcha]
sources: []
updated: 2026-11-13
---

# Windows development environment notes

Observed on the Windows 10 development machine (2026-11).

- **Uvicorn exit code 3**: stopped with Ctrl+Break (`CTRL_BREAK_EVENT`, which `fixes-server/scripts/e2e_server.py`
  sends because the server runs in its own process group), Uvicorn exits with code 3 even after a clean shutdown.
  Do not read it as a failure; the launcher only prints the code, and its own status comes from the test command and
  the leftover-envelope check.
- **`NODE_TLS_REJECT_UNAUTHORIZED=0` is set globally** on that machine. It disables TLS certificate verification for
  every Node process (npm, Jest, the e2e suite) and is insecure. It is an environment setting, not something the
  project needs or sets: do not rely on it, and expect Node to print a warning about it.

Related: [Run the server locally](run-server-locally.md), [Run the e2e suite](run-e2e-suite.md),
[Run the app checks](run-app-checks.md).
