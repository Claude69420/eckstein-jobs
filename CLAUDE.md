# Eckstein Jobs — instructions for Claude

**Read `APP_MASTER.md` in this folder first** (and again after any context compaction). It is the single source of truth:
architecture, operations runbook, troubleshooting, design decisions, roadmap / in-flight work, and the full CHANGELOG.

Rules:
- Every change to this app gets a CHANGELOG entry in `APP_MASTER.md` in the **same commit** (date, what, why, files, commit).
- Keep the ROADMAP / IN-FLIGHT section current while a feature is mid-build, so a resumed session can pick up exactly where work stopped.
- This repo is **public**: never commit secret values, tokens, or personal contact details.
- Commands given to Riley must be PowerShell-safe (no `&&`, no `/c/...` paths).
