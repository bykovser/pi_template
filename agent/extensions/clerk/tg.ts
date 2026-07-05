// ===========================================
// CLERK FOR PI — Telegram Messenger
// ===========================================
//
// Отправляет и получает сообщения от Серёги через Telegram Bot API.
// Чистый HTTP (fetch), без Python-зависимости.
// Токен берёт из profile.yaml (telegram.botToken).
//

import { getProfile } from "./profile.ts";
import type { TelegramConfig } from "./types.ts";
import { convert } from "@yc-tech/telegramify-markdown";
import * as path from "path";

/**
 * Конвертировать Markdown в text + MessageEntity[] для Telegram Bot API
 * Если конвертация сломалась — возвращаем исходный текст и null
 */
function mdToTgEntities(text: string): [string, any[] | null] {
  try {
    const [plain, entities] = convert(text);
    return [plain, entities];
  } catch (e) {
    return [text, null];
  }
}

// ─── Системный прокси ────────────────────────
// Windows: Internet Settings → ProxyServer
// Node.js fetch не видит системный прокси, нужно ставить HTTP_PROXY вручную.
try {
  // Сначала пробуем установить из profile.yaml (telegram.proxy)
  // Если не задано — пробуем системный прокси 127.0.0.1:3067 (Квант)
  const p = getProfile();
  let proxyUrl = p.telegram?.proxy || "";
  
  // Если не задан в профиле — используем системный прокси Кванта
  if (!proxyUrl && !process.env.HTTP_PROXY && !process.env.https_proxy) {
    proxyUrl = "http://127.0.0.1:3067";
  }
  
  if (proxyUrl) {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
  }
} catch {}

// ─── API Base ────────────────────────────────

function getApiBase(): string | null {
  const profile = getProfile();
  const token = profile.telegram?.botToken;
  if (!token) return null;
  return `https://api.telegram.org/bot${token}`;
}

function getChatId(): number | null {
  return getProfile().telegram?.chatId ?? null;
}

/**
 * Send typing indicator to Telegram (sendChatAction)
 * Нужно вызывать раз в 5 секунд пока LLM думает.
 */
let _typingInterval: ReturnType<typeof setInterval> | null = null;

export function startTyping(chatId: number): void {
  stopTyping();
  // Шлём typing сразу (fire-and-forget)
  fetchTyping(chatId);
  // И повторяем раз в 5 сек пока интервал активен
  _typingInterval = setInterval(() => fetchTyping(chatId), 5000);
}

/** Typing fire-and-forget — не ждём ответа */
function fetchTyping(chatId: number): void {
  const apiBase = getApiBase();
  if (!apiBase) return;
  fetch(`${apiBase}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    signal: AbortSignal.timeout(3000), // таймаут 3 сек, не блокируемся
  }).catch(() => {}); // игнорим всё — fire-and-forget
}

export function stopTyping(): void {
  if (_typingInterval) {
    clearInterval(_typingInterval);
    _typingInterval = null;
  }
}

// ─── Send ─────────────────────────────────────

/**
 * Send a text message to Серёга via Telegram
 * Автоматически конвертирует Markdown в Telegram entities (форматирование)
 */
/**
 * Отправить сообщение в Telegram (с markdown)
 */
export async function sendTelegramMessage(text: string, plain: boolean = false): Promise<boolean> {
  const apiBase = getApiBase();
  const chatId = getChatId();
  if (!apiBase || !chatId) {
    console.error("[TG] No telegram config in profile");
    return false;
  }

  try {
    let finalText: string;
    let finalEntities: any[] | null = null;

    if (plain) {
      // plain = без форматирования, как есть
      finalText = text.slice(0, 4096);
    } else {
      // Конвертируем MD → text + entities
      const [plainText, entities] = mdToTgEntities(text);
      finalText = plainText.slice(0, 4096);
      finalEntities = entities;
    }

    const body: Record<string, any> = {
      chat_id: chatId,
      text: finalText,
      disable_notification: false,
    };

    // Если есть entities — отправляем с ними (форматирование)
    // Если нет — пробуем HTML parse_mode
    // Если plain — вообще без parse_mode/entities
    if (plain) {
      // Никакого форматирования
    } else if (finalEntities && finalEntities.length > 0) {
      body.entities = finalEntities;
    } else {
      body.parse_mode = "HTML";
    }

    const resp = await fetch(`${apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data.ok) {
      console.error(`[TG] API error: ${JSON.stringify(data)}`);
    }
    return data.ok === true;
  } catch (err) {
    console.error(`[TG] send error: ${err}`);
    console.error(`[TG] send error type: ${typeof err}, constructor: ${(err as any)?.constructor?.name}`);
    return false;
  }
}

/**
 * Send message and return message_id (для последующего редактирования)
 */
export async function sendInitialMessage(text: string): Promise<{ ok: boolean; messageId?: number }> {
  const apiBase = getApiBase();
  const chatId = getChatId();
  if (!apiBase || !chatId) {
    return { ok: false };
  }
  try {
    // Конвертируем MD → text + entities
    const [plainText, entities] = mdToTgEntities(text);
    const truncated = plainText.slice(0, 4096);

    const body: Record<string, any> = {
      chat_id: chatId,
      text: truncated,
      disable_notification: false,
    };

    if (entities && entities.length > 0) {
      body.entities = entities;
    } else {
      body.parse_mode = "HTML";
    }

    const resp = await fetch(`${apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.ok && data.result?.message_id) {
      return { ok: true, messageId: data.result.message_id };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Edit a previously sent message (замена текста без дублирования сообщений)
 * Тоже использует MD → entities конвертацию
 */
export async function editTelegramMessage(chatId: number, messageId: number, text: string, plain: boolean = false): Promise<boolean> {
  const apiBase = getApiBase();
  if (!apiBase) return false;
  try {
    let finalText: string;
    let finalEntities: any[] | null = null;

    if (plain) {
      finalText = text.slice(0, 4096);
    } else {
      const [plainText, entities] = mdToTgEntities(text);
      finalText = plainText.slice(0, 4096);
      finalEntities = entities;
    }

    const body: Record<string, any> = {
      chat_id: chatId,
      message_id: messageId,
      text: finalText,
    };

    if (plain) {
      // Никакого форматирования
    } else if (finalEntities && finalEntities.length > 0) {
      body.entities = finalEntities;
    } else {
      body.parse_mode = "HTML";
    }

    const resp = await fetch(`${apiBase}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

/**
 * Escape HTML special characters for safe use in Telegram HTML messages
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Send a pre-built HTML message (bypasses Markdown conversion, uses parse_mode: HTML directly)
 */
export async function sendHtmlMessage(html: string): Promise<boolean> {
  const apiBase = getApiBase();
  const chatId = getChatId();
  if (!apiBase || !chatId) {
    console.error("[TG] No telegram config in profile");
    return false;
  }
  try {
    const resp = await fetch(`${apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html.slice(0, 4096),
        parse_mode: "HTML",
        disable_notification: false,
      }),
    });
    const data = await resp.json();
    if (!data.ok) console.error(`[TG] sendHtmlMessage error: ${JSON.stringify(data)}`);
    return data.ok === true;
  } catch (err) {
    console.error(`[TG] sendHtmlMessage error: ${err}`);
    return false;
  }
}

export type RichMessageType = "info" | "warning" | "error" | "success" | "code";

const RICH_ICON: Record<RichMessageType, string> = {
  info: "ℹ️",
  warning: "⚠️",
  error: "❌",
  success: "✅",
  code: "💻",
};

/**
 * Send a structured rich message with optional title, type icon, and footer.
 * Body is treated as already-safe HTML (or plain text for type=code which gets escaped).
 *
 * @example
 *   sendRichMessage({ type: "success", title: "Деплой", body: "main → prod за 12с" })
 *   sendRichMessage({ type: "code", title: "Вывод", body: rawText, footer: "exit 0" })
 */
export async function sendRichMessage(opts: {
  title?: string;
  body: string;
  type?: RichMessageType;
  footer?: string;
}): Promise<boolean> {
  const { title, body, type, footer } = opts;
  const parts: string[] = [];

  if (title) {
    const icon = type ? `${RICH_ICON[type]} ` : "";
    parts.push(`${icon}<b>${escapeHtml(title)}</b>`);
  }

  parts.push(type === "code" ? `<pre>${escapeHtml(body)}</pre>` : body);

  if (footer) {
    parts.push(`<i>${escapeHtml(footer)}</i>`);
  }

  return sendHtmlMessage(parts.join("\n\n"));
}

/**
 * Send a styled message with mood prefix
 */
export async function sendMoodMessage(mood: string, text: string): Promise<boolean> {
  const prefixMap: Record<string, string> = {
    "🔥": "🔥", "🧠": "🧠", "🌿": "🌿", "😈": "😈",
    "😏": "😏", "🛠️": "🛠️", "🥱": "🥱", "💤": "💤",
  };
  const prefix = prefixMap[mood] ?? "📎";
  // Используем sendHtmlMessage напрямую — body может содержать MD, оставляем как есть
  return sendHtmlMessage(`${prefix} <b>Жанночка</b>\n\n${text}`);
}

/**
 * Quick short notification
 */
export async function sendNotification(text: string): Promise<boolean> {
  return sendTelegramMessage(`📎 ${text}`);
}

// ─── Receive (Polling helpers) ────────────────

export interface TgMessage {
  message_id: number;
  text: string;
  date: number;
  from: string;
  isVoice?: boolean;      // голосовое сообщение
  voiceFileId?: string;   // file_id для скачивания
  voiceDuration?: number; // длительность в секундах
  isPhoto?: boolean;      // фото/изображение
  photoFileId?: string;   // file_id для скачивания
  photoWidth?: number;    // ширина
  photoHeight?: number;   // высота
}

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    date: number;
    from?: { first_name?: string };
    chat?: { id: number };
    voice?: {
      file_id: string;
      file_unique_id: string;
      duration: number;
      mime_type?: string;
      file_size?: number;
    };
    photo?: Array<{
      file_id: string;
      file_unique_id: string;
      width: number;
      height: number;
      file_size?: number;
    }>;
    document?: {
      file_id: string;
      file_unique_id: string;
      mime_type?: string;
      file_size?: number;
      thumbnail?: { file_id: string; width: number; height: number };
    };
  };
}

/**
 * Скачать голосовое сообщение из TG
 */
export async function downloadVoice(fileId: string, destPath: string): Promise<boolean> {
  const apiBase = getApiBase();
  if (!apiBase) return false;

  try {
    // Получаем file_path
    const resp = await fetch(`${apiBase}/getFile?file_id=${fileId}`);
    const data = await resp.json();
    if (!data.ok || !data.result?.file_path) return false;

    const filePath = data.result.file_path;
    const token = getProfile().telegram?.botToken;
    if (!token) return false;

    // Скачиваем файл
    const dlResp = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!dlResp.ok) return false;

    const buf = Buffer.from(await dlResp.arrayBuffer());
    require("fs").writeFileSync(destPath, buf);
    return true;
  } catch (err) {
    console.error(`[TG] downloadVoice error: ${err}`);
    return false;
  }
}

/**
 * Скачать фото из TG
 */
export async function downloadPhoto(fileId: string, destPath: string): Promise<boolean> {
  const apiBase = getApiBase();
  if (!apiBase) return false;

  try {
    // Получаем file_path
    const resp = await fetch(`${apiBase}/getFile?file_id=${fileId}`);
    const data = await resp.json();
    if (!data.ok || !data.result?.file_path) return false;

    const filePath = data.result.file_path;
    const token = getProfile().telegram?.botToken;
    if (!token) return false;

    // Скачиваем файл
    const dlResp = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!dlResp.ok) return false;

    const buf = Buffer.from(await dlResp.arrayBuffer());
    require("fs").writeFileSync(destPath, buf);
    return true;
  } catch (err) {
    console.error(`[TG] downloadPhoto error: ${err}`);
    return false;
  }
}

/**
 * Fetch updates from Telegram (long polling)
 * С retry при ошибках — поллер не должен умирать из-за временных проблем с прокси
 */
export async function getUpdates(
  offset: number = 0,
  timeout: number = 30,
): Promise<TgUpdate[]> {
  const apiBase = getApiBase();
  if (!apiBase) return [];

  const maxRetries = 3;
  const baseDelay = 2000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(`${apiBase}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset,
          timeout: Math.min(timeout, 15), // уменьшил таймаут с 30 до 15 — меньше шанс отвалиться
          allowed_updates: ["message"],
        }),
        signal: AbortSignal.timeout((timeout + 5) * 1000),
      });
      const data = await resp.json();
      if (data.ok === true) return data.result ?? [];
      console.error(`[TG] getUpdates API error: ${JSON.stringify(data)}`);
      return [];
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = baseDelay * (attempt + 1);
        console.error(`[TG] getUpdates fetch error (attempt ${attempt+1}/${maxRetries+1}), retry in ${delay}ms: ${err}`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[TG] getUpdates fetch error (exhausted): ${err}`);
        console.error(`[TG] getUpdates error type: ${typeof err}, constructor: ${(err as any)?.constructor?.name}`);
        return [];
      }
    }
  }
  return [];
}

// ─── Send File ────────────────────────────────

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

/**
 * Send a local file as a document to Telegram.
 * For images you usually want sendTelegramPhoto (shows inline).
 */
export async function sendTelegramDocument(filePath: string, caption?: string): Promise<boolean> {
  const apiBase = getApiBase();
  const chatId = getChatId();
  if (!apiBase || !chatId) return false;

  try {
    const fsSync = require("fs") as typeof import("fs");
    const data = fsSync.readFileSync(filePath);
    const fileName = path.basename(filePath);

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new Blob([data]), fileName);
    if (caption) form.append("caption", caption);

    const resp = await fetch(`${apiBase}/sendDocument`, { method: "POST", body: form });
    const json = await resp.json();
    if (!json.ok) console.error(`[TG] sendDocument error: ${JSON.stringify(json)}`);
    return json.ok === true;
  } catch (err) {
    console.error(`[TG] sendDocument error: ${err}`);
    return false;
  }
}

/**
 * Send a local image as a photo to Telegram (displayed inline).
 */
export async function sendTelegramPhoto(filePath: string, caption?: string): Promise<boolean> {
  const apiBase = getApiBase();
  const chatId = getChatId();
  if (!apiBase || !chatId) return false;

  try {
    const fsSync = require("fs") as typeof import("fs");
    const data = fsSync.readFileSync(filePath);
    const fileName = path.basename(filePath);

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([data]), fileName);
    if (caption) form.append("caption", caption);

    const resp = await fetch(`${apiBase}/sendPhoto`, { method: "POST", body: form });
    const json = await resp.json();
    if (!json.ok) console.error(`[TG] sendPhoto error: ${JSON.stringify(json)}`);
    return json.ok === true;
  } catch (err) {
    console.error(`[TG] sendPhoto error: ${err}`);
    return false;
  }
}

/**
 * Smart send: image extensions go as photo (inline), everything else as document.
 * Pass asDocument=true to force document mode regardless.
 */
export async function sendTelegramFile(
  filePath: string,
  caption?: string,
  asDocument: boolean = false,
): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  if (!asDocument && IMAGE_EXTS.has(ext)) {
    return sendTelegramPhoto(filePath, caption);
  }
  return sendTelegramDocument(filePath, caption);
}

// ─── Streaming ────────────────────────────────

/**
 * Stream text to Telegram: sends a placeholder first, then edits the message
 * as chunks arrive. Throttles edits to ≤1 per second to stay within rate limits.
 *
 * @param source    Async iterable of text chunks (e.g. from an LLM stream)
 * @param placeholder  Initial message text shown while streaming (default: "…")
 * @returns true if the final message was delivered
 */
export async function streamToTelegram(
  source: AsyncIterable<string>,
  placeholder: string = "…",
): Promise<boolean> {
  const chatId = getChatId();
  if (!chatId) return false;

  const { ok, messageId } = await sendInitialMessage(placeholder);
  if (!ok || !messageId) return false;

  let accumulated = "";
  let lastEditAt = 0;
  const THROTTLE_MS = 1000;

  for await (const chunk of source) {
    accumulated += chunk;
    const now = Date.now();
    if (now - lastEditAt >= THROTTLE_MS) {
      await editTelegramMessage(chatId, messageId, accumulated);
      lastEditAt = now;
    }
  }

  // Always do a final edit so the last chunk doesn't get lost
  if (accumulated && accumulated !== placeholder) {
    await editTelegramMessage(chatId, messageId, accumulated);
  }

  return true;
}

/**
 * Parse new messages from updates, return parsed messages + next offset
 */
export function parseUpdates(
  updates: TgUpdate[],
  chatId: number,
): { messages: TgMessage[]; maxUpdateId: number } {
  const messages: TgMessage[] = [];
  let maxUpdateId = 0;

  for (const update of updates) {
    if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;

    const msg = update.message;
    if (!msg) continue;
    if (msg.chat?.id !== chatId) continue;

    // Голосовое сообщение
    if (msg.voice) {
      messages.push({
        message_id: msg.message_id,
        text: `🎤 [Голосовое: ${msg.voice.duration} сек]`,
        date: msg.date,
        from: msg.from?.first_name ?? "Unknown",
        isVoice: true,
        voiceFileId: msg.voice.file_id,
        voiceDuration: msg.voice.duration,
      });
      continue;
    }

    // Фото (берём последний элемент — самый большой размер)
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      messages.push({
        message_id: msg.message_id,
        text: msg.text ?? "",
        date: msg.date,
        from: msg.from?.first_name ?? "Unknown",
        isPhoto: true,
        photoFileId: largest.file_id,
        photoWidth: largest.width,
        photoHeight: largest.height,
      });
      continue;
    }

    // Документ (возможно изображение)
    if (msg.document && msg.document.mime_type?.startsWith("image/")) {
      messages.push({
        message_id: msg.message_id,
        text: msg.text ?? "",
        date: msg.date,
        from: msg.from?.first_name ?? "Unknown",
        isPhoto: true,
        photoFileId: msg.document.file_id,
        photoWidth: msg.document.thumbnail?.width,
        photoHeight: msg.document.thumbnail?.height,
      });
      continue;
    }

    messages.push({
      message_id: msg.message_id,
      text: msg.text ?? "",
      date: msg.date,
      from: msg.from?.first_name ?? "Unknown",
    });
  }

  return { messages, maxUpdateId };
}