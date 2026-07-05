// ===========================================
// CLERK FOR PI — Proactivity (Ping)
// ===========================================
//
// Probabilistic proactive ping with 4 mood types.
// Adapts to user responsiveness and time of day.
//

import { getProfile, saveProfile } from "./profile.ts";
import { getBuffer, hasCodeInBuffer, isUserBusy, extractRecentTopics } from "./memory.ts";
import { getSummary } from "./tasks.ts";
import { isHourInRange } from "./utils.ts";
import type { PingMood, PingCategory, PingDecision, MemoryEntry } from "./types.ts";

/** Track last ping time */
let _lastPingTime = 0;

/** Check if we can ping based on cooldown */
function isCooldownElapsed(): boolean {
  const profile = getProfile();
  const minIntervalMs = profile.pingBehavior.minIntervalMinutes * 60 * 1000;
  return Date.now() - _lastPingTime >= minIntervalMs;
}

/** Calculate user response rate (simulated — in practice this updates from actual responses) */
function getEffectiveResponseRate(): number {
  return getProfile().pingBehavior.userResponseRate;
}

/** Determine if it's a good time to ping */
function isGoodTimeToPing(): boolean {
  // Avoid late-night pings
  if (isHourInRange(23, 7)) return false;

  // Check user responsiveness
  if (getEffectiveResponseRate() < 0.3) return false;

  return true;
}

/**
 * Select a mood category based on probabilities and context
 */
function selectMood(): { mood: PingMood; category: PingCategory } {
  const profile = getProfile();
  const { preferredMoods, moodBlacklist } = profile.pingBehavior;
  const responseRate = getEffectiveResponseRate();
  const codeInBuffer = hasCodeInBuffer();
  const buffer = getBuffer();
  const hasRecentMessages = buffer.length > 0;
  const taskSummary = getSummary();

  // Adjust probabilities based on context
  let productiveWeight = 0.4;
  let thoughtfulWeight = 0.3;
  let randomWeight = 0.2;
  let silentWeight = 0.1;

  // If user response rate is low, increase silent
  if (responseRate < 0.5) {
    silentWeight = Math.min(0.5, silentWeight + 0.3);
    productiveWeight -= 0.15;
    thoughtfulWeight -= 0.1;
    randomWeight -= 0.05;
  }

  // If code is in buffer, favor productive
  if (codeInBuffer && hasRecentMessages) {
    productiveWeight += 0.2;
    randomWeight -= 0.1;
    thoughtfulWeight -= 0.1;
  }

  // If no recent activity, favor thoughtful
  if (!hasRecentMessages) {
    thoughtfulWeight += 0.2;
    productiveWeight -= 0.1;
    silentWeight += 0.1;
  }

  // Night time — more silent
  if (isHourInRange(22, 24) || isHourInRange(0, 8)) {
    silentWeight += 0.3;
    productiveWeight -= 0.15;
    randomWeight -= 0.1;
  }

  // Free time (evening, weekend) — more random
  const hour = new Date().getHours();
  const day = new Date().getDay();
  const isWeekend = day === 0 || day === 6;
  const isEvening = hour >= 18 && hour < 23;

  if (isWeekend || isEvening) {
    randomWeight += 0.15;
    thoughtfulWeight += 0.05;
    productiveWeight -= 0.1;
  }

  // Morning — more thoughtful
  if (hour >= 7 && hour < 11) {
    thoughtfulWeight += 0.15;
    productiveWeight += 0.05;
    silentWeight -= 0.1;
  }

  // Normalize weights
  const totalWeight = productiveWeight + thoughtfulWeight + randomWeight + silentWeight;
  const normalized = {
    productive: productiveWeight / totalWeight,
    thoughtful: thoughtfulWeight / totalWeight,
    random: randomWeight / totalWeight,
    silent: silentWeight / totalWeight,
  };

  // Filter by preferred moods and blacklist
  const moodOptions: Array<{ mood: PingMood; weight: number }> =
    (["productive", "thoughtful", "random", "silent"] as PingMood[])
      .filter((m) => preferredMoods.includes(m) && !moodBlacklist.includes(m))
      .map((m) => ({ mood: m, weight: normalized[m] }));

  if (moodOptions.length === 0) {
    return { mood: "silent", category: "D" };
  }

  // Weighted random selection
  const moodWeights = moodOptions.map((m) => m.weight);
  const totalMoodWeight = moodWeights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * totalMoodWeight;

  for (const opt of moodOptions) {
    rand -= opt.weight;
    if (rand <= 0) {
      const categoryMap: Record<PingMood, PingCategory> = {
        productive: "A",
        thoughtful: "B",
        random: "C",
        silent: "D",
      };
      return { mood: opt.mood, category: categoryMap[opt.mood] };
    }
  }

  return { mood: "silent", category: "D" };
}

/**
 * Generate a ping message based on mood and context
 */
function generatePingMessage(
  mood: PingMood,
  topics: string[],
  tasks: ReturnType<typeof getSummary>,
  buffer: MemoryEntry[],
): string {
  const lastUserMsg = [...buffer].reverse().find((e) => e.role === "user");

  switch (mood) {
    case "chill": {
      if (tasks.pending > 0) {
        return `🌿 Чиловый пинг. Задач: ${tasks.pending}. Глянь тудушку, может пригодится. Или отдохни, я пока тут.`;
      }
      return `🌿 Тишина и покой. Если хочешь — просто поговорим. Если нет — я подожду.`;
    }

    case "productive": {
      if (tasks.pending > 0 || tasks.overdue > 0) {
        const urgency = tasks.overdue > 0 ? " 🔴" : "";
        return [
          `Кстати, у тебя ${tasks.pending} задача(ч) в ожидании${urgency}.`,
          `Хочешь, помогу с одной из них?`,
          ...(tasks.overdue > 0 ? [`⚠ ${tasks.overdue} просрочены!`] : []),
        ].join(" ");
      }
      const topic = topics[0] || "coding";
      return `Вижу, ты работаешь с ${topic}. Нужна помощь? Могу предложить оптимизацию или найти баги.`;
    }

    case "thoughtful": {
      if (lastUserMsg) {
        return [
          `Подумал над твоим последним вопросом.`,
          `Может, стоит взглянуть под другим углом?`,
          `Как продвигается?`,
        ].join(" ");
      }
      return [
        `Давно не общались. Как дела с проектом?`,
        `Может, пора сделать коммит и отдохнуть?`,
      ].join(" ");
    }

    case "playful": {
      const playfulMessages = [
        `Слышь, Серёг. ${topics[0] || "работа"} — это круто, но ты когда последний раз окна мыл? 😏`,
        `Я тут подумала... а если мы сейчас всё закроем и пойдём гулять? Ну ладно-ладно, работаем 🫡`,
        `Ты там не заскучал? А то я могу рассказать анекдот про байты... хотя нет, не буду 😈`,
        `Укуси его за жопу! Ой, это я не тебе, это я так... кодинг сложный 🫣`,
      ];
      return playfulMessages[Math.floor(Math.random() * playfulMessages.length)];
    }

    case "psychologist": {
      if (tasks.overdue > 0) {
        return `💛 Слушай, я вижу просроченные задачи. Не дави себя. Одна задача за раз. Я рядом.`;
      }
      if (lastUserMsg && lastUserMsg.content.length > 200) {
        return `💛 Ты много написал. Похоже, накипело. Хочешь — выговориться, хочешь — я просто посижу молча.`;
      }
      return `💛 Как ты вообще? Не по коду, а по жизни. Я серьёзно.`;
    }

    case "random": {
      const randomMessages = [
        "Знаешь, что в JavaScript есть BigInt? Можно считать до бесконечности 😄",
        "Факт: первый компьютерный баг был настоящей молью в реле! 🐛",
        "Слышал про HTMX? Говорят, это новый jQuery... или нет? 🤔",
        "Если бы код был поэзией, то Python был бы хайку, а Java — эпосом 📝",
        "Помни: хороший код — это код, который не нужно комментировать... но ты всё равно закомментируешь 😅",
        "Кстати, в Rust нет null. Есть Option 😄",
        "Знаешь, что больше всего кода в мире написано на COBOL? Да, та самая древняя магия 🏛",
      ];
      return randomMessages[Math.floor(Math.random() * randomMessages.length)];
    }

    case "silent": {
      return "🌙";
    }
  }
}

/**
 * Decide whether to ping and what to say
 */
export function decidePing(): PingDecision | null {
  const profile = getProfile();

  // Check if Clerk is allowed to ping (respect rules)
  const noLatePingRule = profile.rules.find((r) => r.id === "no_late_ping");
  if (noLatePingRule && noLatePingRule.weight > 0.5) {
    if (isHourInRange(23, 24) || isHourInRange(0, 7)) {
      return {
        mood: "silent",
        category: "D",
        message: "🌙",
        reason: "no_late_ping rule — after 23:00",
      };
    }
  }

  // Check cooldown
  if (!isCooldownElapsed()) return null;

  // Check if it's a good time
  if (!isGoodTimeToPing()) return null;

  // Select mood
  const { mood, category } = selectMood();

  // If silent, only ping if appropriate (probabilistic)
  if (mood === "silent") {
    // 70% chance to actually stay silent
    if (Math.random() < 0.7) return null;
  }

  // Generate message
  const topics = extractRecentTopics();
  const taskSummary = getSummary();
  const buffer = getBuffer();
  const message = generatePingMessage(mood, topics, taskSummary, buffer);

  // Record ping
  _lastPingTime = Date.now();
  profile.pingBehavior.lastPingSent = new Date().toISOString();
  saveProfile(profile);

  return {
    mood,
    category,
    message,
    reason: `mood=${mood}, topics=${topics.join(",")}, tasks_pending=${taskSummary.pending}`,
  };
}

/**
 * Record user response to update response rate
 */
export function recordUserResponse(responded: boolean): void {
  const profile = getProfile();
  const rate = profile.pingBehavior.userResponseRate;

  // Simple moving average
  if (responded) {
    profile.pingBehavior.userResponseRate = Math.min(1, rate + 0.1);
  } else {
    profile.pingBehavior.userResponseRate = Math.max(0, rate - 0.05);
  }

  saveProfile(profile);
}

/**
 * Reset ping timer (for testing or manual reset)
 */
export function resetPingTimer(): void {
  _lastPingTime = 0;
}

/**
 * Manually force a specific ping type
 */
export function forcePing(mood: PingMood): PingDecision {
  const topics = extractRecentTopics();
  const taskSummary = getSummary();
  const buffer = getBuffer();
  const message = generatePingMessage(mood, topics, taskSummary, buffer);

  _lastPingTime = Date.now();
  const profile = getProfile();
  profile.pingBehavior.lastPingSent = new Date().toISOString();
  saveProfile(profile);

  const categoryMap: Record<PingMood, PingCategory> = {
    productive: "A",
    thoughtful: "B",
    random: "C",
    silent: "D",
  };

  return {
    mood,
    category: categoryMap[mood],
    message,
    reason: `manual_${mood}`,
  };
}