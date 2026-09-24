# Zero-command onboarding implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Windows user can install one VSIX, select a project folder in VS Code, authorize read-only access, and see the exact next connection step without PowerShell, copied tokens, or typed absolute paths.

**Architecture:** Package the verified Windows x64 runtime with the VSIX for this offline candidate. The extension installs it into its managed user directory with a checked file manifest and atomic replacement, then reuses the existing local pairing protocol. A VS Code home panel owns folder selection, project switching, access scope, and four-layer connection status. The localhost browser administration page remains available for advanced settings. Public ChatGPT access remains a separate self-hosted prerequisite.

**Tech Stack:** VS Code extension API and Node.js; Python/FastMCP service; PowerShell only in the release build script; Node test runner, VS Code Extension Host integration, pytest.

**Spec:** `docs/superpowers/specs/2026-09-21-ai-zhagan-product-design.md`, especially sections 4 and 9, plus the user-approved iteration described on 2026-09-23: no-command install, visual project selection, actionable connection state, and clean-machine quality gates.

## Global constraints

- Windows 11 x64 and local VS Code Stable are the supported candidate environment.
- Default project mode is read-only. Replacing a root requires a new project authorization; it must not silently transfer an existing project ID or pending change.
- The management token stays in VS Code SecretStorage and never enters a webview, URL, workspace file, or model prompt.
- A bundled runtime is accepted only after version, protocol, file path, size, and SHA-256 validation. A failed install keeps the previous runtime.
- No claim of current ChatGPT connectivity without a real authenticated `verify_connection` call.

---

### Task 1: Offline runtime installed by the extension

**Files:** `extensions/vscode/lib/service-manager.js`, `extensions/vscode/test/service-manager.test.js`, `extensions/vscode/extension.js`, `scripts/package-extension.ps1`, `extensions/vscode/.vscodeignore`, `docs/runtime.md`.

**Interfaces:** `installBundledRuntime(bundleRoot, installRoot, expectedVersion)` verifies a manifest and returns the installed executable path. `ensureManagedRuntime()` in the extension uses it before local pairing.

- [x] Write tests with real temporary files: valid bundle installs; altered bytes, traversal path, wrong architecture, and incompatible protocol fail before replacing an existing install; repeated install reuses a valid receipt.
- [x] Run the targeted test and observe failures for the missing behavior.
- [x] Implement manifest validation, checked copying, atomic swap, and managed-install wiring. Keep the existing online-download helper unmodified for future trusted-origin releases.
- [x] Add a packaging script that builds a VSIX containing the runtime directory and generated per-file manifest; stage only known build outputs and record hashes.
- [x] Run unit tests, package the VSIX, inspect its contents, and launch a clean user-data Extension Host without Python or Node on its service PATH.

### Task 2: Native folder selection and project lifecycle

**Files:** `extensions/vscode/lib/projects.js`, `extensions/vscode/test/projects.test.js`, `extensions/vscode/extension.js`, `extensions/vscode/package.json`.

**Interfaces:** A project controller uses the existing authenticated local API to list/add/pause/remove projects. It accepts an absolute folder URI from `showOpenDialog`, derives a stable ID, previews the selected scope, and requires confirmation before authorization. A new path produces a new ID.

- [x] Write tests for folder validation, duplicate selection, root-change isolation, and project actions; observe the intended failures.
- [x] Implement `AI Zhagan: 选择或授权项目` with a native folder picker. Bind an open workspace automatically; an external folder can be registered for reading and opened in VS Code for review/apply.
- [x] Add a project switcher that selects only real authorized projects and does not infer another window's project.
- [x] Run focused unit and Extension Host tests.

### Task 3: One home panel with actionable connection status

**Files:** `extensions/vscode/lib/home.js`, `extensions/vscode/test/home.test.js`, `extensions/vscode/extension.js`, `extensions/vscode/package.json`, `extensions/vscode/README.md`, `docs/quickstart.md`.

**Interfaces:** The home panel displays project name/root/scope, local service, transport, OAuth, and real tool-call state from `/api/status`. Each state has one primary action. Native extension actions perform folder picking and open the appropriate site; the webview never receives a credential.

- [x] Write state-mapping tests for no runtime, no project, local-only, transport failure, OAuth failure, verified, and expired states; observe failures.
- [x] Implement a VS Code webview with a restrictive CSP, accessible buttons, a folder-picker message handler, and a refresh action. Show the verified project identifier and safe question template without copying credentials.
- [x] Update the three-step onboarding command to open the home panel at the proper step and preserve progress.
- [x] Run UI logic, Extension Host, and browser/management regressions.

### Task 4: Candidate verification and truthful release status

**Files:** `docs/acceptance/v1.md`, `docs/compatibility.md`, `README.md`, `README.en.md`, new `docs/acceptance/zero-command-onboarding.md`.

- [x] Run `npm run check`, VS Code Extension Host integration, Python pytest and lint, packaging checks, and a real bundled-runtime local read in an isolated user directory.
- [x] Verify that corrupt bundle installation retains an existing install and that reauthorizing another root does not inherit write permissions or pending changes.
- [x] Record exact commands/results and remaining external gates: clean VM, real ChatGPT account, new-user study, signing/public release, and 24-hour soak. Do not mark these complete without actual evidence.
- [x] Update user docs around the new no-command path and keep developer scripts in an advanced section.
