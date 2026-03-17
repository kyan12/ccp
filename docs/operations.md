# Operations

## Manual checks

```bash
node src/bin/jobs.js doctor /path/to/repo
node src/bin/jobs.js status
node src/bin/supervisor.js --once
```

## Long-running supervisor

```bash
node src/bin/supervisor.js --interval=15000 --max-concurrent=1
```

## Long-running intake server

```bash
node src/bin/intake-server.js
```

## launchd install

```bash
node src/bin/install-launchd.js
launchctl load ~/Library/LaunchAgents/ai.openclaw.coding-control-plane.plist
launchctl start ai.openclaw.coding-control-plane
launchctl load ~/Library/LaunchAgents/ai.openclaw.coding-control-plane.intake.plist
launchctl start ai.openclaw.coding-control-plane.intake
```

The generated plists inject a PATH that includes Homebrew binaries so `tmux`, `node`, `openclaw`, `claude`, and `op` are available under launchd. The intake service defaults to port `4318`.

Note: if macOS prompts that `node` wants access to another app during first live intake handling, allow it. That permission was required on this machine before launchd-managed intake requests would complete.

## Runtime artifacts

- `jobs/<job_id>/packet.json`
- `jobs/<job_id>/status.json`
- `jobs/<job_id>/worker.log`
- `jobs/<job_id>/result.json`
- `supervisor/daemon/heartbeat.json`
- `supervisor/daemon/launchd.stdout.log`
- `supervisor/daemon/launchd.stderr.log`
- `supervisor/daemon/intake.stdout.log`
- `supervisor/daemon/intake.stderr.log`
