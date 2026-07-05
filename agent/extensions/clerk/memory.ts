// ===========================================
// CLERK FOR PI — Memory (RAM)
// ===========================================
//
// Sliding window buffer of recent conversation turns.
// Injected into the LLM context via the "context" event.
//

import type { Message } from "@earendil-works/pi-ai";
import type { MemoryEntry } from "./types.ts";
import { getProfile, upsertInterest } from "./profile.ts";
import { formatMsk, formatMskShort } from "./utils.ts";

const MAX_ENTRIES = 50;

/** In-memory ring buffer */
let _buffer: MemoryEntry[] = [];

/** Timestamp of last update */
let _lastUpdated = "";

/**
 * Get current buffer
 */
export function getBuffer(): MemoryEntry[] {
  return _buffer;
}

/**
 * Get a formatted markdown representation of the buffer
 */
export function getBufferAsMarkdown(): string {
  const lines: string[] = [];
  lines.push("# Chat Buffer (RAM)");
  lines.push("");
  lines.push(`**Last Updated**: ${_lastUpdated ? formatMskShort(_lastUpdated) : formatMskShort()}`);
  lines.push(`**Messages Count**: ${_buffer.length}`);
  lines.push(`**Max Capacity**: ${MAX_ENTRIES}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const entry of _buffer) {
    const roleEmoji = entry.role === "user" ? "🧑" : "🤖";
    lines.push(`## [${entry.timestamp}] ${roleEmoji} ${entry.role === "user" ? "User" : "Clerk"}`);
    lines.push("");
    lines.push(entry.content);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## Примечания");
  lines.push("- Буфер содержит последние сообщения диалога");
  lines.push("- Используется для поддержания контекста разговора");
  lines.push("");

  return lines.join("\n");
}

/**
 * Add a message to the buffer
 */
export function addToBuffer(role: "user" | "assistant", content: string): MemoryEntry {
  const entry: MemoryEntry = {
    timestamp: new Date().toISOString(),
    role,
    content,
  };

  _buffer.push(entry);
  _lastUpdated = entry.timestamp;

  // Trim if over capacity
  if (_buffer.length > MAX_ENTRIES) {
    _buffer = _buffer.slice(_buffer.length - MAX_ENTRIES);
  }

  // Extract topics from user messages for interest tracking
  if (role === "user") {
    extractAndTrackInterests(content);
  }

  return entry;
}

/**
 * Extract potential interests from user message and update profile
 */
function extractAndTrackInterests(content: string): void {
  const profile = getProfile();
  const topicKeywords = [
    "python", "javascript", "typescript", "rust", "go", "node", "react", "vue",
    "docker", "kubernetes", "devops", "backend", "frontend", "api", "database",
    "sql", "testing", "deploy", "automation", "coding", "design", "architecture",
    "linux", "bash", "git", "security",
  ];

  const lower = content.toLowerCase();
  for (const keyword of topicKeywords) {
    if (lower.includes(keyword)) {
      const existing = profile.userInterests.find(
        (i) => i.topic.toLowerCase() === keyword,
      );
      if (existing) {
        existing.lastMentioned = new Date().toISOString();
      } else {
        upsertInterest(keyword, "medium");
      }
    }
  }
}

/**
 * Clear the buffer
 */
export function clearBuffer(): void {
  _buffer = [];
  _lastUpdated = new Date().toISOString();
}

/**
 * Get recent messages for analysis (for sleep/ping)
 */
export function getRecentMessages(count = 10): MemoryEntry[] {
  return _buffer.slice(-count);
}

/**
 * Extract topics mentioned in recent messages
 */
export function extractRecentTopics(count = 10): string[] {
  const recent = getRecentMessages(count);
  const topicMap = new Map<string, number>();

  const keywords = [
    "python", "javascript", "typescript", "rust", "go", "node", "react",
    "docker", "kubernetes", "api", "database", "sql", "testing", "deploy",
    "automation", "coding", "auth", "security", "bug", "refactor", "feature",
  ];

  for (const entry of recent) {
    const lower = entry.content.toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        topicMap.set(kw, (topicMap.get(kw) || 0) + 1);
      }
    }
  }

  return [...topicMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic]) => topic);
}

/**
 * Check if recent messages contain code-related content
 */
export function hasCodeInBuffer(count = 5): boolean {
  const recent = getRecentMessages(count);
  const codeIndicators = ["```", "function", "class ", "import ", "const ", "let ", "fn ", "def "];
  return recent.some((e) =>
    codeIndicators.some((indicator) => e.content.includes(indicator)),
  );
}

/**
 * Check if a user message likely indicates they're busy (short, no code, no questions)
 */
export function isUserBusy(message: string): boolean {
  const lower = message.toLowerCase().trim();
  const busySignals = ["ok", "thx", "thanks", "done", "later", "bye", "goodbye", "gtg"];
  return busySignals.some((s) => lower === s || lower.startsWith(s));
}

/**
 * Inject buffer content into the context messages
 */
export function injectContext(messages: Message[]): Message[] {
  if (_buffer.length === 0) return messages;

  const bufferText = getBufferAsMarkdown();

  // Find last user message and inject before it, or append
  const result = [...messages];

  // Add as a system/custom message before the last few messages
  const injectIdx = Math.max(0, result.length - 3);
  result.splice(injectIdx, 0, {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `[Clerk Memory Buffer — recent conversation context]\n\n${bufferText}`,
      },
    ],
    timestamp: Date.now(),
  });

  return result;
}

/**
 * Extract summary from buffer for sleep consolidation
 */
export function extractBufferSummary(): {
  topics: string[];
  completedTasks: string[];
  newPreferences: string[];
} {
  const topics = extractRecentTopics(10);
  // Simple heuristic: look for completion indicators
  const completedTasks: string[] = [];
  const newPreferences: string[] = [];

  for (const entry of _buffer) {
    if (entry.role === "assistant") {
      const lower = entry.content.toLowerCase();
      if (lower.includes("completed") || lower.includes("✅") || lower.includes("done:")) {
        completedTasks.push(entry.content.slice(0, 100));
      }
    }
    if (entry.role === "user") {
      const lower = entry.content.toLowerCase();
      if (lower.includes("i like") || lower.includes("prefer") || lower.includes("i want")) {
        newPreferences.push(entry.content.slice(0, 100));
      }
    }
  }

  return { topics, completedTasks, newPreferences };
}