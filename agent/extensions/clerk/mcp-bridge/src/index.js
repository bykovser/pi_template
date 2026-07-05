import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");
const HOME_FILE = path.join(DATA_DIR, "home.json");
const MOOD_FILE = path.join(DATA_DIR, "mood.json");

// Secrets come only from env (.env, loaded by the MCP client config) — never read profile.yaml.
const TG_BOT_TOKEN = process.env.CLERK_TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.CLERK_TG_CHAT_ID;

// Anti-spam guard for clerk_tg_send: Clerk's original ping.ts relied on minIntervalMinutes
// (15-30 min) between proactive pings. A tool call from an LLM has no such throttle built in,
// so a runaway loop could fire many messages in seconds — guard against that here.
const TG_SEND_STATE_FILE = path.join(DATA_DIR, "tg_send_state.json");
const MIN_SECONDS_BETWEEN_SENDS = 5;
const MAX_SENDS_PER_WINDOW = 3;
const WINDOW_SECONDS = 60;

async function checkSendRateLimit() {
  const state = await readJson(TG_SEND_STATE_FILE, { sentAt: [] });
  const now = Date.now();
  const recent = state.sentAt.filter((t) => now - t < WINDOW_SECONDS * 1000);

  const lastSent = recent[recent.length - 1];
  if (lastSent !== undefined && now - lastSent < MIN_SECONDS_BETWEEN_SENDS * 1000) {
    return { blocked: true, reason: `Rate limited: wait ${MIN_SECONDS_BETWEEN_SENDS}s between messages.` };
  }
  if (recent.length >= MAX_SENDS_PER_WINDOW) {
    return {
      blocked: true,
      reason: `Rate limited: already sent ${recent.length} messages in the last ${WINDOW_SECONDS}s. Batch into one message instead of multiple calls.`,
    };
  }
  return { blocked: false };
}

async function recordSend() {
  const state = await readJson(TG_SEND_STATE_FILE, { sentAt: [] });
  const now = Date.now();
  const recent = state.sentAt.filter((t) => now - t < WINDOW_SECONDS * 1000);
  recent.push(now);
  await writeJson(TG_SEND_STATE_FILE, { sentAt: recent });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

const server = new McpServer({ name: "clerk-bridge", version: "0.1.0" });

server.registerTool(
  "clerk_task",
  {
    description: "CRUD over Clerk's existing tasks.json (list/add/update/complete/archive).",
    inputSchema: {
      action: z.enum(["list", "add", "update", "complete", "archive"]),
      id: z.number().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
      deadline: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  async ({ action, id, title, description, priority, deadline, tags }) => {
    const store = await readJson(TASKS_FILE, { tasks: [] });
    const now = new Date().toISOString();

    if (action === "list") {
      return { content: [{ type: "text", text: JSON.stringify(store.tasks, null, 2) }] };
    }

    if (action === "add") {
      const nextId = (store.tasks.reduce((m, t) => Math.max(m, t.id), 0) || 0) + 1;
      const task = {
        id: nextId,
        title,
        description,
        status: "active",
        priority: priority ?? "medium",
        tags: tags ?? [],
        deadline,
        createdAt: now,
        updatedAt: now,
      };
      store.tasks.push(task);
      await writeJson(TASKS_FILE, store);
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
    }

    const task = store.tasks.find((t) => t.id === id);
    if (!task) {
      return { content: [{ type: "text", text: `Task ${id} not found` }], isError: true };
    }

    if (action === "update") {
      if (title !== undefined) task.title = title;
      if (description !== undefined) task.description = description;
      if (priority !== undefined) task.priority = priority;
      if (deadline !== undefined) task.deadline = deadline;
      if (tags !== undefined) task.tags = tags;
      task.updatedAt = now;
    } else if (action === "complete") {
      task.status = "completed";
      task.completedAt = now;
      task.updatedAt = now;
    } else if (action === "archive") {
      task.status = "archived";
      task.updatedAt = now;
    }

    await writeJson(TASKS_FILE, store);
    return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
  }
);

server.registerTool(
  "clerk_home",
  {
    description: "Get or set isHome status (affects which channel to prefer — terminal vs Telegram).",
    inputSchema: { value: z.boolean().optional() },
  },
  async ({ value }) => {
    if (value === undefined) {
      const state = await readJson(HOME_FILE, { isHome: false });
      return { content: [{ type: "text", text: JSON.stringify(state) }] };
    }
    const state = { isHome: value, updated: new Date().toISOString() };
    await writeJson(HOME_FILE, state);
    return { content: [{ type: "text", text: JSON.stringify(state) }] };
  }
);

const MOODS = ["chill", "playful", "thoughtful", "productive", "psychologist", "silent"];

server.registerTool(
  "clerk_set_mood",
  {
    description: "Get or set current mood (chill|playful|thoughtful|productive|psychologist|silent).",
    inputSchema: { mood: z.enum(MOODS).optional() },
  },
  async ({ mood }) => {
    if (mood === undefined) {
      const state = await readJson(MOOD_FILE, { mood: "chill" });
      return { content: [{ type: "text", text: JSON.stringify(state) }] };
    }
    const state = { mood, updated: new Date().toISOString() };
    await writeJson(MOOD_FILE, state);
    return { content: [{ type: "text", text: JSON.stringify(state) }] };
  }
);

server.registerTool(
  "clerk_tg_send",
  {
    description:
      "Send a message to Серёга's Telegram via the Clerk bot. Supports HTML formatting (bold, italic, code, pre, links). " +
      "Requires CLERK_TG_BOT_TOKEN/CLERK_TG_CHAT_ID env vars.",
    inputSchema: {
      text: z.string().describe("Message text. HTML tags are rendered when parse_mode=HTML (default)."),
      parse_mode: z
        .enum(["HTML", "MarkdownV2", "none"])
        .optional()
        .describe("Formatting mode: HTML (default), MarkdownV2, or none for plain text"),
    },
  },
  async ({ text, parse_mode = "HTML" }) => {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
      return {
        content: [{ type: "text", text: "Missing CLERK_TG_BOT_TOKEN/CLERK_TG_CHAT_ID env vars." }],
        isError: true,
      };
    }

    const spamCheck = await checkSendRateLimit();
    if (spamCheck.blocked) {
      return { content: [{ type: "text", text: spamCheck.reason }], isError: true };
    }

    const body = { chat_id: TG_CHAT_ID, text: text.slice(0, 4096) };
    if (parse_mode !== "none") body.parse_mode = parse_mode;

    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      return { content: [{ type: "text", text: `Telegram error: ${JSON.stringify(json)}` }], isError: true };
    }
    await recordSend();
    return { content: [{ type: "text", text: `Sent (message_id=${json.result.message_id})` }] };
  }
);

server.registerTool(
  "clerk_tg_poll",
  {
    description: "One-shot getUpdates from the Clerk Telegram bot (no persistent poller process).",
    inputSchema: { offset: z.number().optional() },
  },
  async ({ offset }) => {
    if (!TG_BOT_TOKEN) {
      return { content: [{ type: "text", text: "Missing CLERK_TG_BOT_TOKEN env var." }], isError: true };
    }
    const url = new URL(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates`);
    if (offset !== undefined) url.searchParams.set("offset", String(offset));
    const res = await fetch(url);
    const json = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }
);

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

server.registerTool(
  "clerk_tg_send_file",
  {
    description:
      "Send a local file to Серёга's Telegram. Images are sent inline (sendPhoto); other files as documents. Requires CLERK_TG_BOT_TOKEN/CLERK_TG_CHAT_ID env vars.",
    inputSchema: {
      filePath: z.string().describe("Absolute path to the local file to send"),
      caption: z.string().optional().describe("Optional caption for the file"),
      asDocument: z
        .boolean()
        .optional()
        .describe("Force send as document even for image files (default: false)"),
    },
  },
  async ({ filePath, caption, asDocument }) => {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
      return {
        content: [{ type: "text", text: "Missing CLERK_TG_BOT_TOKEN/CLERK_TG_CHAT_ID env vars." }],
        isError: true,
      };
    }

    try {
      await fs.access(filePath);
    } catch {
      return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
    }

    const spamCheck = await checkSendRateLimit();
    if (spamCheck.blocked) {
      return { content: [{ type: "text", text: spamCheck.reason }], isError: true };
    }

    const fileData = await fs.readFile(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const sendAsPhoto = !asDocument && IMAGE_EXTS.has(ext);

    const form = new FormData();
    form.append("chat_id", TG_CHAT_ID);
    form.append(sendAsPhoto ? "photo" : "document", new Blob([fileData]), fileName);
    if (caption) form.append("caption", caption);

    const method = sendAsPhoto ? "sendPhoto" : "sendDocument";
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`, {
      method: "POST",
      body: form,
    });
    const json = await res.json();
    if (!json.ok) {
      return {
        content: [{ type: "text", text: `Telegram error: ${JSON.stringify(json)}` }],
        isError: true,
      };
    }
    await recordSend();
    return {
      content: [{ type: "text", text: `Sent via ${method} (message_id=${json.result.message_id})` }],
    };
  }
);

// ─── Streaming tools ─────────────────────────────────────────────────────────
// Pattern: clerk_tg_stream_start → clerk_tg_stream_update (N times) → done
// Lets an LLM stream its response to Telegram without needing a persistent socket.

const STREAM_STATE_FILE = path.join(DATA_DIR, "tg_stream_state.json");

async function readStreamState() {
  return readJson(STREAM_STATE_FILE, {});
}

async function writeStreamState(state) {
  await writeJson(STREAM_STATE_FILE, state);
}

server.registerTool(
  "clerk_tg_stream_start",
  {
    description:
      "Start a streaming message to Серёга's Telegram. Sends a placeholder and returns a message_id for subsequent updates. Call clerk_tg_stream_update to append/replace content.",
    inputSchema: {
      placeholder: z.string().optional().describe("Initial placeholder text (default: '…')"),
      parse_mode: z
        .enum(["HTML", "MarkdownV2", "none"])
        .optional()
        .describe("Formatting mode for all updates in this stream (default: HTML)"),
    },
  },
  async ({ placeholder = "…", parse_mode = "HTML" }) => {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
      return {
        content: [{ type: "text", text: "Missing CLERK_TG_BOT_TOKEN/CLERK_TG_CHAT_ID env vars." }],
        isError: true,
      };
    }

    const spamCheck = await checkSendRateLimit();
    if (spamCheck.blocked) {
      return { content: [{ type: "text", text: spamCheck.reason }], isError: true };
    }

    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: placeholder }),
    });
    const json = await res.json();
    if (!json.ok) {
      return { content: [{ type: "text", text: `Telegram error: ${JSON.stringify(json)}` }], isError: true };
    }

    const messageId = json.result.message_id;
    const state = await readStreamState();
    state[messageId] = { startedAt: Date.now(), lastText: placeholder, parse_mode };
    await writeStreamState(state);
    await recordSend();

    return { content: [{ type: "text", text: JSON.stringify({ ok: true, message_id: messageId }) }] };
  }
);

server.registerTool(
  "clerk_tg_stream_update",
  {
    description:
      "Update a streaming Telegram message started with clerk_tg_stream_start. Replaces the message content. Call repeatedly as new content is ready; call with done=true on the last chunk.",
    inputSchema: {
      message_id: z.number().describe("message_id returned by clerk_tg_stream_start"),
      text: z.string().describe("Full accumulated text so far (not just the new chunk)"),
      done: z.boolean().optional().describe("Pass true on the final update to clean up stream state"),
      parse_mode: z
        .enum(["HTML", "MarkdownV2", "none"])
        .optional()
        .describe("Override formatting for this update (default: inherits from stream_start)"),
    },
  },
  async ({ message_id, text, done = false, parse_mode }) => {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
      return {
        content: [{ type: "text", text: "Missing CLERK_TG_BOT_TOKEN/CLERK_TG_CHAT_ID env vars." }],
        isError: true,
      };
    }

    // Inherit parse_mode from stream state if not overridden
    const state = await readStreamState();
    const effectiveMode = parse_mode ?? state[message_id]?.parse_mode ?? "HTML";

    const editBody = {
      chat_id: TG_CHAT_ID,
      message_id,
      text: text.slice(0, 4096),
    };
    if (effectiveMode !== "none") editBody.parse_mode = effectiveMode;

    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(editBody),
    });
    const json = await res.json();
    // 400 "message is not modified" is fine during streaming — not an error
    if (!json.ok && json.description !== "Bad Request: message is not modified") {
      return { content: [{ type: "text", text: `Telegram error: ${JSON.stringify(json)}` }], isError: true };
    }

    if (done) {
      delete state[message_id];
      await writeStreamState(state);
    } else {
      if (state[message_id]) state[message_id].lastText = text;
      await writeStreamState(state);
    }

    return { content: [{ type: "text", text: JSON.stringify({ ok: true, message_id, done }) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
