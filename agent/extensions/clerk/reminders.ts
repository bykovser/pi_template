// ===========================================
// CLERK FOR PI — Reminders / Scheduler
// ===========================================
//
// Backend scheduler for delayed reminders.
// - setInterval(5s) tick to fire due reminders
// - Auto-detects upcoming & overdue task deadlines
// - Persists reminders to reminders.json
// - Fires via pi.sendUserMessage()
//

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRemindersPath, readJsonFile, writeJsonFile, generateId, isHourInRange, getDataDir } from "./utils.ts";
import { getProfile } from "./profile.ts";
import { getUpcomingDeadlines, getOverdueTasks } from "./tasks.ts";
import type { Reminder, ReminderSource, ReminderStatus, SchedulerState, PingMood, RecurringSchedule } from "./types.ts";
import { initBeehive, processInbox, checkOutbox, getBeeStatus, queueTask } from "./beehive.ts";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── State ───

/** In-memory scheduler state */
let _state: SchedulerState = readJsonFile<SchedulerState>(getRemindersPath(), {
  reminders: [],
  nextId: 1,
});

/** Reference to pi API for sending messages */
let _pi: ExtensionAPI | null = null;

/** Interval handle */
let _intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Track which task IDs we've auto-created reminders for */
let _trackedTaskIds = new Set<number>();

/** Track which overdue tasks we've already notified about */
let _notifiedOverdueIds = new Set<number>();

/** WorkMode timer — last ping time */
let _lastWorkModePing = Date.now();
let _workModeTimerEnabled = true;

/** Track last LLM response time (for workmode cooldown) */
let _lastLLMResponse = Date.now();
/** Track last user input time (for workmode cooldown) */
let _lastUserInput = Date.now();
/** Sleep cycle — был ли уже отправлен запрос на консолидацию */
let _sleepCyclePending = false;
/** Sleep cycle — когда был последний запуск (не чаще 1 раза за 4 часа) */
let _sleepCycleLastRun = 0;
/** AFK — флаг что Серёга отошёл (нет user input > 30 мин) */
let _afk = false;
/** AFK — время последнего уведомления в TG (не чаще 1 раза в 10 мин) */
let _afkLastNotified = 0;

/** Current mood for workmode timer interval */
let _currentMood: PingMood | null = null;

/** Mood → workmode interval in ms */
const MOOD_INTERVALS: Record<string, number> = {
  chill: 15 * 60_000,       // 15 мин
  productive: 2 * 60_000,   // 2 мин
  thoughtful: 5 * 60_000,   // 5 мин
  playful: 10 * 60_000,     // 10 мин
  psychologist: 5 * 60_000, // 5 мин
  silent: 120 * 60_000,     // 120 мин
};
const DEFAULT_WORKMODE_INTERVAL = 2 * 60_000; // fallback 2 мин

/** Mood → think level */
const MOOD_THINK_LEVELS: Record<string, string> = {
  chill: "off",
  productive: "high",
  thoughtful: "xhigh",
  playful: "off",
  psychologist: "high",
  silent: "off",
};

export function updateLLMResponseTime(): void { _lastLLMResponse = Date.now(); _sleepCyclePending = false; }
export function updateUserInputTime(): void { _lastUserInput = Date.now(); _sleepCyclePending = false; _afk = false; }
export function getAfkStatus(): boolean { return _afk; }
export function setCurrentMood(mood: PingMood | null): void { _currentMood = mood; }

// ─── Init / Teardown ───

/**
 * Initialize the scheduler. Call on session_start.
 * Starts a setInterval tick every 5 seconds.
 */
export function initScheduler(pi: ExtensionAPI): void {
  _pi = pi;

  // Load tracked tasks from existing reminders
  for (const r of _state.reminders) {
    if (r.status === "pending" && r.taskId !== undefined) {
      _trackedTaskIds.add(r.taskId);
    }
  }

  // Start interval
  if (_intervalHandle) clearInterval(_intervalHandle);
  _intervalHandle = setInterval(tick, 5000);

  // Also check immediately on init
  tick();

  // ─── Queen System ───
  // При старте проверяем: кто матка?
  try {
    const beeDir = path.join(getDataDir(), "..", "beehive");
    const activePath = path.join(beeDir, "active.json");
    const myId = process.pid + "@" + require("os").hostname();

    let active: any;
    try { active = JSON.parse(fs.readFileSync(activePath, "utf-8")); }
    catch { active = { tasks: [], lastCheck: new Date().toISOString() }; }

    const queen = active.queen;
    if (queen && queen.id !== myId && (Date.now() - new Date(queen.lastSeen).getTime()) < 120_000) {
      console.log("[Clerk] Worker mode — queen is", queen.id);
      setWorkModeTimer(false);
    } else {
      console.log("[Clerk] Queen mode — I am the queen");
      active.queen = { id: myId, lastSeen: new Date().toISOString(), startedAt: new Date().toISOString() };
      fs.writeFileSync(activePath, JSON.stringify(active, null, 2));
      setWorkModeTimer(true);
    }
  } catch (e) {
    console.error("[Clerk] Queen init error:", e);
    setWorkModeTimer(true);
  }

  // Auto-wake after reload: ставим chill mood и форсим пинг через 5 сек
  if (true) {
    _currentMood = "chill";
    setTimeout(() => {
      if (!_pi) return;
      console.log("[Clerk] Auto-wake ping after init/reload (chill)");
      _pi.sendUserMessage("/clerk_ping workmode", { deliverAs: "user" });
    }, 5000);
  }
}

/**
 * Stop the scheduler. Call on session_shutdown.
 */
export function stopScheduler(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
  _pi = null;
}

// ─── Core Tick ───

/**
 * Main scheduler tick — runs every 5 seconds
 */
/**
 * Enable/disable the WorkMode interval timer
 */
export function setWorkModeTimer(enabled: boolean): void {
  _workModeTimerEnabled = enabled;
  if (enabled) {
    _lastWorkModePing = Date.now();
    console.log("[Clerk] WorkMode timer enabled");
    // Пишем workmode lock
    try {
      const lockPath = path.join(getDataDir(), "..", "beehive", "workmode.lock");
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, time: Date.now() }, null, 2));
    } catch (_e) { /* lock file не критичен */ }
  } else {
    console.log("[Clerk] WorkMode timer disabled");
    // Удаляем workmode lock
    try {
      const lockPath = path.join(getDataDir(), "..", "beehive", "workmode.lock");
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch (_e) { /* lock file не критичен */ }
  }
}

function tick(): void {
  try {
    // 0. Queen heartbeat — обновляем lastSeen, проверяем жива ли матка
    queenHeartbeat(getDataDir());

    // 0. WorkMode timer — modulo check every 2 min
    fireWorkModePing();

    // 0.3. Sleep cycle check — если вечер + тишина >1 часа
    checkSleepCycle();

    // 0.4. AFK check — если Серёга отошёл > 30 мин
    checkAFK();

    // 0.5. Beehive — process inbox, check outbox
    processInbox();
    const completed = checkOutbox();
    for (const task of completed) {
      console.log(`[Clerk] Beehive task ${task.id} (${task.agent}) completed`);
      if (_pi && task.status === "done") {
        // Читаем результат
        let resultPreview = "";
        if (task.resultFile) {
          try {
            const content = fs.readFileSync(task.resultFile, "utf-8").slice(0, 300);
            resultPreview = `\nРезультат: ${content}`;
          } catch {}
        }
        _pi.sendUserMessage(
          `🐝 **${task.agent}** задачу \`${task.id}\` завершил!${resultPreview}`,
          { deliverAs: "followUp" }
        );
      }
    }

    // 1. Fire due reminders
    fireDueReminders();

    // 2. Check task deadlines for auto-reminders
    checkTaskDeadlines();

    // 3. Check overdue tasks
    checkOverdueTasks();

    // 4. Clean up old fired reminders (keep max 50)
    cleanup();
  } catch (err) {
    console.error("[Clerk] Scheduler tick error:", err);
  }
}

// ─── Queen Heartbeat ───

/**
 * Queen System heartbeat — обновляет lastSeen в active.json каждые 60 секунд
 * И проверяет: если матка умерла — перехватываем роль
 */
function queenHeartbeat(dataDir: string): void {
  try {
    const beeDir = path.join(dataDir, "..", "beehive");
    const activePath = path.join(beeDir, "active.json");
    const myId = process.pid + "@" + require("os").hostname();

    const raw = fs.readFileSync(activePath, "utf-8");
    const active = JSON.parse(raw);
    const queen = active.queen;
    if (!queen) {
      // Нет матки — становлюсь
      console.log("[Clerk] Heartbeat: no queen → I am queen");
      active.queen = { id: myId, lastSeen: new Date().toISOString(), startedAt: new Date().toISOString() };
      fs.writeFileSync(activePath, JSON.stringify(active, null, 2));
      setWorkModeTimer(true);
      return;
    }

    if (queen.id === myId) {
      // Я матка — обновляю heartbeat раз в 60 сек
      const elapsed = Date.now() - new Date(queen.lastSeen).getTime();
      if (elapsed > 60_000) {
        active.queen.lastSeen = new Date().toISOString();
        fs.writeFileSync(activePath, JSON.stringify(active, null, 2));
      }
    } else {
      // Другая матка — проверяем жива ли
      const elapsed = Date.now() - new Date(queen.lastSeen).getTime();
      if (elapsed > 180_000) {
        // Матка не отвечала 3+ мин — перехватываем
        console.log("[Clerk] Heartbeat: queen dead (", elapsed/1000, "s) → I am queen");
        active.queen = { id: myId, lastSeen: new Date().toISOString(), startedAt: new Date().toISOString() };
        fs.writeFileSync(activePath, JSON.stringify(active, null, 2));
        setWorkModeTimer(true);
        if (_pi) {
          _pi.sendUserMessage("🐝 Я перехватила роль матки — прежняя не отвечала 3+ мин.", { deliverAs: "user" });
        }
      }
    }
  } catch (_e) {
    // Нет active.json или ошибка — не фатально, пробуем в следующем тике
  }
}

// ─── Sleep Cycle Auto-Trigger ───

/**
 * Проверяет условия для авто-запуска sleep cycle:
 * 1. Время 22:00–06:00 MSK
 * 2. Тишина >1 часа (нет юзерского ввода и LLM ответа)
 * 3. Не чаще 1 раза в 4 часа
 *
 * Если условия совпадают — отправляет /clerk_ping sleep_cycle
 */
function checkSleepCycle(): void {
  if (!_pi) return;
  if (_sleepCyclePending) return;

  // Не чаще 1 раза в 4 часа
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  if (Date.now() - _sleepCycleLastRun < FOUR_HOURS) return;

  // Время 22:00–06:00 MSK (+3 UTC)
  const mskHour = (new Date().getUTCHours() + 3) % 24;
  if (mskHour < 22 && mskHour >= 6) return;

  // Тишина >1 часа
  const ONE_HOUR = 60 * 60 * 1000;
  const userIdle = Date.now() - _lastUserInput;
  const llmIdle = Date.now() - _lastLLMResponse;
  if (userIdle < ONE_HOUR || llmIdle < ONE_HOUR) return;

  // Все условия выполнены — запускаем sleep cycle
  _sleepCyclePending = true;
  _sleepCycleLastRun = Date.now();
  console.log("[Clerk] Sleep cycle trigger — idle >1h, time", mskHour, "MSK");
  _pi.sendUserMessage("🌙 **Sleep cycle trigger** — тишина >1 часа, время ночное. Выполняю консолидацию памяти и обновляю profile.", { deliverAs: "user" });
}

// ─── AFK Check ───

/**
 * Проверяет не отошёл ли Серёга от компа.
 * Если _lastUserInput > 30 мин — ставит _afk = true.
 * Возвращается автоматически при следующем user input (updateUserInputTime сбрасывает _afk).
 */
function checkAFK(): void {
  const idle = Date.now() - _lastUserInput;
  const wasAfk = _afk;

  if (idle > 30 * 60 * 1000) {
    _afk = true;
  } else {
    _afk = false;
  }

  if (_afk && !wasAfk) {
    console.log("[Clerk] AFK — Серёга отошёл >30 мин");
  } else if (!_afk && wasAfk) {
    console.log("[Clerk] AFK — Серёга вернулся");
  }
}

// ─── Schedule Reminders ───

/**
 * Schedule a new reminder
 */
export function scheduleReminder(params: {
  message: string;
  dueAt: string;        // ISO timestamp
  source?: ReminderSource;
  taskId?: number;
  mood?: PingMood;
  recurring?: RecurringSchedule;
}): Reminder {
  const now = new Date().toISOString();
  const reminder: Reminder = {
    id: _state.nextId++,
    message: params.message,
    dueAt: params.dueAt,
    status: "pending",
    source: params.source ?? "manual",
    taskId: params.taskId,
    mood: params.mood,
    createdAt: now,
    recurring: params.recurring,
  };

  _state.reminders.push(reminder);

  // Track task IDs for deduplication
  if (params.taskId !== undefined) {
    _trackedTaskIds.add(params.taskId);
  }

  saveState();
  return reminder;
}

/**
 * Cancel a pending reminder
 */
export function cancelReminder(id: number): boolean {
  const idx = _state.reminders.findIndex((r) => r.id === id && r.status === "pending");
  if (idx === -1) return false;

  _state.reminders[idx].status = "cancelled";
  saveState();
  return true;
}

/**
 * Cancel reminders linked to a specific task
 */
export function cancelRemindersForTask(taskId: number): number {
  let count = 0;
  for (const r of _state.reminders) {
    if (r.taskId === taskId && r.status === "pending") {
      r.status = "cancelled";
      count++;
    }
  }
  if (count > 0) saveState();
  return count;
}

/**
 * Get all pending reminders
 */
export function getPendingReminders(): Reminder[] {
  return _state.reminders.filter((r) => r.status === "pending");
}

/**
 * Get formatted reminder list for tool output
 */
export function formatRemindersList(reminders: Reminder[]): string {
  if (reminders.length === 0) return "No pending reminders.";

  return reminders
    .map((r) => {
      const due = new Date(r.dueAt);
      const now = Date.now();
      const diffMs = due.getTime() - now;
      const diffMins = Math.round(diffMs / 60000);
      const timeStr = diffMins <= 0
        ? "🔴 overdue"
        : diffMins < 60
          ? `in ${diffMins}m`
          : `in ${Math.round(diffMins / 60)}h ${diffMins % 60}m`;

      const sourceIcon = r.source === "task_deadline" ? "📋" : "⏰";
      const moodTag = r.mood ? ` [${r.mood}]` : "";

      return `${sourceIcon} #${r.id} ${r.message}${moodTag} — ${timeStr}`;
    })
    .join("\n");
}

// ─── WorkMode Interval Timer ───

const WORKMODE_INTERVAL_MS = 120_000; // 2 minutes

/**
 * WorkMode timer — fires /clerk_ping workmode every 2 minutes.
 * No state, no files, no UI. Pure modulo(seconds, 120) check.
 * The LLM decides whether to respond based on context.
 */
function fireWorkModePing(): void {
  if (!_workModeTimerEnabled) return;
  if (!_pi) return;

  const now = Date.now();

  // Use mood-based interval or default 2 min
  const mood = _currentMood || "chill";
  const interval = MOOD_INTERVALS[mood] || DEFAULT_WORKMODE_INTERVAL;
  if (now - _lastWorkModePing < interval) return;

  // Respect late-night rule
  const h = new Date().getHours();
  if (h >= 23 || h < 7) return;

  // LLM cooldown — не пикать если LLM отвечал <1 мин назад
  if (now - _lastLLMResponse < 60_000) return;
  // User cooldown — не пикать если юзер писал <2 мин назад
  if (now - _lastUserInput < 120_000) return;

  _lastWorkModePing = now;
  console.log("[Clerk] WorkMode ping at", new Date().toISOString());
  _pi.sendUserMessage("/clerk_ping workmode", { deliverAs: "user" });
}

// ─── Fire Due Reminders ───

/**
 * Fire all reminders that are due
 */
function fireDueReminders(): void {
  const now = Date.now();

  for (const reminder of _state.reminders) {
    if (reminder.status !== "pending") continue;

    const dueAt = new Date(reminder.dueAt).getTime();
    if (now < dueAt) continue;

    // Check late-night rule
    if (!canFireReminder(reminder)) {
      // Delay firing until morning — reschedule to 9 AM
      const tomorrow9am = getNextMorningTime();
      reminder.dueAt = tomorrow9am;
      reminder.updatedAt = new Date().toISOString();
      saveState();
      continue;
    }

    // Fire it!
    reminder.status = "fired";
    reminder.updatedAt = new Date().toISOString();
    saveState();

    if (_pi) {
      // If message starts with "/", send as command (appears as user input)
      if (reminder.message.startsWith("/")) {
        sendCommand(reminder.message);
      } else {
        const moodTag = reminder.mood ? `[${reminder.mood}]` : "⏰";
        const sourceTag = reminder.source === "task_deadline" ? "📋 Task deadline" : "🔔 Reminder";
        _pi.sendUserMessage(
          `[Clerk ${moodTag} — ${sourceTag}]\n${reminder.message}`,
          { deliverAs: "followUp" },
        );
      }
    }

    // Recurring: reschedule for next occurrence
    if (reminder.recurring) {
      rescheduleRecurring(reminder);
    }
  }
}

/**
 * Check if a reminder can fire now (respects late-night rules, but not for manual reminders)
 */
function canFireReminder(reminder: Reminder): boolean {
  // Manual and recurring reminders are explicitly requested by the user — always fire
  if (reminder.source === "manual" || reminder.source === "recurring") return true;

  // For auto-detected task deadlines, respect late-night rules
  const profile = getProfile();
  const noLatePingRule = profile.rules.find((r) => r.id === "no_late_ping");
  if (noLatePingRule && noLatePingRule.weight > 0.5) {
    if (isHourInRange(23, 24) || isHourInRange(0, 8)) {
      return false;
    }
  }
  return true;
}

/**
 * Get next 9 AM today or tomorrow
 */
function getNextMorningTime(): string {
  const now = new Date();
  const morning = new Date(now);
  morning.setHours(9, 0, 0, 0);

  if (morning.getTime() <= now.getTime()) {
    morning.setDate(morning.getDate() + 1);
  }

  return morning.toISOString();
}

// ─── Recurring Reminders ───

/**
 * Calculate next occurrence date from a recurring schedule
 */
function getNextRecurringDate(schedule: RecurringSchedule, afterDate: Date): Date {
  const [hours, minutes] = schedule.time.split(":").map(Number);
  const candidate = new Date(afterDate);
  candidate.setHours(hours, minutes, 0, 0);

  // If the calculated time is already past, start from tomorrow
  if (candidate.getTime() <= afterDate.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }

  // If no days specified — every day
  if (!schedule.daysOfWeek || schedule.daysOfWeek.length === 0) {
    return candidate;
  }

  // Find next matching day of week
  const daySet = new Set(schedule.daysOfWeek);
  let attempts = 0;
  while (!daySet.has(candidate.getDay()) && attempts < 14) {
    candidate.setDate(candidate.getDate() + 1);
    attempts++;
  }

  return candidate;
}

/**
 * Reschedule a recurring reminder — creates a new pending reminder
 * for the next occurrence
 */
function rescheduleRecurring(firedReminder: Reminder): Reminder | null {
  if (!firedReminder.recurring) return null;

  let nextDate: Date;
  
  // If intervalMs is set — pure interval-based recurring (every N ms)
  if (firedReminder.recurring.intervalMs) {
    nextDate = new Date(Date.now() + firedReminder.recurring.intervalMs);
  } else {
    nextDate = getNextRecurringDate(firedReminder.recurring, new Date());
  }

  const newReminder: Reminder = {
    id: _state.nextId++,
    message: firedReminder.message,
    dueAt: nextDate.toISOString(),
    status: "pending",
    source: "recurring",
    taskId: firedReminder.taskId,
    mood: firedReminder.mood,
    createdAt: new Date().toISOString(),
    recurring: { ...firedReminder.recurring },
  };

  _state.reminders.push(newReminder);
  saveState();

  console.log(`[Clerk] Rescheduled recurring reminder #${firedReminder.id} → #${newReminder.id} at ${newReminder.dueAt}`);
  return newReminder;
}

/**
 * Schedule a recurring reminder from a schedule config
 * Convenience wrapper — sets first dueAt based on schedule
 */
export function scheduleRecurring(params: {
  message: string;
  schedule: RecurringSchedule;
  mood?: PingMood;
  startFrom?: Date;
}): Reminder {
  const afterDate = params.startFrom ?? new Date();
  const dueAt = getNextRecurringDate(params.schedule, afterDate);

  return scheduleReminder({
    message: params.message,
    dueAt: dueAt.toISOString(),
    source: "recurring",
    mood: params.mood,
    recurring: params.schedule,
  });
}

/**
 * Cancel all recurring reminders matching a message (or other criteria)
 */
export function cancelRecurring(messageFilter?: string): number {
  let count = 0;
  for (const r of _state.reminders) {
    if (r.status !== "pending") continue;
    if (!r.recurring) continue;
    if (messageFilter && !r.message.includes(messageFilter)) continue;

    r.status = "cancelled";
    r.updatedAt = new Date().toISOString();
    count++;
  }
  if (count > 0) saveState();
  return count;
}

// ─── Task Deadline Monitoring ───

/**
 * Check for tasks with upcoming deadlines and auto-schedule reminders
 * Only runs if there are un-tracked tasks with deadlines within the next 2 hours
 */
function checkTaskDeadlines(): void {
  // Check deadlines within the next 2 hours
  const upcoming = getUpcomingDeadlines(120);

  for (const task of upcoming) {
    if (_trackedTaskIds.has(task.id)) continue;

    const deadline = new Date(task.deadline!).getTime();
    const now = Date.now();
    const diffMs = deadline - now;

    // Schedule a reminder 5 minutes before deadline, or immediately if < 5 min
    const remindAt = diffMs > 5 * 60 * 1000
      ? new Date(deadline - 5 * 60 * 1000).toISOString()
      : new Date(now + 10 * 1000).toISOString(); // 10 seconds from now if already close

    scheduleReminder({
      message: `⏰ Task #${task.id} "${task.title}" deadline ${task.deadline ? new Date(task.deadline).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : ""}`,
      dueAt: remindAt,
      source: "task_deadline",
      taskId: task.id,
      mood: "productive",
    });
  }
}

/**
 * Check for overdue tasks and notify if not already notified
 */
function checkOverdueTasks(): void {
  const overdue = getOverdueTasks();
  let notified = false;

  for (const task of overdue) {
    if (_notifiedOverdueIds.has(task.id)) continue;

    _notifiedOverdueIds.add(task.id);

    if (_pi) {
      _pi.sendUserMessage(
        `[Clerk 🔴 — Task Overdue]\n📋 Task #${task.id} "${task.title}" просрочена! Дедлайн был: ${task.deadline ? new Date(task.deadline).toLocaleString("ru-RU") : "не указан"}`,
        { deliverAs: "followUp" },
      );
      notified = true;
    }
  }

  if (notified) {
    // Add a small delay before next check to avoid spam
    setTimeout(() => {
      // noop — just a cooldown
    }, 60000);
  }
}

// ─── Send Commands ───

/**
 * Send a command to the chat (appears as if user typed it)
 * Uses sendUserMessage which pi processes as a command
 */
export function sendCommand(cmd: string): boolean {
  if (!_pi) {
    console.warn("[Clerk] Cannot send command — pi not initialized");
    return false;
  }
  
  try {
    _pi.sendUserMessage(cmd, { deliverAs: "user" });
    console.log(`[Clerk] Sent command: ${cmd}`);
    return true;
  } catch (err) {
    console.error(`[Clerk] Failed to send command \"${cmd}\":`, err);
    return false;
  }
}

/**
 * Schedule a delayed command — writes a reminder with the command
 * that fires after the specified delay
 */
export function scheduleCommand(params: {
  cmd: string;
  delay: number; // milliseconds
}): Reminder | null {
  const dueAt = new Date(Date.now() + params.delay).toISOString();
  return scheduleReminder({
    message: params.cmd,
    dueAt,
    source: "manual",
    mood: "productive",
  });
}

// ─── Cleanup ───

/**
 * Clean up old fired reminders, keep last 50
 */
function cleanup(): void {
  const active = _state.reminders.filter((r) => r.status === "pending");
  const fired = _state.reminders
    .filter((r) => r.status !== "pending")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);

  _state.reminders = [...active, ...fired];

  // Cap tracked task IDs to prevent memory leak
  if (_trackedTaskIds.size > 200) {
    _trackedTaskIds = new Set([..._trackedTaskIds].slice(-100));
  }
  if (_notifiedOverdueIds.size > 200) {
    _notifiedOverdueIds = new Set([..._notifiedOverdueIds].slice(-100));
  }
}

// ─── Persistence ───

function saveState(): void {
  writeJsonFile(getRemindersPath(), _state);
}

/**
 * Force check deadlines (called from turn_end for immediate feedback)
 */
export function checkTaskDeadlinesNow(): { upcoming: number; overdue: number } {
  const beforeCount = _state.reminders.filter((r) => r.status === "pending").length;
  checkTaskDeadlines();
  checkOverdueTasks();
  const afterCount = _state.reminders.filter((r) => r.status === "pending").length;

  return {
    upcoming: afterCount - beforeCount,
    overdue: getOverdueTasks().length,
  };
}

/**
 * Parse a delay string like "30s", "5m", "1h", "2h" into milliseconds
 */
export function parseDelay(delay: string): number | null {
  const match = delay.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit[0]) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

/**
 * Get scheduler state (for persistence/debug)
 */
export function getSchedulerState(): SchedulerState {
  return _state;
}