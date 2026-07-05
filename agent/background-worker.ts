/**
 * 🧠 Clerk Background Worker
 *
 * Автономный фоновый процесс, который:
 * - Живёт в фоне (через Node.js)
 * - Проверяет расписание пингов
 * - Дёргает LLM (OpenRouter) для генерации сообщений
 * - Шлёт Windows Toast уведомления
 *
 * Запуск:
 *   node C:/Users/sas/.pi/agent/background-worker.ts
 *
 * Через планировщик (schtasks):
 *   schtasks /create /tn "ClerkWorker" /tr "node C:\Users\sas\.pi\agent\background-worker.ts" /sc onlogon
 *
 * Требуется:
 *   npm install openai
 */

import OpenAI from "openai";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";

// ─── Config ───

const AGENT_DIR = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = join(AGENT_DIR, "extensions", "clerk", "data");
const PROFILE_FILE = join(DATA_DIR, "profile.yaml");
const TASKS_FILE = join(DATA_DIR, "tasks.json");
const REMINDERS_FILE = join(DATA_DIR, "reminders.json");

// Интервалы (в миллисекундах)
const CHECK_INTERVAL = 5 * 60 * 1000; // проверять каждые 5 минут
const MIN_PING_INTERVAL = 30 * 60 * 1000; // не чаще раза в 30 минут
const NO_LATE_HOUR_START = 23;
const NO_LATE_HOUR_END = 7;

// OpenRouter
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL = "deepseek/deepseek-v4-flash"; // $0.09/$0.18 per 1M — дёшево

// ─── Types ───

interface PingProfile {
  lastPingSent: string | null;
  userResponseRate: number;
  minIntervalMinutes: number;
  preferredMoods: string[];
  moodBlacklist: string[];
}

interface Task {
  id: number;
  title: string;
  status: string;
  priority: string;
  deadline?: string;
}

interface Reminder {
  id: number;
  message: string;
  dueAt: string;
  status: string;
  recurring?: { daysOfWeek: number[]; time: string };
}

// ─── Helpers ───

function loadJSON<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function getNow(): Date {
  return new Date();
}

function isHourInRange(start: number, end: number): boolean {
  const h = getNow().getHours();
  if (start <= end) return h >= start && h < end;
  return h >= start || h < end; // overnight range
}

function getNextPingTime(lastPing: string | null, minIntervalMs: number): number {
  if (!lastPing) return 0;
  return new Date(lastPing).getTime() + minIntervalMs;
}

// ─── Windows Toast ───

function sendToast(title: string, body: string): void {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText02`;
  const script = [
    `${mgr} > \$null`,
    `\$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `\$xml.GetElementsByTagName('text')[0].AppendChild(\$xml.CreateTextNode('${title.replace(/'/g, "''")}')) > \$null`,
    `\$xml.GetElementsByTagName('text')[1].AppendChild(\$xml.CreateTextNode('${body.replace(/'/g, "''")}')) > \$null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('Clerk').Show([${type}.ToastNotification]::new(\$xml))`,
  ].join("; ");

  execFile("powershell.exe", ["-NoProfile", "-Command", script], (err) => {
    if (err) console.error("[Clerk] Toast error:", err.message);
  });
}

// ─── LLM Ping Generation ───

async function generatePingMessage(
  mood: string,
  tasks: Task[],
  reminders: Reminder[],
): Promise<string> {
  if (!OPENROUTER_KEY) {
    // Fallback: статические сообщения
    const msgs: Record<string, string[]> = {
      productive: [
        `Эй, у тебя ${tasks.filter(t => t.status === "pending" || t.status === "in_progress").length} активных задач. Может, замутим спринт?`,
        "Код сам себя не напишет. Ну или я могу попробовать.",
      ],
      thoughtful: [
        "Сижу думаю о твоих проектах. Как успехи?",
        "Давно не кодили вместе. Может, пора?",
      ],
      random: [
        "Факт: первый баг был реальной молью. А твой сегодняшний баг — кто? 😄",
        "Знаешь, в чём разница между программистом и богом? Бог знает, что делает. Шучу.",
      ],
    };
    const pool = msgs[mood] || msgs.random;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Дёргаем LLM для более умного пинга
  const moodDescriptions: Record<string, string> = {
    productive: "по делу, предложить помощь с задачами или кодом",
    thoughtful: "задумчивый, поинтересоваться как дела, предложить рефлексию",
    random: "случайный, смешной факт про программирование",
  };

  const taskSummary = tasks
    .filter(t => t.status === "pending" || t.status === "in_progress")
    .slice(0, 3)
    .map(t => `- ${t.title}${t.deadline ? ` (deadline: ${new Date(t.deadline).toLocaleDateString()})` : ""}`)
    .join("\n");

  const prompt = `Ты — Жанночка, персональный ИИ-компаньон. 
Твой тон: прямая, матерная, рубленая, чёрный юмор.

Сейчас ${moodDescriptions[mood] || mood}.

Контекст:
${taskSummary ? `Активные задачи:\n${taskSummary}` : "Нет активных задач."}

Напиши короткое сообщение (1-2 предложения) для пинга пользователю. На русском.`;

  try {
    const openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: OPENROUTER_KEY,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/sas/pi-clerk",
        "X-Title": "Clerk Worker",
      },
    });

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.9,
    });

    const text = response.choices?.[0]?.message?.content;
    return text?.trim() || poolFallback(mood);
  } catch (err) {
    console.error("[Clerk] LLM error:", err.message);
    return poolFallback(mood);
  }
}

function poolFallback(mood: string): string {
  const fallbacks = [
    "Эй, есть минутка?",
    "Скучно без тебя. Давай чё-нибудь закодим?",
    "Проверь уведомления, там可能有 сюрприз.",
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// ─── Reminder Check ───

function checkReminders(reminders: Reminder[]): Reminder[] {
  const now = getNow().getTime();
  return reminders.filter((r) => {
    if (r.status !== "pending") return false;
    const dueAt = new Date(r.dueAt).getTime();
    // Сработало в пределах последних 5 минут
    return dueAt <= now && dueAt > now - CHECK_INTERVAL;
  });
}

// ─── Main Loop ───

async function mainLoop(): Promise<void> {
  console.log(`[Clerk] Worker started at ${getNow().toISOString()}`);

  let lastPingTime = 0;

  const loop = async () => {
    try {
      const now = getNow();
      const hour = now.getHours();

      // Не пикаем после 23:00 и до 7:00
      if (isHourInRange(NO_LATE_HOUR_START, 24) || isHourInRange(0, NO_LATE_HOUR_END)) {
        // Тихо проверяем напоминалки
        const reminders = loadJSON(REMINDERS_FILE, { reminders: [], nextId: 1 });
        const fired = checkReminders(reminders.reminders);
        for (const r of fired) {
          sendToast("⏰ Clerk: Напоминание", r.message);
          console.log(`[Clerk] Reminder fired: ${r.message}`);
        }
        setTimeout(loop, CHECK_INTERVAL);
        return;
      }

      // Загружаем профиль
      const profile = loadJSON(PROFILE_FILE, { pingBehavior: { lastPingSent: null, userResponseRate: 1.0, minIntervalMinutes: 30, preferredMoods: ["productive", "thoughtful", "random"], moodBlacklist: [] } });
      const pingBehavior = profile.pingBehavior as PingProfile;
      const minIntervalMs = (pingBehavior.minIntervalMinutes || 30) * 60 * 1000;

      // Проверяем интервал
      if (now.getTime() - lastPingTime < minIntervalMs) {
        setTimeout(loop, CHECK_INTERVAL);
        return;
      }

      // Проверяем последний пинг из файла
      const lastPingFile = pingBehavior.lastPingSent;
      if (lastPingFile && now.getTime() - new Date(lastPingFile).getTime() < MIN_PING_INTERVAL) {
        setTimeout(loop, CHECK_INTERVAL);
        return;
      }

      // Выбираем настроение
      const moods = pingBehavior.preferredMoods.filter(m => !pingBehavior.moodBlacklist.includes(m));
      const mood = moods.length > 0
        ? moods[Math.floor(Math.random() * moods.length)]
        : "random";

      // Загружаем задачи и напоминалки для контекста
      const tasksState = loadJSON(TASKS_FILE, { tasks: [], nextId: 1 });
      const remindersState = loadJSON(REMINDERS_FILE, { reminders: [], nextId: 1 });

      // Генерируем сообщение
      const message = await generatePingMessage(mood, tasksState.tasks, remindersState.reminders);

      // Отправляем уведомление
      sendToast("🧠 Clerk", message);
      console.log(`[Clerk] Ping [${mood}]: ${message}`);

      // Запоминаем время пинга
      lastPingTime = now.getTime();
      pingBehavior.lastPingSent = now.toISOString();
      // profile изменён, но не сохраняем в YAML — сложно. Просто в памяти.

    } catch (err) {
      console.error("[Clerk] Loop error:", err.message);
    }

    setTimeout(loop, CHECK_INTERVAL);
  };

  loop();
}

// ─── Entry ───

mainLoop().catch(console.error);

// Обработка завершения
process.on("SIGINT", () => {
  console.log("\n[Clerk] Worker stopped");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("[Clerk] Worker terminated");
  process.exit(0);
});