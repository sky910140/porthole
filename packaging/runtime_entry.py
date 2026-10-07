"""PyInstaller entry point for the standalone Porthole runtime."""

from project_mcp.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
