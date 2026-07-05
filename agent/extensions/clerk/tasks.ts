// ===========================================
// CLERK FOR PI — Task Manager
// ===========================================
//
// CRUD task management with deadlines, priorities, tags.
// Persisted in tasks.json and synced with session state.
//

import { getTasksPath, readJsonFile, writeJsonFile, generateId, readTextFile } from "./utils.ts";
import type { Task, TaskManagerState, TaskStatus, TaskPriority } from "./types.ts";
import * as fs from "node:fs";

/** In-memory state */
let _state: TaskManagerState = readJsonFile<TaskManagerState>(getTasksPath(), {
  tasks: [],
  nextId: 1,
});

/** Track file modification time for auto-reload */
let _lastFileMtime = 0;

function updateFileMtime(): void {
  try {
    _lastFileMtime = fs.statSync(getTasksPath()).mtimeMs;
  } catch {
    _lastFileMtime = 0;
  }
}

// Initial mtime
updateFileMtime();

/**
 * Get current state, auto-reloading from disk if file changed
 */
export function getState(): TaskManagerState {
  try {
    const currentMtime = fs.statSync(getTasksPath()).mtimeMs;
    if (currentMtime > _lastFileMtime) {
      _state = readJsonFile<TaskManagerState>(getTasksPath(), { tasks: [], nextId: 1 });
      _lastFileMtime = currentMtime;
    }
  } catch {
    // If file doesn't exist, use in-memory
  }
  return _state;
}

/**
 * Save state to disk
 */
export function saveState(): void {
  writeJsonFile(getTasksPath(), _state);
  updateFileMtime();
}

/**
 * Load state from disk
 */
export function loadState(): TaskManagerState {
  _state = readJsonFile<TaskManagerState>(getTasksPath(), { tasks: [], nextId: 1 });
  return _state;
}

/**
 * List tasks with optional filter
 */
export function listTasks(filter?: TaskStatus | "overdue"): Task[] {
  const now = new Date().toISOString();

  if (filter === "overdue") {
    return _state.tasks.filter(
      (t) =>
        (t.status === "pending" || t.status === "in_progress") &&
        t.deadline &&
        t.deadline < now,
    );
  }

  if (filter && filter !== "all") {
    return _state.tasks.filter((t) => t.status === filter);
  }

  return [..._state.tasks];
}

/**
 * Add a new task
 */
export function addTask(params: {
  title: string;
  description?: string;
  priority?: TaskPriority;
  deadline?: string;
  tags?: string[];
}): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: _state.nextId++,
    title: params.title,
    description: params.description,
    status: "pending",
    priority: params.priority ?? "medium",
    tags: params.tags ?? [],
    deadline: params.deadline,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  _state.tasks.push(task);
  saveState();
  return task;
}

/**
 * Update a task
 */
export function updateTask(
  id: number,
  updates: {
    status?: TaskStatus;
    priority?: TaskPriority;
    title?: string;
    description?: string;
    deadline?: string;
    tags?: string[];
  },
): Task | null {
  const task = _state.tasks.find((t) => t.id === id);
  if (!task) return null;

  if (updates.status !== undefined) {
    task.status = updates.status;
    if (updates.status === "completed") {
      task.completedAt = new Date().toISOString();
    } else if (updates.status === "pending" || updates.status === "in_progress") {
      task.completedAt = null;
    }
  }
  if (updates.priority !== undefined) task.priority = updates.priority;
  if (updates.title !== undefined) task.title = updates.title;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.deadline !== undefined) task.deadline = updates.deadline;
  if (updates.tags !== undefined) task.tags = updates.tags;

  task.updatedAt = new Date().toISOString();
  saveState();
  return task;
}

/**
 * Delete a task
 */
export function deleteTask(id: number): boolean {
  const idx = _state.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  _state.tasks.splice(idx, 1);
  saveState();
  return true;
}

/**
 * Archive completed tasks
 */
export function archiveCompletedTasks(): number {
  let count = 0;
  for (const task of _state.tasks) {
    if (task.status === "completed") {
      task.status = "archived";
      task.updatedAt = new Date().toISOString();
      count++;
    }
  }
  if (count > 0) saveState();
  return count;
}

/**
 * Find tasks with deadline within the next N minutes from now
 */
export function getUpcomingDeadlines(windowMinutes: number): Task[] {
  const now = Date.now();
  const windowEnd = now + windowMinutes * 60 * 1000;

  return _state.tasks.filter((t) => {
    if (t.status !== "pending" && t.status !== "in_progress") return false;
    if (!t.deadline) return false;
    const deadline = new Date(t.deadline).getTime();
    return deadline > now && deadline <= windowEnd;
  });
}

/**
 * Get tasks that are overdue
 */
export function getOverdueTasks(): Task[] {
  const now = new Date().toISOString();
  return _state.tasks.filter(
    (t) =>
      (t.status === "pending" || t.status === "in_progress") &&
      t.deadline &&
      t.deadline < now,
  );
}

/**
 * Get summary counts
 */
export function getSummary(): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  archived: number;
  overdue: number;
} {
  const now = new Date().toISOString();
  const total = _state.tasks.length;
  const pending = _state.tasks.filter((t) => t.status === "pending").length;
  const inProgress = _state.tasks.filter((t) => t.status === "in_progress").length;
  const completed = _state.tasks.filter((t) => t.status === "completed").length;
  const archived = _state.tasks.filter((t) => t.status === "archived").length;
  const overdue = _state.tasks.filter(
    (t) =>
      (t.status === "pending" || t.status === "in_progress") &&
      t.deadline &&
      t.deadline < now,
  ).length;

  return { total, pending, inProgress, completed, archived, overdue };
}

/**
 * Get widget text for TUI
 */
export function getWidgetLines(): string[] {
  const s = getSummary();
  const lines: string[] = [];

  if (s.total === 0) {
    lines.push("📋 No tasks yet");
    return lines;
  }

  const parts: string[] = [];
  if (s.pending > 0) parts.push(`${s.pending} pending`);
  if (s.inProgress > 0) parts.push(`${s.inProgress} in-progress`);
  if (s.completed > 0) parts.push(`${s.completed} done`);
  if (s.overdue > 0) parts.push(`${s.overdue} overdue 🔴`);

  lines.push(`📋 ${s.total} tasks · ${parts.join(" · ")}`);
  return lines;
}

/**
 * Format a task for text display
 */
export function formatTask(task: Task): string {
  const statusIcon: Record<TaskStatus, string> = {
    pending: "○",
    in_progress: "◐",
    completed: "✓",
    archived: "📦",
  };
  const priorityMarker: Record<TaskPriority, string> = {
    low: "",
    medium: "",
    high: " 🔥",
  };
  const deadlineStr = task.deadline ? ` 📅 ${new Date(task.deadline).toLocaleDateString("ru-RU")}` : "";
  const tagsStr = task.tags.length > 0 ? ` 🏷 ${task.tags.join(", ")}` : "";
  const descStr = task.description ? `\n   ${task.description}` : "";

  return `${statusIcon[task.status]} #${task.id} ${task.title}${priorityMarker[task.priority]}${deadlineStr}${tagsStr}${descStr}`;
}

/**
 * Format task list for text display
 */
export function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) return "No tasks found.";
  return tasks.map((t) => formatTask(t)).join("\n");
}