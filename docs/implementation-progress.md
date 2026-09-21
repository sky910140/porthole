# Implementation ledger

Plan: docs/superpowers/plans/2026-09-18-web-chat-project-mcp.md

- User authorized implementation and self-tests on 2026-09-19.
- No existing Git repository or application: implement in the supplied dedicated folder.
- Core task owns workspace.py/git_read.py and their tests; adapter task owns extensions/vscode; integration task owns remaining files.
- Shared contracts: explicit project_id; context session_id; readonly filesystem tools; local management on 8766, remote MCP on 8765; local admin token never used as remote MCP token.
- Ruling: external domain/OAuth credentials are absent. Implement OAuth configuration and fail-closed public mode; validate local protocol with separate bearer token. Real account acceptance remains external.
- Ruling: no automated writing or arbitrary commands in first release, consistent with staged plan.
- Complete: core tools, service/auth/context/management, VS Code adapter.
- Core uses bounded Python literal search instead of ripgrep to remove an installation dependency; language-level semantic search remains optional.
- Review fixes: dynamic state/config path exclusions, encrypted OAuth persistence, narrow-path and cross-boundary sensitive Git renames; extension one-based lines, verified project roots, independent sessions, autosync focus race and in-flight disconnect cleanup.
- Validation: Python 59 passed / 1 Windows symlink privilege skip, statement coverage 87.26%; actual Windows junction test passed. Real HTTP MCP client and lifecycle passed.
- Browser management E2E passed: bad/good token, project CRUD, XSS-as-text, memory-only token, mobile layout and reload isolation; screenshots in artifacts/.
- Extension unit and real isolated Extension Host tests passed, including multiple roots, unsaved buffers, delayed GET/PUT cleanup. VSIX and Python wheel generated.
- Final disconnect race closed by folder clearing locks and global shutdown guard; concurrent new publish/autosync regression passed twice, followed by an independent third Extension Host pass. Scoped reviewer confirmed closure.
- Delivery evidence and exact artifact hashes: docs/self-test-report.md.
- External acceptance intentionally pending per user: no fixed domain or OAuth App supplied; no public tunnel opened; no ChatGPT/Claude account login or quota claim verified.
- Dedicated directory has no Git repository; no commit, push, PR or worktree cleanup performed.
