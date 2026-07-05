// ===========================================
// CLERK FOR PI — Utilities
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "clerk");
const DATA_DIR = path.join(EXTENSION_DIR, "data");

/** Get the data directory path */
export function getDataDir(): string {
  return DATA_DIR;
}

/** Get path to profile.yaml */
export function getProfilePath(): string {
  return path.join(DATA_DIR, "profile.yaml");
}

/** Get path to tasks.json */
export function getTasksPath(): string {
  return path.join(DATA_DIR, "tasks.json");
}

/** Get path to reminders.json */
export function getRemindersPath(): string {
  return path.join(DATA_DIR, "reminders.json");
}

/** Get path to new_facts.md */
export function getFactsPath(): string {
  return path.join(DATA_DIR, "new_facts.md");
}

/** Get path to todo.md */
export function getTodoPath(): string {
  return path.join(DATA_DIR, "todo.md");
}

/** Get path to diary.md */
export function getDiaryPath(): string {
  return path.join(DATA_DIR, "diary.md");
}

/**
 * Simple YAML serializer (handles our profile structure)
 */
export function toYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const padInner = "  ".repeat(indent + 1);

  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "string") return `"${obj.replace(/"/g, '\\"')}"`;
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return "\n" + obj.map((item) => {
      if (typeof item === "object" && item !== null) {
        return `${pad}- ${toYaml(item, indent + 1).trimStart()}`;
      }
      return `${pad}- ${toYaml(item, indent + 1).trim()}`;
    }).join("\n");
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return "\n" + entries.map(([key, val]) => {
      const valStr = toYaml(val, indent + 1).trimStart();
      return `${pad}${key}: ${valStr}`;
    }).join("\n");
  }

  return String(obj);
}

/**
 * Format an ISO timestamp to a readable date/time
 */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format ISO to MSK (UTC+3) time string */
export function formatMsk(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const msk = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return msk.toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }) + " MSK";
}

/** HH:MM MSK for compact display */
export function formatMskShort(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const msk = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return msk.toLocaleString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }) + " MSK";
}

/** ISO string in MSK timezone */
export function nowMsk(): string {
  const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return msk.toISOString();
}

/**
 * Check if current hour is in a given range
 */
export function isHourInRange(startHour: number, endHour: number): boolean {
  const hour = new Date().getHours();
  if (startHour <= endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/**
 * Generate a short ID
 */
let _idCounter = Date.now();
export function generateId(): number {
  return ++_idCounter;
}

/**
 * Read JSON file safely
 */
export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write JSON file safely
 */
export function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Read text file safely
 */
export function readTextFile(filePath: string, fallback = ""): string {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return fallback;
  }
}

/**
 * Append text to a file
 */
export function appendTextFile(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, text, "utf-8");
}

/**
 * Truncate text to max length, adding ellipsis if needed
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}