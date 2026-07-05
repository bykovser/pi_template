#!/usr/bin/env python3
"""
Telegram Bot для Жанночки.
Отправляет и получает сообщения от Серёги в Telegram.

Usage:
    python tg_bot.py send "text message"
    python tg_bot.py send_mood "🔥" "text with mood"
    python tg_bot.py notify "text"
    python tg_bot.py check              # проверить новые сообщения
    python tg_bot.py check --save       # проверить и записать в файл
"""

import urllib.request
import urllib.error
import json
import sys
import os
import time

# ─── Config ───────────────────────────────────
# Токен теперь в profile.yaml (telegram.botToken)
# Для обратной совместимости: читаем из переменной окружения
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = int(os.environ.get("TELEGRAM_CHAT_ID", "0"))
if not BOT_TOKEN or CHAT_ID == 0:
    print("[TG] Warning: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set. Используй profile.yaml.", file=sys.stderr)
API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"

# Offset file for polling
OFFSET_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "tg_offset.json")
INBOX_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "tg_inbox.md")


# ─── Send ─────────────────────────────────────

def send_message(text: str, parse_mode: str = "HTML") -> bool:
    """Send a text message to Серёга"""
    data = json.dumps({
        "chat_id": CHAT_ID,
        "text": text[:4096],
        "parse_mode": parse_mode,
        "disable_notification": False,
    }).encode()

    req = urllib.request.Request(
        f"{API_BASE}/sendMessage",
        data=data,
        headers={"Content-Type": "application/json"},
    )

    try:
        resp = urllib.request.urlopen(req, timeout=10)
        result = json.loads(resp.read().decode())
        return result.get("ok") is True
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        print(f"[TG] Error: {e}", file=sys.stderr)
        return False


def send_mood(mood: str, text: str) -> bool:
    """Send with mood emoji prefix"""
    prefix_map = {
        "🔥": "🔥", "🧠": "🧠", "🌿": "🌿", "😈": "😈",
        "😏": "😏", "🛠️": "🛠️", "🥱": "🥱", "💤": "💤",
    }
    prefix = prefix_map.get(mood, "📎")
    full_text = f"{prefix} <b>Жанночка</b>\n\n{text}"
    return send_message(full_text)


def send_notification(text: str) -> bool:
    """Quick short notification"""
    return send_message(f"📎 {text}")


# ─── Receive ──────────────────────────────────

def load_offset() -> int:
    """Load last update_id offset"""
    try:
        if os.path.exists(OFFSET_FILE):
            with open(OFFSET_FILE, "r") as f:
                data = json.load(f)
                return data.get("offset", 0)
    except:
        pass
    return 0


def save_offset(offset: int):
    """Save last update_id offset"""
    os.makedirs(os.path.dirname(OFFSET_FILE), exist_ok=True)
    with open(OFFSET_FILE, "w") as f:
        json.dump({"offset": offset, "updated": time.time()}, f)


def get_updates(offset: int = 0, timeout: int = 5) -> list:
    """Get updates from Telegram (polling)"""
    params = {
        "offset": offset,
        "timeout": timeout,
        "allowed_updates": ["message"],
    }
    url = f"{API_BASE}/getUpdates?{urllib.parse.urlencode(params)}" if hasattr(urllib, 'parse') else \
          f"{API_BASE}/getUpdates"

    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{API_BASE}/getUpdates",
        data=data,
        headers={"Content-Type": "application/json"},
    )

    try:
        resp = urllib.request.urlopen(req, timeout=timeout + 5)
        result = json.loads(resp.read().decode())
        if result.get("ok"):
            return result.get("result", [])
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        print(f"[TG] getUpdates error: {e}", file=sys.stderr)
    return []


def get_new_messages() -> list:
    """Get new messages from Telegram, update offset"""
    offset = load_offset()
    updates = get_updates(offset=offset)

    messages = []
    max_update_id = offset

    for update in updates:
        update_id = update.get("update_id", 0)
        if update_id > max_update_id:
            max_update_id = update_id

        msg = update.get("message", {})
        chat = msg.get("chat", {})

        # Only messages from our chat
        if chat.get("id") == CHAT_ID:
            text = msg.get("text", "")
            date = msg.get("date", 0)
            from_user = msg.get("from", {}).get("first_name", "Unknown")
            messages.append({
                "text": text,
                "date": date,
                "from": from_user,
                "update_id": update_id,
            })

    if max_update_id > offset:
        save_offset(max_update_id + 1)

    return messages


def check_messages(save_to_file: bool = True) -> list:
    """Check for new messages and optionally save to inbox file"""
    messages = get_new_messages()

    if not messages:
        print("[TG] No new messages")
        return []

    print(f"[TG] Found {len(messages)} new message(s)")

    if save_to_file and messages:
        os.makedirs(os.path.dirname(INBOX_FILE), exist_ok=True)
        lines = []
        for m in messages:
            ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(m["date"]))
            lines.append(f"### {ts} — от {m['from']}")
            lines.append("")
            lines.append(m["text"])
            lines.append("")
            lines.append("---")
            lines.append("")

        with open(INBOX_FILE, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

        print(f"[TG] Saved to {INBOX_FILE}")

    return messages


# ─── CLI ──────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python tg_bot.py [send|send_mood|notify|check] [...]", file=sys.stderr)
        sys.exit(1)

    command = sys.argv[1]

    if command == "send":
        if len(sys.argv) < 3:
            print("Usage: python tg_bot.py send <text>", file=sys.stderr)
            sys.exit(1)
        text = " ".join(sys.argv[2:])
        ok = send_message(text)

    elif command == "send_mood":
        if len(sys.argv) < 4:
            print("Usage: python tg_bot.py send_mood <emoji> <text>", file=sys.stderr)
            sys.exit(1)
        mood = sys.argv[2]
        text = " ".join(sys.argv[3:])
        ok = send_mood(mood, text)

    elif command == "notify":
        text = " ".join(sys.argv[2:])
        ok = send_notification(text)

    elif command == "check":
        save = "--save" in sys.argv or "-s" in sys.argv
        msgs = check_messages(save_to_file=save)
        for m in msgs:
            print(f"[{m['from']}] {m['text'][:200]}")
        ok = True

    else:
        print(f"Unknown command: {command}", file=sys.stderr)
        sys.exit(1)

    sys.exit(0 if ok else 1)