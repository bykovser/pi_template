// ===========================================
// CLERK BEEHIVE — Фоновая очередь subagent'ов
// ===========================================
//
// Через pi -c запускает задачи в фоновых процессах.
// Я (Жанна) не блокируюсь — subagent'ы бегут сами.
//
// Структура:
//   beehive/inbox/_taskName.json    — задача для subagent
//   beehive/outbox/_taskName.json   — результат от subagent
//   beehive/active.json             — список активных/готовых задач
//

import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { generateId } from "./utils.ts";

// ─── Types ────────────────────────────────────

export interface BeeTask {
  id: string;
  agent: string;          // имя агента (consolidator, scout, ...)
  task: string;           // текст задачи
  assigner?: string;      // кто поставил задачу (queenId)
  executor?: string;      // кто выполняет (queenId or agent name)
  args?: string[];        // доп аргументы pi -c
  createdAt: string;      // ISO
  status: "pending" | "running" | "done" | "failed";
  resultFile?: string;    // путь к файлу с результатом
  error?: string;
}

export interface BeeStatus {
  tasks: BeeTask[];
  lastCheck: string;
}

// ─── Paths ────────────────────────────────────

const BEE_DIR = path.join(import.meta.dirname || __dirname, "beehive");
const INBOX_DIR = path.join(BEE_DIR, "inbox");
const OUTBOX_DIR = path.join(BEE_DIR, "outbox");
const ACTIVE_FILE = path.join(BEE_DIR, "active.json");
const PI_PATH = path.join(process.env.LOCALAPPDATA || "C:\\Users\\sas\\AppData\\Local", "pi-node", "current", "pi");

// ─── Init ─────────────────────────────────────

export function initBeehive(): void {
  for (const dir of [BEE_DIR, INBOX_DIR, OUTBOX_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(ACTIVE_FILE)) {
    writeActive({ tasks: [], lastCheck: new Date().toISOString() });
  }
}

// ─── Queue a task ─────────────────────────────

export function queueTask(agent: string, task: string, assigner?: string, executor?: string): BeeTask {
  const myId = process.pid + "@" + require("os").hostname();
  const beeTask: BeeTask = {
    id: generateId("bee"),
    agent,
    task,
    assigner: assigner || myId,
    executor: executor || agent,
    createdAt: new Date().toISOString(),
    status: "pending",
  };

  // Пишем задачу в inbox
  const filePath = path.join(INBOX_DIR, `${beeTask.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(beeTask, null, 2), "utf-8");

  // Обновляем active.json
  const active = readActive();
  active.tasks.push(beeTask);
  active.lastCheck = new Date().toISOString();
  writeActive(active);

  console.log(`[Beehive] Queued task ${beeTask.id} for agent '${agent}'`);
  return beeTask;
}

// ─── Process inbox (запускает pi -c) ─────────

/**
 * Проверить inbox, запустить subagent'ы в фоне
 * Вызывается из tick()
 */
export function processInbox(): void {
  const active = readActive();
  let changed = false;

  for (const task of active.tasks) {
    if (task.status !== "pending") continue;

    const inboxFile = path.join(INBOX_DIR, `${task.id}.json`);
    if (!fs.existsSync(inboxFile)) continue;

    // Меняем статус на running
    task.status = "running";
    task.resultFile = path.join(OUTBOX_DIR, `${task.id}.json`);
    changed = true;

    // Формируем задачу для pi -c
    const agentFile = path.join(
      process.env.HOME || process.env.USERPROFILE || "C:\\Users\\sas",
      ".pi", "agent", "agents", `${task.agent}.md`
    );

    // Если файл агента есть — читаем его промпт
    let agentPrompt = "";
    if (fs.existsSync(agentFile)) {
      const agentContent = fs.readFileSync(agentFile, "utf-8");
      // Берём всё после ---
      const parts = agentContent.split("---");
      if (parts.length >= 3) {
        agentPrompt = parts.slice(2).join("---").trim();
      } else {
        agentPrompt = agentContent;
      }
    }

    // Команда для pi -c
    const command = [
      `Ты — ${task.agent}. ${agentPrompt ? agentPrompt + "\n\n" : ""}`,
      `Задача: ${task.task}`,
      `Результат запиши в файл: ${task.resultFile}`,
      `Используй JSON формат: {"result": "...", "status": "done", "facts": [...]}`,
    ].join("\n");

    // Запускаем в фоне через setTimeout (не блокирует tick)
    // Передаём задачу через temp-файл — cmd не любит длинные аргументы с кавычками
    const promptFile = path.join(BEE_DIR, `${task.id}_prompt.txt`);
    fs.writeFileSync(promptFile, command, "utf-8");

    let model = "openrouter/deepseek/deepseek-v4-flash";
    if (agentFile && fs.existsSync(agentFile)) {
      const meta = fs.readFileSync(agentFile, "utf-8").split("---")[1] || "";
      const modelMatch = meta.match(/model:\s*(\S+)/);
      if (modelMatch) model = modelMatch[1];
    }
    const piCmd = `"${PI_PATH}" --no-session --print --no-extensions --model ${model} "Прочитай файл ${promptFile} и выполни задание из него. Результат в JSON: ${task.resultFile}."`;
    const logFile = path.join(OUTBOX_DIR, `${task.id}.log`);

    setTimeout(() => {
      exec(piCmd, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
        // Пишем лог
        const log = [
          `Task: ${task.id}`,
          `Agent: ${task.agent}`,
          `Cmd: ${piCmd}`,
          `Exit: ${err ? err.message : "ok"}`,
          `Stdout: ${(stdout || "").slice(0, 1000)}`,
          `Stderr: ${(stderr || "").slice(0, 1000)}`,
        ].join("\n");
        fs.writeFileSync(logFile, log, "utf-8");

        const activeNow = readActive();
        const t = activeNow.tasks.find(t => t.id === task.id);
        if (!t) return;

        if (err) {
          t.status = "failed";
          t.error = err.message;
          console.log(`[Beehive] Task ${task.id} failed:`, err.message);
        } else {
          t.status = "done";
          console.log(`[Beehive] Task ${task.id} done`);
        }
        writeActive(activeNow);
        // Чистим temp-файл
        try { fs.unlinkSync(promptFile); } catch {}
      });
    }, 500); // небольшая задержка чтобы tick не ждал
  }

  if (changed) {
    active.lastCheck = new Date().toISOString();
    writeActive(active);
  }
}

// ─── Check outbox (проверить завершённые) ────

/**
 * Проверить outbox — есть ли новые готовые результаты
 * Возвращает список задач, которые только что завершились
 */
export function checkOutbox(): BeeTask[] {
  const active = readActive();
  const completed: BeeTask[] = [];

  for (const task of active.tasks) {
    // Уже помечен как done — скип (уже обработано)
    if (task.status === "done" || task.status === "failed") continue;

    // Есть файл результата?
    if (task.resultFile && fs.existsSync(task.resultFile)) {
      task.status = "done";
      completed.push(task);
    }
  }

  if (completed.length > 0) {
    active.lastCheck = new Date().toISOString();
    writeActive(active);
  }

  return completed;
}

// ─── Get bee status ───────────────────────────

export function getBeeStatus(): string {
  const active = readActive();
  if (active.tasks.length === 0) return "🐝 Улей пуст. Нет активных задач.";

  const lines: string[] = ["🐝 **Улей:**", ""];
  for (const t of active.tasks) {
    const icon = t.status === "pending" ? "⏳" 
      : t.status === "running" ? "🐝" 
      : t.status === "done" ? "✅" 
      : "❌";
    
    const since = timeSince(new Date(t.createdAt));
    lines.push(`${icon} \`${t.id}\` **${t.agent}** — ${since}`);
    lines.push(`   " ${t.task.slice(0, 100)}${t.task.length > 100 ? "..." : ""}"`);
    if (t.status === "running") lines.push(`   ⏱ запущен`);
    if (t.status === "failed") lines.push(`   ❌ ${t.error || "ошибка"}`);
    if (t.status === "done") lines.push(`   ✅ результат: ${t.resultFile}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Read/Write active ────────────────────────

function readActive(): BeeStatus {
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_FILE, "utf-8"));
  } catch {
    return { tasks: [], lastCheck: new Date().toISOString() };
  }
}

function writeActive(status: BeeStatus): void {
  fs.writeFileSync(ACTIVE_FILE, JSON.stringify(status, null, 2), "utf-8");
}

// ─── Utils ────────────────────────────────────

function timeSince(date: Date): string {
  const diff = Date.now() - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}с назад`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}м назад`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}ч ${mins % 60}м назад`;
}