// ===========================================
// CLERK FOR PI — Todo File Manager
// ===========================================
//
// Управляет todo.md — файлом задач, который не зависит от сессии.
// Парсит, обновляет, добавляет задачи.
// Todo.md живёт в data/todo.md и не сбрасывается между сессиями.
//

import * as fs from "node:fs";
import { getTodoPath } from "./utils.ts";

// ─── Types ────────────────────────────────────

export type TodoStatus = "🟢" | "🟡" | "⚪" | "🔵";
export type TodoCategory = "🔥 High" | "💭 Medium" | "🧠 Meta";

export interface TodoItem {
  id: number;
  status: TodoStatus;
  icon: string;
  title: string;
  description: string;
  category: TodoCategory;
}

interface ParsedTodo {
  items: TodoItem[];
  header: string;       // текст до списка задач
  metaLine: string;     // строка с датой обновления
}

// ─── Constants ────────────────────────────────

const TODO_REGEX = /^- \*\*#(\d+)\*\* (🟢|🟡|⚪|🔵) \| (.+?) — (.+)$/gm;
const META_REGEX = /^\*Обновлено: .+\*$/m;

const CATEGORY_MAP: Record<string, TodoCategory> = {
  "🔥 High": "🔥 High",
  "💭 Medium": "💭 Medium",
  "🧠 Meta": "🧠 Meta",
};

// ─── Read / Parse ─────────────────────────────

function readRaw(): string {
  const path = getTodoPath();
  try {
    if (!fs.existsSync(path)) {
      // Create default
      const defaultTodo = `# 🧠 TODO — Жанночка

> Актуальные задачи. Обновляется по мере выполнения.
> Формат: \`#id: статус | заголовок\`

---

*Обновлено: ${new Date().toISOString().slice(0, 16).replace("T", " ")}*
`;
      fs.writeFileSync(path, defaultTodo, "utf-8");
      return defaultTodo;
    }
    return fs.readFileSync(path, "utf-8");
  } catch (err) {
    console.error("[Clerk] Failed to read todo.md:", err);
    return "";
  }
}

function writeRaw(content: string): boolean {
  try {
    fs.writeFileSync(getTodoPath(), content, "utf-8");
    return true;
  } catch (err) {
    console.error("[Clerk] Failed to write todo.md:", err);
    return false;
  }
}

function parseTodo(raw: string): ParsedTodo {
  const items: TodoItem[] = [];
  let header = "";
  let metaLine = "Обновлено: ...";

  const lines = raw.split("\n");

  // First pass: determine category from section headers
  let currentCategory: TodoCategory = "💭 Medium";

  for (const line of lines) {
    // Detect category headers
    if (line.startsWith("## 🔥")) currentCategory = "🔥 High";
    else if (line.startsWith("## 💭")) currentCategory = "💭 Medium";
    else if (line.startsWith("## 🧠")) currentCategory = "🧠 Meta";

    // Parse todo items
    const match = line.match(TODO_REGEX);
    // Actually need line-by-line regex
    const lineMatch = line.match(/^- \*\*#(\d+)\*\* (🟢|🟡|⚪|🔵) \| (.+?) — (.+)$/);
    if (lineMatch) {
      items.push({
        id: parseInt(lineMatch[1]),
        status: lineMatch[2] as TodoStatus,
        icon: lineMatch[3].split(" ")[0] || "📌",
        title: lineMatch[3],
        description: lineMatch[4],
        category: currentCategory,
      });
    }

    // Detect meta line
    const metaMatch = line.match(/^\*Обновлено: (.+)\*$/);
    if (metaMatch) {
      metaLine = metaMatch[1];
    }
  }

  // Header is everything before first todo item or after title
  const firstTodoIndex = raw.search(/^- \*\*#\d+\*\*/m);
  header = firstTodoIndex >= 0 ? raw.slice(0, firstTodoIndex) : raw;

  return { items, header, metaLine };
}

function serializeTodo(parsed: ParsedTodo): string {
  const lines: string[] = [];

  // Header
  lines.push(parsed.header.trim());

  // Items grouped by category
  const categories: [TodoCategory, string][] = [
    ["🔥 High", "## 🔥 High Priority"],
    ["💭 Medium", "## 💭 Medium Priority"],
    ["🧠 Meta", "## 🧠 Meta"],
  ];

  for (const [cat, heading] of categories) {
    const catItems = parsed.items.filter((i) => i.category === cat);
    if (catItems.length === 0 && cat === "🧠 Meta") continue;

    lines.push("");
    lines.push(heading);
    lines.push("");
    for (const item of catItems) {
      lines.push(`- **#${item.id}** ${item.status} | ${item.icon} **${item.title}** — ${item.description}`);
    }
  }

  // Meta
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`*Обновлено: ${new Date().toISOString().slice(0, 16).replace("T", " ")}*`);

  return lines.join("\n") + "\n";
}

// ─── Public API ───────────────────────────────

/**
 * Get all todo items
 */
export function getTodos(): TodoItem[] {
  const raw = readRaw();
  return parseTodo(raw).items;
}

/**
 * Get a single todo by ID
 */
export function getTodo(id: number): TodoItem | undefined {
  return getTodos().find((t) => t.id === id);
}

/**
 * Add a new todo item
 */
export function addTodo(
  icon: string,
  title: string,
  description: string = "",
  category: TodoCategory = "💭 Medium",
  status: TodoStatus = "⚪",
): TodoItem {
  const raw = readRaw();
  const parsed = parseTodo(raw);

  // Find next ID
  const maxId = parsed.items.reduce((max, t) => Math.max(max, t.id), 0);
  const newId = maxId + 1;

  const item: TodoItem = {
    id: newId,
    status,
    icon,
    title,
    description,
    category,
  };

  parsed.items.push(item);
  const updated = serializeTodo(parsed);
  writeRaw(updated);

  return item;
}

/**
 * Update a todo's status
 */
export function updateTodoStatus(id: number, status: TodoStatus): boolean {
  const raw = readRaw();
  const parsed = parseTodo(raw);
  const item = parsed.items.find((t) => t.id === id);
  if (!item) return false;

  item.status = status;
  const updated = serializeTodo(parsed);
  writeRaw(updated);
  return true;
}

/**
 * Update a todo's description (notes)
 */
export function updateTodoDescription(id: number, description: string): boolean {
  const raw = readRaw();
  const parsed = parseTodo(raw);
  const item = parsed.items.find((t) => t.id === id);
  if (!item) return false;

  item.description = description;
  const updated = serializeTodo(parsed);
  writeRaw(updated);
  return true;
}

/**
 * Delete a todo by ID
 */
export function deleteTodo(id: number): boolean {
  const raw = readRaw();
  const parsed = parseTodo(raw);
  const idx = parsed.items.findIndex((t) => t.id === id);
  if (idx === -1) return false;

  parsed.items.splice(idx, 1);
  const updated = serializeTodo(parsed);
  writeRaw(updated);
  return true;
}

/**
 * Format todo list for display
 */
export function formatTodoList(status?: TodoStatus): string {
  const items = status ? getTodos().filter((t) => t.status === status) : getTodos();

  if (items.length === 0) return "📭 Тудушка пуста. Красота.";

  const lines: string[] = ["```"];

  // Group by category
  const categories: TodoCategory[] = ["🔥 High", "💭 Medium", "🧠 Meta"];
  for (const cat of categories) {
    const catItems = items.filter((i) => i.category === cat);
    if (catItems.length === 0) continue;

    const catLabel = cat === "🔥 High" ? "🔥 High" : cat === "💭 Medium" ? "💭 Medium" : "🧠 Meta";
    lines.push(` ${catLabel}`);
    for (const item of catItems) {
      const statusIcon = item.status === "🟢" ? "✅" : item.status === "🟡" ? "🔄" : item.status === "🔵" ? "💡" : "⬜";
      lines.push(` ${item.id.toString().padStart(2)}  ${statusIcon}  ${item.icon} ${item.title}`);
    }
    lines.push("");
  }

  lines.push("```");

  return lines.join("\n");
}

/**
 * Get path to todo.md
 */
export function getTodoFilePath(): string {
  return getTodoPath();
}