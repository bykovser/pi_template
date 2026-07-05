// ===========================================
// CLERK FOR PI — Telegram Poller
// ===========================================
//
// Фоновый long-polling для Telegram, живёт внутри pi-процесса.
// При получении нового сообщения от Серёги:
// 1. Пишет в tg_inbox.md
// 2. Добавляет в memory-буфер Clerk
// 3. Вызывает колбэк для реакции
//
// Запускается/останавливается через startPoller / stopPoller.
//

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { getProfile } from "./profile.ts";
import { addToBuffer } from "./memory.ts";
import { getUpdates, parseUpdates, downloadVoice, downloadPhoto } from "./tg.ts";
import { getDataDir } from "./utils.ts";
import type { TgUpdate } from "./tg.ts";

// ─── Config ───────────────────────────────────

const DATA_DIR = getDataDir();
const INBOX_FILE = path.join(DATA_DIR, "tg_inbox.md");
const OFFSET_FILE = path.join(DATA_DIR, "tg_offset.json");
const LOCK_FILE = path.join(DATA_DIR, "tg_poller.lock");

const POLL_INTERVAL_MS = 3_000;
const LONG_POLL_TIMEOUT = 30;

// ─── State ────────────────────────────────────

let _running = false;
let _currentOffset = 0;
let _lastMessageTime = 0;
/** Set of processed message IDs to prevent re-injection */
const _processedIds = new Set<number>();

/** Колбэк вызывается при получении нового сообщения */
export type OnMessageCallback = (message: string, from: string, timestamp: number) => void | Promise<void>;

let _onMessage: OnMessageCallback | null = null;

// ─── Offset Persistence ───────────────────────

function loadOffset(): number {
  try {
    if (fs.existsSync(OFFSET_FILE)) {
      const raw = fs.readFileSync(OFFSET_FILE, "utf-8");
      const data = JSON.parse(raw);
      return data.offset ?? 0;
    }
  } catch {
    // ignore
  }
  return 0;
}

function saveOffset(offset: number): void {
  try {
    fs.mkdirSync(path.dirname(OFFSET_FILE), { recursive: true });
    fs.writeFileSync(
      OFFSET_FILE,
      JSON.stringify({ offset, updated: Date.now() / 1000 }, null, 2),
      "utf-8",
    );
  } catch {
    // ignore
  }
}

// ─── Inbox File ───────────────────────────────

function appendToInbox(messages: Array<{ text: string; date: number; from: string }>): void {
  try {
    fs.mkdirSync(path.dirname(INBOX_FILE), { recursive: true });

    const lines: string[] = [];
    for (const m of messages) {
      const ts = new Date(m.date * 1000).toISOString().replace("T", " ").slice(0, 19);
      lines.push(`### ${ts} — от ${m.from}`);
      lines.push("");
      lines.push(m.text);
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    fs.appendFileSync(INBOX_FILE, lines.join("\n"), "utf-8");

    // Чистим буфер: оставляем только последние 30 сообщений
    // (чтобы tg_inbox.md не раздувался до бесконечности)
    cleanupInbox(30);
  } catch {
    // ignore
  }
}

/**
 * Clean inbox: keep only the last N messages
 */
function cleanupInbox(maxMessages: number): void {
  try {
    if (!fs.existsSync(INBOX_FILE)) return;

    const content = fs.readFileSync(INBOX_FILE, "utf-8");
    // Каждое сообщение отделяется разделителем "---"
    const parts = content.split(/\n---\n/).filter(Boolean);
    if (parts.length <= maxMessages) return;

    // Берём последние maxMessages
    const keep = parts.slice(parts.length - maxMessages);
    fs.writeFileSync(INBOX_FILE, keep.join("\n---\n"), "utf-8");
  } catch {
    // ignore
  }
}

/** Clean up inbox on startup too */
function startupCleanup(): void {
  cleanupInbox(50);
}

// ─── Dedup ────────────────────────────────────

function isDuplicate(text: string, date: number): boolean {
  // Простая дедупликация: проверяем последние 500 символов файла
  try {
    if (!fs.existsSync(INBOX_FILE)) return false;
    const stat = fs.statSync(INBOX_FILE);
    const size = stat.size;
    if (size === 0) return false;

    // Читаем хвост файла
    const readSize = Math.min(size, 500);
    const fd = fs.openSync(INBOX_FILE, "r");
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);

    const tail = buf.toString("utf-8");
    return tail.includes(text.trim());
  } catch {
    return false;
  }
}

// ─── Poll Cycle ───────────────────────────────

let _pollInProgress = false;

async function pollOnce(): Promise<void> {
  if (!_running || _pollInProgress) return;
  _pollInProgress = true;

  try {
    const profile = getProfile();
    const chatId = profile.telegram?.chatId;
    const apiBase = profile.telegram?.botToken;
    if (!chatId || !apiBase) return;

    const updates = await getUpdates(_currentOffset, LONG_POLL_TIMEOUT);
    if (!updates || updates.length === 0) return;

    // Логируем сырые сообщения если есть фото
    for (const u of updates) {
      if (u.message?.photo) {
        // skip logging — was flooding TUI
      }
    }

    const { messages, maxUpdateId } = parseUpdates(updates, chatId);

    if (maxUpdateId > _currentOffset) {
      _currentOffset = maxUpdateId + 1;
      saveOffset(_currentOffset);
    }

    if (messages.length === 0) return;

    const newMessages = messages.filter((m) => {
      // Skip already processed messages (photo spam fix)
      if (_processedIds.has(m.message_id)) return false;
      _processedIds.add(m.message_id);
      // Photo messages bypass text-based dedup (empty .text issue)
      return m.isPhoto || !isDuplicate(m.text, m.date);
    });
    if (newMessages.length === 0) return;

    appendToInbox(newMessages);

    for (const m of newMessages) {
      // Голосовое сообщение — скачиваем, распознаём, inject'им текст
      if (m.isVoice && m.voiceFileId) {
        try {
          const tmpDir = path.join(DATA_DIR, "tmp");
          fs.mkdirSync(tmpDir, { recursive: true });
          const oggPath = path.join(tmpDir, `voice_${m.message_id}.ogg`);
          const downloaded = await downloadVoice(m.voiceFileId, oggPath);
          if (downloaded) {
            // Распознаём через whisper
            const whisperScript = path.join(__dirname, "whisper.py");
            const result = execSync(
              `python "${whisperScript}" "${oggPath}" --model base`,
              { encoding: "utf-8", timeout: 60_000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
            );
            const parsed = JSON.parse(result.trim());
            const recognizedText = parsed.text?.trim() || "";
            if (recognizedText) {
              // Вместо "🎤 [Голосовое]" inject'им распознанный текст
              const voiceNote = `🎤 [Голосовое: ${m.voiceDuration} сек] ${recognizedText}`;
              addToBuffer("user", voiceNote);
            } else {
              addToBuffer("user", m.text + ` (не удалось распознать)`);
            }
            // Чистим временный файл
            try { fs.unlinkSync(oggPath); } catch {}
          } else {
            addToBuffer("user", m.text + ` (не удалось скачать)`);
          }
        } catch (voiceErr) {
          console.error(`[TG Poller] Voice processing error: ${voiceErr}`);
          addToBuffer("user", m.text + ` (ошибка распознавания)`);
        }
      }
      // Фото — ВРЕМЕННО ОТКЛЮЧЕНО (фікс спрему, будет переделано)
      else if (false) {} else {
        const text = m.text?.trim() || "";
        if (!text) continue; // skip empty TG messages
        addToBuffer("user", text);
      }
      _lastMessageTime = Date.now();
    }

    if (_onMessage && newMessages.length > 0) {
      const last = newMessages[newMessages.length - 1];
      await _onMessage(last.text, last.from, last.date);
    }

  } catch (err) {
    console.error(`[TG Poller] pollOnce error: ${err}`);
  } finally {
    _pollInProgress = false;
    if (_running) {
      setTimeout(() => pollOnce(), POLL_INTERVAL_MS);
    }
  }
}

// ─── Lock (multi-instance protection) ───────

function getLockData(): { pid: number; time: number } | null {
  try {
    if (!fs.existsSync(LOCK_FILE)) return null;
    const raw = fs.readFileSync(LOCK_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLock(): void {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, time: Date.now() }, null, 2),
      "utf-8",
    );
  } catch {
    // ignore
  }
}

function removeLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

function isPidAlive(pid: number): boolean {
  try {
    const out = execSync(
      `tasklist /FI "PID eq ${pid}" /NH`,
      { encoding: "utf-8", timeout: 3000, windowsHide: true },
    );
    return out.includes(String(pid));
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  const existing = getLockData();
  if (existing) {
    if (isPidAlive(existing.pid)) {
      return false;
    }
  }
  writeLock();
  return true;
}

// ─── Public API ───────────────────────────────

/**
 * Start the Telegram poller.
 * Uses sequential polling (setTimeout) and multi-instance lock.
 */
export function startPoller(onMessage?: OnMessageCallback): void {
  if (_running) return;

  // Чистим inbox при старте — оставляем последние 50 сообщений
  startupCleanup();

  if (!acquireLock()) {
    return;
  }

  _running = true;
  _currentOffset = loadOffset();
  _onMessage = onMessage ?? null;
  _pollInProgress = false;

  pollOnce();
}

/**
 * Stop the Telegram poller and release the lock.
 */
export function stopPoller(): void {
  _running = false;
  _pollInProgress = false;
  removeLock();
}

/**
 * Check if poller is currently running
 */
export function isPollerRunning(): boolean {
  return _running;
}

/**
 * Get last message received time (unix ms)
 */
export function getLastMessageTime(): number {
  return _lastMessageTime;
}

/**
 * Manually trigger a poll cycle
 */
export async function forcePoll(): Promise<void> {
  await pollOnce();
}