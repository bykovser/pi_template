#!/usr/bin/env python3
"""
TG Poll — фоновый polling для Telegram.
Проверяет новые сообщения каждые N секунд.
При обнаружении пишет в tg_inbox.md и может выполнить callback.

Usage (detached):
    start /b python tg_poll.py
    python tg_poll.py --interval 10
"""

import sys
import os
import json
import time
import urllib.request
import urllib.error
import signal

# ─── Config ───────────────────────────────────
# Токен теперь в profile.yaml (telegram.botToken)
# Для обратной совместимости: читаем из переменной окружения
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = int(os.environ.get("TELEGRAM_CHAT_ID", "0"))
if not BOT_TOKEN or CHAT_ID == 0:
    print("[TG Poll] Warning: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set. Используй profile.yaml.", file=sys.stderr)
API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OFFSET_FILE = os.path.join(SCRIPT_DIR, "data", "tg_offset.json")
INBOX_FILE = os.path.join(SCRIPT_DIR, "data", "tg_inbox.md")
PID_FILE = os.path.join(SCRIPT_DIR, "data", "tg_poll.pid")


# ─── State ────────────────────────────────────
def load_offset() -> int:
    try:
        if os.path.exists(OFFSET_FILE):
            with open(OFFSET_FILE) as f:
                return json.load(f).get("offset", 0)
    except:
        pass
    return 0


def save_offset(offset: int):
    os.makedirs(os.path.dirname(OFFSET_FILE), exist_ok=True)
    with open(OFFSET_FILE, "w") as f:
        json.dump({"offset": offset, "updated": time.time()}, f)


def write_pid():
    os.makedirs(os.path.dirname(PID_FILE), exist_ok=True)
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))


def is_already_running() -> bool:
    if os.path.exists(PID_FILE):
        try:
            with open(PID_FILE) as f:
                old_pid = int(f.read().strip())
            # Check if process exists (Windows)
            if os.name == "nt":
                import ctypes
                PROCESS_QUERY_INFORMATION = 0x0400
                handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_INFORMATION, False, old_pid)
                if handle:
                    ctypes.windll.kernel32.CloseHandle(handle)
                    return True
            else:
                os.kill(old_pid, 0)
                return True
        except:
            pass
    return False


# ─── Polling ──────────────────────────────────
def get_updates(offset: int, timeout: int = 5) -> list:
    data = json.dumps({
        "offset": offset,
        "timeout": timeout,
        "allowed_updates": ["message"],
    }).encode()

    req = urllib.request.Request(
        f"{API_BASE}/getUpdates",
        data=data,
        headers={"Content-Type": "application/json"},
    )

    try:
        resp = urllib.request.urlopen(req, timeout=timeout + 5)
        result = json.loads(resp.read().decode())
        return result.get("result", [])
    except:
        return []


def handle_updates(updates: list, offset: int) -> int:
    max_id = offset
    for update in updates:
        uid = update.get("update_id", 0)
        if uid > max_id:
            max_id = uid

        msg = update.get("message", {})
        chat = msg.get("chat", {})
        if chat.get("id") != CHAT_ID:
            continue

        text = msg.get("text", "")
        date = msg.get("date", 0)
        from_user = msg.get("from", {}).get("first_name", "Unknown")

        # Check if we already have this message
        if is_duplicate(date, from_user, text):
            continue

        # Write to inbox
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(date))
        entry = f"### {ts} — от {from_user}\n\n{text}\n\n---\n\n"

        os.makedirs(os.path.dirname(INBOX_FILE), exist_ok=True)
        with open(INBOX_FILE, "a", encoding="utf-8") as f:
            f.write(entry)

        # Print to stdout
        print(f"[TG POLL] ✉️ {from_user}: {text[:100]}", flush=True)

    return max_id


def is_duplicate(date: int, from_user: str, text: str) -> bool:
    """Check if message already in inbox (simple check based on text + time range)"""
    if not os.path.exists(INBOX_FILE):
        return False
    try:
        with open(INBOX_FILE, "r", encoding="utf-8") as f:
            content = f.read()
        # Check if text appears in last 500 chars
        recent = content[-500:]
        return text.strip() in recent
    except:
        return False


def poll_loop(interval: int = 15):
    """Main polling loop"""
    if is_already_running():
        print("[TG POLL] Already running, exiting", file=sys.stderr)
        sys.exit(1)

    write_pid()
    offset = load_offset()
    print(f"[TG POLL] Started. Interval: {interval}s. Offset: {offset}", flush=True)

    while True:
        try:
            updates = get_updates(offset)
            if updates:
                new_offset = handle_updates(updates, offset)
                if new_offset > offset:
                    offset = new_offset
                    save_offset(offset)
        except KeyboardInterrupt:
            print("\n[TG POLL] Stopped by user", flush=True)
            break
        except Exception as e:
            print(f"[TG POLL] Error: {e}", flush=True)

        time.sleep(interval)


# ─── CLI ──────────────────────────────────────
if __name__ == "__main__":
    interval = 15
    if len(sys.argv) > 1:
        if sys.argv[1] == "--interval" and len(sys.argv) > 2:
            interval = int(sys.argv[2])
        elif sys.argv[1] == "--stop":
            if os.path.exists(PID_FILE):
                with open(PID_FILE) as f:
                    pid = int(f.read().strip())
                if os.name == "nt":
                    os.system(f"taskkill /F /PID {pid} 2>nul")
                else:
                    os.kill(pid, signal.SIGTERM)
                os.remove(PID_FILE)
                print("[TG POLL] Stopped")
            else:
                print("[TG POLL] Not running")
            sys.exit(0)

    poll_loop(interval)