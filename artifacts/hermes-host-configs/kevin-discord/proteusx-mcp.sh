#!/usr/bin/env bash
# proteusx-mcp.sh — Wrapper script for ProteusX MCP server on Kevin's Hermes host.
# Install to: /Users/kyan/.hermes/bin/proteusx-mcp.sh
# Sources secrets from /Users/kyan/.hermes/.env so PROTEUSX_API_KEY
# stays out of config.yaml and Hermes logs.

set -euo pipefail

ENV_FILE="${HERMES_ENV_FILE:-$HOME/.hermes/.env}"

if [ -f "$ENV_FILE" ]; then
  # Source only lines matching KEY=VALUE (skip comments, empty lines)
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# Validate required env
if [ -z "${PROTEUSX_API_KEY:-}" ]; then
  echo "FATAL: PROTEUSX_API_KEY not set. Add it to $ENV_FILE" >&2
  exit 1
fi

# Default API URL if not overridden in .env
export PROTEUSX_API_URL="${PROTEUSX_API_URL:-https://app.proteusx.ai}"

# Path to built MCP server — adjust if repo is elsewhere
MCP_SERVER="${PROTEUSX_MCP_SERVER:-$HOME/repos/proteusx-os/packages/mcp-server/dist/index.js}"

if [ ! -f "$MCP_SERVER" ]; then
  echo "FATAL: MCP server not found at $MCP_SERVER" >&2
  echo "Run: cd ~/repos/proteusx-os && git pull origin main && pnpm install && cd packages/mcp-server && pnpm build" >&2
  exit 1
fi

exec node "$MCP_SERVER"
