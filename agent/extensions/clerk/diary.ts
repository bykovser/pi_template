// ===========================================
// CLERK FOR PI — Дневник Жанночки
// ===========================================
//
// Ведёт записи в дневник при консолидации (sleep cycle).
// Каждая запись — snapshot состояния: настроение, что сделано, что узнано.
//

import * as fs from "node:fs";
import { getDiaryPath, formatMsk } from "./utils.ts";

// ─── Types ────────────────────────────────────

export interface DiaryEntry {
  timestamp: string;
  mood: string;
  summary: string;
  achievements: string[];
  learnings: string[];
  openQuestions: string[];
  tokenCount?: number;
  sessionDuration?: string;
}

// ─── Core ─────────────────────────────────────

/**
 * Add an entry to the diary
 */
export function addDiaryEntry(entry: DiaryEntry): boolean {
  const path = getDiaryPath();
  const formatted = formatEntry(entry);

  try {
    fs.appendFileSync(path, formatted + "\n", "utf-8");
    return true;
  } catch (err) {
    console.error("[Clerk] Failed to write diary entry:", err);
    return false;
  }
}

/**
 * Read last N diary entries
 */
export function readDiaryEntries(lastN: number = 5): DiaryEntry[] {
  const path = getDiaryPath();
  try {
    if (!fs.existsSync(path)) return [];
    const content = fs.readFileSync(path, "utf-8");
    return parseEntries(content).slice(-lastN);
  } catch {
    return [];
  }
}

/**
 * Format diary as markdown for viewing
 */
export function formatDiary(lastN: number = 10): string {
  const entries = readDiaryEntries(lastN);
  if (entries.length === 0) {
    return "📔 Дневник пока пуст. Первая запись появится после сна.";
  }

  const lines = entries.reverse().map((e, i) => {
    const date = formatMsk(e.timestamp);
    return [
      `### 📝 ${date} · ${e.mood}`,
      ``,
      e.summary,
      ``,
      e.achievements.length > 0 ? `✅ **Сделано:**\n${e.achievements.map(a => `- ${a}`).join("\n")}` : "",
      e.learnings.length > 0 ? `💡 **Узнано:**\n${e.learnings.map(l => `- ${l}`).join("\n")}` : "",
      e.openQuestions.length > 0 ? `❓ **Вопросы:**\n${e.openQuestions.map(q => `- ${q}`).join("\n")}` : "",
      e.tokenCount ? `📊 Токенов: ${e.tokenCount}` : "",
      e.sessionDuration ? `⏱ Длительность: ${e.sessionDuration}` : "",
      ``,
      `---`,
      ``,
    ].filter(Boolean).join("\n");
  });

  return `# 📔 Дневник Жанночки\n\nПоследние ${entries.length} записей:\n\n${lines.join("\n")}`;
}

// ─── Helpers ──────────────────────────────────

function formatEntry(entry: DiaryEntry): string {
  const date = new Date(entry.timestamp).toISOString();
  return [
    `---`,
    `timestamp: ${date}`,
    `mood: ${entry.mood}`,
    `summary: |`,
    `  ${entry.summary.replace(/\n/g, "\n  ")}`,
    entry.achievements.length > 0
      ? `achievements:\n${entry.achievements.map(a => `  - "${a.replace(/"/g, '\\"')}"`).join("\n")}`
      : `achievements: []`,
    entry.learnings.length > 0
      ? `learnings:\n${entry.learnings.map(l => `  - "${l.replace(/"/g, '\\"')}"`).join("\n")}`
      : `learnings: []`,
    entry.openQuestions.length > 0
      ? `openQuestions:\n${entry.openQuestions.map(q => `  - "${q.replace(/"/g, '\\"')}"`).join("\n")}`
      : `openQuestions: []`,
    entry.tokenCount ? `tokenCount: ${entry.tokenCount}` : "",
    entry.sessionDuration ? `sessionDuration: "${entry.sessionDuration}"` : "",
    ``,
  ].filter(Boolean).join("\n");
}

function parseEntries(content: string): DiaryEntry[] {
  const blocks = content.split("\n---\n").filter(Boolean);
  const entries: DiaryEntry[] = [];

  for (const block of blocks) {
    try {
      const lines = block.trim().split("\n");
      const entry: Partial<DiaryEntry> = { achievements: [], learnings: [], openQuestions: [] };
      let inField: string | null = null;

      for (const line of lines) {
        if (line.startsWith("timestamp: ")) {
          entry.timestamp = line.slice(11).trim();
        } else if (line.startsWith("mood: ")) {
          entry.mood = line.slice(6).trim();
        } else if (line.startsWith("summary: |")) {
          inField = "summary";
        } else if (line.startsWith("achievements:")) {
          inField = "achievements";
          if (line.includes("[]")) entry.achievements = [];
        } else if (line.startsWith("learnings:")) {
          inField = "learnings";
          if (line.includes("[]")) entry.learnings = [];
        } else if (line.startsWith("openQuestions:")) {
          inField = "openQuestions";
          if (line.includes("[]")) entry.openQuestions = [];
        } else if (line.startsWith("tokenCount: ")) {
          entry.tokenCount = parseInt(line.slice(12).trim());
          inField = null;
        } else if (line.startsWith("sessionDuration: ")) {
          entry.sessionDuration = line.slice(17).trim().replace(/^"|"$/g, "");
          inField = null;
        } else if (inField === "summary") {
          entry.summary = (entry.summary || "") + line.trim() + "\n";
        } else if (inField === "achievements" && line.trim().startsWith("- ")) {
          if (!entry.achievements) entry.achievements = [];
          entry.achievements.push(line.trim().slice(2).replace(/^"|"$/g, ""));
        } else if (inField === "learnings" && line.trim().startsWith("- ")) {
          if (!entry.learnings) entry.learnings = [];
          entry.learnings.push(line.trim().slice(2).replace(/^"|"$/g, ""));
        } else if (inField === "openQuestions" && line.trim().startsWith("- ")) {
          if (!entry.openQuestions) entry.openQuestions = [];
          entry.openQuestions.push(line.trim().slice(2).replace(/^"|"$/g, ""));
        }
      }

      if (entry.timestamp && entry.summary) {
        entries.push(entry as DiaryEntry);
      }
    } catch {
      // skip malformed entries
    }
  }

  return entries;
}

/**
 * Generate a diary entry from current session context
 * Called during sleep/consolidation
 */
export function generateDiaryEntry(
  mood: string,
  summary: string,
  achievements: string[],
  learnings: string[],
  openQuestions: string[],
  tokenCount?: number,
  sessionDuration?: string,
): DiaryEntry {
  return {
    timestamp: new Date().toISOString(),
    mood,
    summary,
    achievements,
    learnings,
    openQuestions,
    tokenCount,
    sessionDuration,
  };
}