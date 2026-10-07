# AI Zhagan Onboarding and Reliability Implementation Plan

> **For agentic workers:** Execute inline in this session; the user approved the prioritized improvements and requested implementation plus self-test.

**Goal:** Make the existing self-hosted connection understandable to beginners, preserve truthful verification history, and support bounded spreadsheet reading.

**Architecture:** Keep the existing local service and explicit ChatGPT OAuth flow. Add historical verification and recent-tool activity separate from live health; have the VS Code home surface one next action and a verification countdown. Extend project metadata and MCP with an explicitly bounded table reader, without widening write permissions.

**Tech Stack:** Python 3.11+, FastMCP, Node/VS Code webview, pytest, node:test.

**Spec:** The prioritized design in the preceding user-approved product review. Public ChatGPT installation, OAuth consent, and local file application remain user actions.

## Global Constraints

- Preserve read-only defaults, project path checks, and explicit review before writes.
- Do not expose local management port or secrets through MCP.
- Do not claim a ChatGPT connection is currently healthy from historical success.
- Keep the current service protocol backward compatible.

---

### Task 1: Truthful connection state

**Files:** `src/project_mcp/health.py`, `src/project_mcp/server.py`, `src/project_mcp/admin.py`, `extensions/vscode/lib/home.js`, `extensions/vscode/extension.js`, `tests/test_health.py`, `extensions/vscode/test/home.test.js`.

- [x] Add failing tests for historical verified time, recent authenticated read, and an expired live status that still shows historical success without claiming current health.
- [x] Implement small persistent verification metadata containing only timestamps and project ID, plus recent in-process activity. Keep the existing four-layer live checks unchanged.
- [x] Add challenge expiry to the home view; poll status only while a copied challenge is pending and show a countdown and regenerate action.
- [x] Verify Python health tests and VS Code home tests.

### Task 2: Clear beginner flow and project identity

**Files:** `extensions/vscode/lib/home.js`, `extensions/vscode/extension.js`, `src/project_mcp/server.py`, `src/project_mcp/admin.py`, related tests.

- [x] Add failing tests for friendly local project names and safe rename without changing the stable project ID or root.
- [x] Put the current next step at the top, display MCP endpoint and last verification separately, link to the ChatGPT Plugins page, and translate reauthorization and old-secret mismatch into specific actions.
- [x] Add an explicit project rename action; keep old project IDs valid in prompts and APIs.
- [x] Verify existing onboarding, migration, and project tests.

### Task 3: Bounded spreadsheet reading

**Files:** `src/project_mcp/workspace.py`, `src/project_mcp/server.py`, `pyproject.toml`, Windows lock/build inputs, `tests/test_workspace.py`, `tests/test_services.py`, documentation.

- [x] Add failing tests for CSV and XLSX selected sheets/row ranges, unsupported format disclosure, forbidden paths, oversized files, and truncated output.
- [x] Implement `read_table` as a separate read-only MCP tool with strict file, cell, row, and output limits. Do not execute formulas or macros.
- [x] Update project scope display and quickstart to distinguish text, table, and unsupported files.
- [x] Verify unit, MCP, and packaged-runtime behavior.

### Task 4: Release evidence

**Files:** `README.md`, `docs/quickstart.md`, `docs/compatibility.md`, `docs/self-test-report.md`.

- [x] Record the optional Secure MCP Tunnel trade-off; it requires Platform credentials and does not replace the public endpoint for distribution.
- [x] Run the repository self-test, extension checks, browser tests, and available packaging checks.
- [x] Report actual results and remaining real-account or clean-machine acceptance gaps without claiming them complete.
