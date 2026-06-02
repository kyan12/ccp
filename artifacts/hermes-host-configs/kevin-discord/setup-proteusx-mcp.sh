#!/usr/bin/env bash
# setup-proteusx-mcp.sh — One-shot setup for ProteusX MCP on Kevin's Hermes host.
# Run this ON Kevin's machine (/Users/kyan).
#
# Prerequisites:
#   1. PROTEUSX_API_KEY in ~/.hermes/.env  (e.g. PROTEUSX_API_KEY=<key>)
#   2. proteusx-os repo cloned at ~/repos/proteusx-os (or set PROTEUSX_REPO)
#   3. Node.js >= 18, pnpm available
#
# Usage: bash setup-proteusx-mcp.sh

set -euo pipefail

HERMES_HOME="${HOME}/.hermes"
BIN_DIR="${HERMES_HOME}/bin"
ENV_FILE="${HERMES_HOME}/.env"
CONFIG_FILE="${HERMES_HOME}/config.yaml"
REPO_DIR="${PROTEUSX_REPO:-${HOME}/repos/proteusx-os}"
WRAPPER="${BIN_DIR}/proteusx-mcp.sh"

echo "=== ProteusX MCP Setup for Kevin's Hermes Host ==="

# 1. Validate .env has API key (without printing it)
echo "[1/6] Checking PROTEUSX_API_KEY in ${ENV_FILE}..."
if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: ${ENV_FILE} not found. Create it and add PROTEUSX_API_KEY from 1Password or your secrets manager."
  exit 1
fi
if ! grep -q '^PROTEUSX_API_KEY=' "$ENV_FILE"; then
  echo "FATAL: PROTEUSX_API_KEY not found in ${ENV_FILE}. Add it from 1Password or your secrets manager."
  exit 1
fi
echo "  PROTEUSX_API_KEY=REDACTED (present)"

# 2. Build MCP server from current origin/main
echo "[2/6] Building MCP server from ${REPO_DIR}..."
if [ ! -d "$REPO_DIR" ]; then
  echo "  Cloning proteusx-os..."
  git clone https://github.com/ProteusX-Consulting/proteusx-os.git "$REPO_DIR"
fi
cd "$REPO_DIR"
git fetch origin main
git checkout main
git pull origin main
pnpm install
cd packages/mcp-server
pnpm build
if [ ! -f dist/index.js ]; then
  echo "FATAL: Build failed — dist/index.js not found"
  exit 1
fi
echo "  Built: ${REPO_DIR}/packages/mcp-server/dist/index.js"

# 3. Install wrapper script
echo "[3/6] Installing wrapper script to ${WRAPPER}..."
mkdir -p "$BIN_DIR"
cat > "$WRAPPER" << 'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${HERMES_ENV_FILE:-$HOME/.hermes/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
if [ -z "${PROTEUSX_API_KEY:-}" ]; then
  echo "FATAL: PROTEUSX_API_KEY not set. Add it to $ENV_FILE" >&2
  exit 1
fi
export PROTEUSX_API_URL="${PROTEUSX_API_URL:-https://app.proteusx.ai}"
MCP_SERVER="${PROTEUSX_MCP_SERVER:-$HOME/repos/proteusx-os/packages/mcp-server/dist/index.js}"
if [ ! -f "$MCP_SERVER" ]; then
  echo "FATAL: MCP server not found at $MCP_SERVER" >&2
  exit 1
fi
exec node "$MCP_SERVER"
SCRIPT
chmod +x "$WRAPPER"
echo "  Installed and executable"

# 4. Add proteusx MCP to Hermes config (preserving existing servers)
echo "[4/6] Adding proteusx to Hermes MCP config..."
if grep -q '^\s*proteusx:' "$CONFIG_FILE" 2>/dev/null; then
  echo "  proteusx already exists in config — skipping (verify manually)"
else
  # Use hermes mcp add if available, otherwise patch config
  if command -v hermes &>/dev/null && hermes mcp add --help &>/dev/null 2>&1; then
    hermes mcp add proteusx \
      --command bash \
      --args "${WRAPPER}"
  else
    # Manual config patch — insert proteusx block under mcp_servers
    if grep -q '^mcp_servers:' "$CONFIG_FILE"; then
      # Insert after the mcp_servers: line to preserve existing servers
      sed -i.bak '/^mcp_servers:/a\
  proteusx:\
    command: bash\
    args:\
    - '"${WRAPPER}"'
' "$CONFIG_FILE" && rm -f "${CONFIG_FILE}.bak"
    else
      cat >> "$CONFIG_FILE" << YAML

mcp_servers:
  proteusx:
    command: bash
    args:
    - ${WRAPPER}
YAML
    fi
    echo "  Added proteusx to ${CONFIG_FILE}"
  fi
fi

# 5. Verify
echo "[5/6] Running verification..."
echo ""
echo "--- hermes mcp list ---"
hermes mcp list 2>&1 || echo "(hermes mcp list failed — verify manually)"
echo ""
echo "--- hermes mcp test proteusx ---"
hermes mcp test proteusx 2>&1 || echo "(hermes mcp test failed — check config/build)"
echo ""

# 6. Reload gateway
echo "[6/6] Restarting Hermes gateway..."
hermes gateway restart 2>&1 || echo "(gateway restart failed — try: hermes gateway start)"

echo ""
echo "=== Setup complete ==="
echo "Required tools to verify in mcp test output:"
echo "  - proteusx_generate_lead_audit_asset"
echo "  - proteusx_get_lead_audit_asset"
echo "  - proteusx_send_outreach_approvals"
echo "  - proteusx_list_outreach_approvals"
echo "  - proteusx_process_outreach_approval"
echo "  - proteusx_check_outreach_approval_replies"
echo ""
echo "Safe read-only test (run in Hermes):"
echo "  proteusx_list_outreach_approvals with limit=1"
