# ProteusX MCP — Kevin Discord Hermes Host Configuration

**Ticket**: PRO-664
**Target host**: `/Users/kyan` (Kevin's Discord Hermes)
**Status**: Host-side verification pending (Code Crab cannot access `/Users/kyan`)

## Quick start

On Kevin's machine:

```bash
# 1. Ensure PROTEUSX_API_KEY is in ~/.hermes/.env
#    Retrieve the key from 1Password (vault: ProteusX, item: MCP API Key)
#    or your team's secrets manager — never paste placeholder values.
grep -q PROTEUSX_API_KEY ~/.hermes/.env || echo "Add PROTEUSX_API_KEY=<value> to ~/.hermes/.env from 1Password"

# 2. Run setup script
bash /path/to/setup-proteusx-mcp.sh
```

Or manually:

```bash
# 1. Pull/build MCP server
cd ~/repos/proteusx-os && git pull origin main && pnpm install
cd packages/mcp-server && pnpm build

# 2. Install wrapper script
mkdir -p ~/.hermes/bin
cp proteusx-mcp.sh ~/.hermes/bin/proteusx-mcp.sh
chmod +x ~/.hermes/bin/proteusx-mcp.sh

# 3. Add to Hermes config (preserving existing servers)
hermes mcp add proteusx --command bash --args "$HOME/.hermes/bin/proteusx-mcp.sh"

# 4. Verify & reload
hermes mcp list
hermes mcp test proteusx
hermes gateway restart
```

## Files

| File | Purpose |
|------|---------|
| `proteusx-mcp.sh` | Wrapper script — sources `~/.hermes/.env` for secrets, validates env, execs the MCP server |
| `setup-proteusx-mcp.sh` | One-shot automated setup: builds, installs wrapper, patches config, verifies |

## Design decisions

- **Wrapper script** sources `~/.hermes/.env` so `PROTEUSX_API_KEY` never appears in `config.yaml` or Hermes logs.
- **`bash` as command** (not `node` directly) so the wrapper handles env loading before exec'ing node.
- **No Hermes core changes** — only profile config and local scripts.
- **Existing servers preserved** — `shopify_dev`, `googleImagesSearch`, `semrush_official` are untouched.

## Required tools (verify in `hermes mcp test proteusx` output)

- `proteusx_generate_lead_audit_asset`
- `proteusx_get_lead_audit_asset`
- `proteusx_send_outreach_approvals`
- `proteusx_list_outreach_approvals`
- `proteusx_process_outreach_approval`
- `proteusx_check_outreach_approval_replies`
