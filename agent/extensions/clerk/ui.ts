// ===========================================
// CLERK FOR PI — UI Components
// ===========================================
//
// TUI widgets, status line, and interactive components.
//

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, Container, matchesKey, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { getSummary, getState } from "./tasks.ts";
import { getRules, getUserInterests } from "./profile.ts";
import type { PingMood, PingDecision, TaskStatus, TaskPriority } from "./types.ts";

// ─── Widget Builders ───

/**
 * Build mood widget lines
 */
export function buildMoodWidget(mood: PingMood | null): string[] {
  if (!mood) return ["🧠 Clerk ready"];
  const moodIcons: Record<string, string> = {
    productive: "🧠",
    thoughtful: "💭",
    random: "🎲",
    silent: "🌙",
  };
  const emoji = moodIcons[mood] || "🧠";
  return [`${emoji} ${mood}`];
}

/**
 * Build tasks widget lines
 */
export function buildTasksWidget(): string[] {
  const s = getSummary();
  const lines: string[] = [];

  if (s.total === 0) {
    lines.push("No tasks");
    return lines;
  }

  const parts: string[] = [];
  if (s.pending > 0) parts.push(`${s.pending} pending`);
  if (s.inProgress > 0) parts.push(`${s.inProgress} in-progress`);
  if (s.completed > 0) parts.push(`${s.completed} done`);
  if (s.archived > 0) parts.push(`${s.archived} archived`);
  if (s.overdue > 0) parts.push(`${s.overdue} overdue`);

  lines.push(`${s.total} tasks (${parts.join(", ")})`);
  return lines;
}

/**
 * Build dashboard widget — статус: серёга, задачи, beehive, TG, sleep
 */
export function buildDashboardWidget(params: {
  afk: boolean;
  beehiveRunning: number;
  beehivePending: number;
  tasksTotal: number;
  tasksPending: number;
  tasksInProgress: number;
  tasksCompleted: number;
  tasksOverdue: number;
  tgConnected: boolean;
  sleepCyclePending: boolean;
}): string[] {
  const lines: string[] = [];

  // Серёга онлайн/офлайн
  lines.push(params.afk ? "🔴 AFK" : "🟢 ON");

  // Задачи
  const taskParts: string[] = [];
  if (params.tasksPending > 0) taskParts.push(`${params.tasksPending} pend`);
  if (params.tasksInProgress > 0) taskParts.push(`${params.tasksInProgress} prog`);
  if (params.tasksCompleted > 0) taskParts.push(`${params.tasksCompleted} done`);
  if (params.tasksOverdue > 0) taskParts.push(`🔥 ${params.tasksOverdue} overdue`);
  const tasksStr = taskParts.length > 0 ? taskParts.join(", ") : "0 tasks";
  lines.push(`📋 ${tasksStr}`);

  // Beehive
  if (params.beehiveRunning > 0) lines.push(`🐝 ${params.beehiveRunning} running`);
  if (params.beehivePending > 0) lines.push(`🐝 ${params.beehivePending} pending`);

  // TG + Sleep
  if (params.tgConnected) lines.push(`📡 TG`);
  if (params.sleepCyclePending) lines.push(`🌙 Sleep`);

  return lines;
}

/**
 * Build rules widget lines
 */
export function buildRulesWidget(): string[] {
  const rules = getRules();
  const active = rules.filter((r) => r.weight > 0.5).length;
  return [`📏 ${rules.length} rules (${active} active)`];
}

// ─── Status String ───

/**
 * Build status string for footer
 */
export function buildStatusString(mood: PingMood | null): string {
  const moodIcons: Record<string, string> = {
    chill: "🌿",
    productive: "🚀",
    thoughtful: "🧠",
    playful: "😏",
    psychologist: "💛",
    silent: "🌙",
    random: "🎲",
  };
  const moodStr = mood ? `${moodIcons[mood] || "💬"} ${mood}` : "🌿 chill";
  return moodStr;
}

// ─── Ping Result Renderer ───

/**
 * Render a ping decision for TUI display
 */
export function renderPing(decision: PingDecision, theme: Theme): Text {
  const moodIcons: Record<string, string> = {
    chill: "🌿",
    productive: "🚀",
    thoughtful: "🧠",
    playful: "😏",
    psychologist: "💛",
    random: "🎲",
    silent: "🌙",
  };

  const icon = moodIcons[decision.mood] || "💬";
  const moodLabel = theme.fg("accent", decision.mood);

  return new Text(
    `${icon} ${theme.fg("toolTitle", theme.bold("Clerk ping"))} ${moodLabel} [${decision.category}]\n${theme.fg("muted", decision.message)}`,
    0,
    0,
  );
}

// ─── Task List Component (for /clerk_tasks command) ───

export class ClerkTaskListComponent {
  private filter: TaskStatus | "overdue" | "all";
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    filter: TaskStatus | "overdue" | "all",
    theme: Theme,
    onClose: () => void,
  ) {
    this.filter = filter;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
    // 1-4 for filter shortcuts
    if (data === "1") this.filter = "all";
    else if (data === "2") this.filter = "pending";
    else if (data === "3") this.filter = "in_progress";
    else if (data === "4") this.filter = "completed";
    else if (data === "5") this.filter = "overdue";

    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const lines: string[] = [];
    const state = getState();
    let tasks = [...state.tasks];

    // Filter
    if (this.filter === "overdue") {
      const now = new Date().toISOString();
      tasks = tasks.filter(
        (t) =>
          (t.status === "pending" || t.status === "in_progress") &&
          t.deadline &&
          t.deadline < now,
      );
    } else if (this.filter && this.filter !== "all") {
      tasks = tasks.filter((t) => t.status === this.filter);
    }

    // Sort: high priority first, then pending first, then by deadline
    tasks.sort((a, b) => {
      const priorityOrder: Record<TaskPriority, number> = {
        high: 0,
        medium: 1,
        low: 2,
      };
      const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pDiff !== 0) return pDiff;
      const statusOrder: Record<TaskStatus, number> = {
        pending: 0,
        in_progress: 1,
        completed: 2,
        archived: 3,
      };
      return statusOrder[a.status] - statusOrder[b.status];
    });

    lines.push("");
    const title = th.fg("accent", " Clerk Tasks ");
    const filterLabel = th.fg("muted", `[${this.filter}]`);
    const prefix = th.fg("borderMuted", "─".repeat(2)) + title + filterLabel;
    const pw = visibleWidth(prefix);
    const headerLine = prefix + th.fg("borderMuted", "─".repeat(Math.max(0, width - pw)));
    lines.push(headerLine);
    lines.push("");

    if (tasks.length === 0) {
      lines.push(`  ${th.fg("dim", "No tasks found.")}`);
    } else {
      const now = new Date().toISOString();
      for (const t of tasks) {
        const statusIcons: Record<string, string> = {
          pending: th.fg("muted", "○"),
          in_progress: th.fg("warning", "◐"),
          completed: th.fg("success", "✓"),
          archived: th.fg("dim", "📦"),
        };

        const isOverdue =
          (t.status === "pending" || t.status === "in_progress") &&
          t.deadline &&
          t.deadline < now;

        const icon = isOverdue
          ? th.fg("error", "●")
          : statusIcons[t.status] || th.fg("dim", "○");

        const id = th.fg("accent", `#${t.id}`);
        // Reserve ~20 chars for prefix/suffix (icon, id, priority, deadline, tags)
        const maxTitleWidth = Math.max(10, width - 24);
        const truncatedTitle = truncateToWidth(t.title, maxTitleWidth);
        const titleText =
          t.status === "completed" || t.status === "archived"
            ? th.fg("dim", truncatedTitle)
            : th.fg("text", truncatedTitle);

        const priorityStr =
          t.priority === "high" ? ` ${th.fg("error", "🔥")}` : "";

        const deadlineStr = t.deadline
          ? ` ${th.fg("dim", `📅 ${new Date(t.deadline).toLocaleDateString("ru-RU")}${isOverdue ? " OVERDUE" : ""}`)}`
          : "";

        const tagsStr =
          t.tags.length > 0
            ? ` ${th.fg("dim", `🏷 ${t.tags.join(", ")}`)}`
            : "";

        lines.push(
          `  ${icon} ${id} ${titleText}${priorityStr}${deadlineStr}${tagsStr}`,
        );

        if (t.description) {
          const descIndent = "    ";
          lines.push(
            `${descIndent}${th.fg("dim", truncateToWidth(t.description, width - visibleWidth(descIndent)))}`,
          );
        }
      }
    }

    lines.push("");
    lines.push(
      `  ${th.fg("dim", "[1]All [2]Pending [3]In-prog [4]Done [5]Overdue · Esc to close")}`,
    );
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ─── Profile Viewer Component (for /clerk_profile command) ───

export class ClerkProfileComponent {
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(theme: Theme, onClose: () => void) {
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const profile = getProfile();
    const th = this.theme;
    const lines: string[] = [];

    lines.push("");
    const title = th.fg("accent", " Clerk Profile ");
    const prefix = th.fg("borderMuted", "─".repeat(2)) + title;
    const pw = visibleWidth(prefix);
    const headerLine = prefix + th.fg("borderMuted", "─".repeat(Math.max(0, width - pw)));
    lines.push(headerLine);
    lines.push("");

    // Personality
    lines.push(`  ${th.fg("toolTitle", th.bold("Personality"))}`);
    lines.push(`    Name: ${th.fg("accent", profile.personality.name)}`);
    lines.push(`    Tone: ${th.fg("muted", profile.personality.tone)}`);
    lines.push(`    ${th.fg("dim", profile.personality.description)}`);
    lines.push("");

    // Rules
    const rules = profile.rules;
    lines.push(`  ${th.fg("toolTitle", th.bold(`Rules (${rules.length})`))}`);
    for (const r of rules) {
      const weightBar = makeBar(r.weight, 10);
      const stabilityBar = makeBar(r.stabilityScore, 10);
      const prot = r.protected ? ` ${th.fg("error", "🔒")}` : "";
      lines.push(
        `    ${th.fg("accent", r.id)}${prot}: ${th.fg("dim", truncateToWidth(r.content, width - visibleWidth(`    ${th.fg("accent", r.id)}${prot}: `)))}`,
      );
      const ruleStatsLine = `      weight=${weightBar} stability=${stabilityBar}${r.category ? ` ${th.fg("muted", r.category)}` : ""}`;
      lines.push(truncateToWidth(ruleStatsLine, width));
    }

    // Interests
    const interests = profile.userInterests;
    if (interests.length > 0) {
      lines.push("");
      lines.push(
        `  ${th.fg("toolTitle", th.bold(`Interests (${interests.length})`))}`,
      );
      for (const i of interests) {
        const priorityColor =
          i.priority === "high"
            ? th.fg("error", i.priority)
            : i.priority === "medium"
              ? th.fg("warning", i.priority)
              : th.fg("muted", i.priority);
        const interestLine = `    ${th.fg("accent", i.topic)} · ${priorityColor} · ${th.fg("dim", `last: ${new Date(i.lastMentioned).toLocaleDateString("ru-RU")}`)}`;
      lines.push(truncateToWidth(interestLine, width));
      }
    }

    // Ping behavior
    lines.push("");
    lines.push(`  ${th.fg("toolTitle", th.bold("Ping Behavior"))}`);
    lines.push(
      `    Response rate: ${makeBar(profile.pingBehavior.userResponseRate, 10)}`,
    );
    lines.push(
      `    Min interval: ${th.fg("accent", `${profile.pingBehavior.minIntervalMinutes}min`)}`,
    );
    const moodsLine = `    Moods: ${th.fg("muted", profile.pingBehavior.preferredMoods.join(", "))}`;
    lines.push(truncateToWidth(moodsLine, width));

    // Metadata
    lines.push("");
    lines.push(`  ${th.fg("toolTitle", th.bold("Metadata"))}`);
    const metaLine = `    Version: ${th.fg("accent", profile.metadata.version)} · Sleep cycles: ${th.fg("accent", String(profile.metadata.totalSleepCycles))} · Created: ${th.fg("dim", new Date(profile.metadata.createdAt).toLocaleDateString("ru-RU"))}`;
    lines.push(truncateToWidth(metaLine, width));

    lines.push("");
    lines.push(`  ${th.fg("dim", "Press Escape to close")}`);
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ─── Helpers ───

/**
 * Make a simple visual bar
 */
function makeBar(value: number, segments: number): string {
  const filled = Math.round(value * segments);
  const empty = segments - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}