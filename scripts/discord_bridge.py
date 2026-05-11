#!/usr/bin/env python3
"""Small synchronous Discord REST bridge for CCP notifications.

The TypeScript transport calls this script with an action and a JSON payload on
stdin. Keep the output as a single JSON object so launchd/tmux callers can parse
it reliably.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

API_BASE = "https://discord.com/api/v10"


def emit(payload: dict[str, Any], status: int = 0) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    raise SystemExit(status)


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError as exc:
        emit({"ok": False, "error": f"invalid JSON payload: {exc}"}, 2)


def token() -> str:
    value = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if not value:
        emit({"ok": False, "error": "DISCORD_BOT_TOKEN missing"}, 2)
    return value


def request_json(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bot {token()}",
            "User-Agent": "ccp-discord-bridge/1.0",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            text = resp.read().decode("utf-8")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        emit({"ok": False, "error": f"Discord HTTP {exc.code}: {detail}"}, 1)
    except Exception as exc:  # noqa: BLE001 - bridge should normalize failures
        emit({"ok": False, "error": str(exc)}, 1)


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    payload = read_payload()

    if action == "inspect":
        me = request_json("GET", "/users/@me")
        emit({
            "ok": True,
            "botUser": f"{me.get('username', 'unknown')}#{me.get('discriminator', '0')}",
            "botUserId": me.get("id"),
        })

    if action == "send":
        channel_id = str(payload.get("channelId") or "").strip()
        message = str(payload.get("message") or "")
        if not channel_id or not message:
            emit({"success": False, "ok": False, "error": "channelId and message are required"}, 2)
        sent = request_json("POST", f"/channels/{channel_id}/messages", {"content": message})
        emit({"success": True, "ok": True, "message_id": sent.get("id"), "channel_id": sent.get("channel_id")})

    if action == "thread-create":
        channel_id = str(payload.get("channelId") or "").strip()
        message_id = str(payload.get("messageId") or "").strip()
        thread_name = str(payload.get("threadName") or "CCP job")[:100]
        if not channel_id or not message_id:
            emit({"ok": False, "error": "channelId and messageId are required"}, 2)
        thread = request_json(
            "POST",
            f"/channels/{channel_id}/messages/{message_id}/threads",
            {"name": thread_name, "auto_archive_duration": 1440},
        )
        emit({"ok": True, "threadId": thread.get("id"), "name": thread.get("name")})

    emit({"ok": False, "error": f"unknown action: {action}"}, 2)


if __name__ == "__main__":
    main()
