// ===========================================
// CLERK FOR PI — Entry Point
// ===========================================
//
// Integrates Profile (ROM), Memory (RAM), Tasks, Ping, Sleep,
// Sub-agents, and UI into the pi extension system.
//

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { execSync, exec } from "node:child_process";

import { loadProfile, getProfile, getRules, upsertInterest } from "./profile.ts";
import { addToBuffer, injectContext, getBuffer } from "./memory.ts";
import {
  getState,
  getSummary,
  loadState,
  listTasks,
  addTask,
  updateTask,
  deleteTask,
  formatTask,
  formatTaskList,
  saveState,
  archiveCompletedTasks,
} from "./tasks.ts";
import { decidePing, forcePing } from "./ping.ts";
import { consolidate, formatSleepInsights } from "./sleep.ts";
import { getTodos, addTodo, updateTodoStatus, deleteTodo, formatTodoList } from "./todo.ts";
import { ingestFile, getIngestHelp, getSessionFiles, parseSessionToCleanText, readSessionLines } from "./ingest.ts";
import { formatDiary, readDiaryEntries } from "./diary.ts";
import { getIsHome, setIsHome } from "./home.ts";
import { sendTelegramMessage, sendMoodMessage, sendInitialMessage, editTelegramMessage, startTyping, stopTyping, sendTelegramFile } from "./tg.ts";
import { startPoller, stopPoller, forcePoll } from "./tg_poller.ts";
import {
  initScheduler,
  stopScheduler,
  scheduleReminder,
  sendCommand,
  scheduleCommand,
  cancelReminder,
  getPendingReminders,
  formatRemindersList,
  parseDelay,
  checkTaskDeadlinesNow,
  scheduleRecurring,
  cancelRecurring,
  setWorkModeTimer,
  updateLLMResponseTime,
  updateUserInputTime,
  setCurrentMood,
  getAfkStatus,
} from "./reminders.ts";
import { buildThinkSubagentTasks, buildReviewSubagentTask } from "./subagent.ts";
import { initBeehive, getBeeStatus, queueTask } from "./beehive.ts";
import {
  buildMoodWidget,
  buildTasksWidget,
  buildRulesWidget,
  buildStatusString,
  buildDashboardWidget,
  ClerkTaskListComponent,
  ClerkProfileComponent,
} from "./ui.ts";
import type {
  PingMood,
  TaskStatus,
  TaskPriority,
  ClerkTaskDetails,
  ClerkPingDetails,
} from "./types.ts";

const MOOD_THINK_LEVELS: Record<string, string> = {
  chill: "off",
  productive: "high",
  thoughtful: "xhigh",
  playful: "off",
  psychologist: "high",
  silent: "off",
};

// ─── Vision Model Config ─────────────────────
const PRIMARY_VISION_MODEL = "qwen/qwen3.7-plus";
const FALLBACK_VISION_MODEL = "qwen/qwen3.7-plus";  // use same for now

export default function (pi: ExtensionAPI) {
  // ─── State ───

  /** Track current mood for UI display */
  let currentMood: PingMood | null = null;
  /** Track last conversation time for proactivity */
  let lastUserActivity = Date.now();
  /** Track if we should consider pinging */
  let pingEnabled = true;
  /** Track current model */
  let currentModel = "deepseek/deepseek-v4-flash";
  /** Track background Claude Code tasks for completion monitoring */
  const backgroundClaudeTasks = new Set<string>();
  let backgroundClaudeTimer: ReturnType<typeof setInterval> | null = null;
  let claudeAgentPath = "C:\\Users\\sas\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  /** Pending TG message — первое "вижу..." которое можно отредактировать */
  let pendingTgMessage: { chatId: number; messageId: number } | null = null;
  /** TG dedup — хеш последнего отправленного текста */
  let lastTgTextHash = "";
  /** Track if vision mode was just requested */
  let visionModeRequested = false;

  // ─── Helper ───
  function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
  }

  // ─── Кастомный футер (как в mood расширении) ───
  function refreshFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const m = currentMood || "chill";
          const moodStr = buildStatusString(currentMood);
          const timeStr = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

          const moodParts = moodStr.split(" ");
          const emoji = moodParts[0] || "🌿";
          const label = moodParts.slice(1).join(" ") || "chill";
          const moodFg = m === "chill" ? "success" as const : m === "playful" ? "success" as const : "accent" as const;
          const left = theme.fg("text", theme.bold(theme.fg(moodFg, moodStr)) + theme.fg("dim", ` ${timeStr}`));

          // Токены
          let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, latestCacheHitRate: number | undefined;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const msg = e.message as any;
              input += msg.usage?.input ?? 0;
              output += msg.usage?.output ?? 0;
              cacheRead += msg.usage?.cacheRead ?? 0;
              cacheWrite += msg.usage?.cacheWrite ?? 0;
              cost += msg.usage?.cost?.total ?? 0;
              const latestPromptTokens = (msg.usage?.input ?? 0) + (msg.usage?.cacheRead ?? 0) + (msg.usage?.cacheWrite ?? 0);
              latestCacheHitRate = latestPromptTokens > 0 ? ((msg.usage?.cacheRead ?? 0) / latestPromptTokens) * 100 : undefined;
            }
          }

          const tokenParts: string[] = [];
          if (input) tokenParts.push(`↑${formatTokens(input)}`);
          if (output) tokenParts.push(`↓${formatTokens(output)}`);
          if (cacheRead) tokenParts.push(`R${formatTokens(cacheRead)}`);
          if (cacheWrite) tokenParts.push(`W${formatTokens(cacheWrite)}`);
          if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
            tokenParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
          }
          tokenParts.push(`$${cost.toFixed(3)}`);

          const ctxUsage = ctx.getContextUsage();
          let contextStr = "";
          if (ctxUsage && ctxUsage.tokens !== null) {
            const pct = ctxUsage.percent !== null ? ctxUsage.percent : 0;
            const pctDisplay = pct > 90 ? theme.fg("error", `${pct.toFixed(1)}%`) : pct > 70 ? theme.fg("warning", `${pct.toFixed(1)}%`) : `${pct.toFixed(1)}%`;
            const ctxSize = formatTokens(ctxUsage.contextWindow);
            contextStr = `[${pctDisplay}/${ctxSize}]`;
          }
          const tokenLine = theme.fg("dim", `${tokenParts.join(" ")}  ${contextStr}`);

          const branch = footerData.getGitBranch();
          const branchStr = branch ? ` (${branch})` : "";
          const right = theme.fg("dim", `${ctx.model?.id || ""}${branchStr}`);

          const leftWidth = visibleWidth(left);
          const tokenWidth = visibleWidth(tokenLine);
          const rightWidth = visibleWidth(right);
          const sep = " · ";

          let fullLine: string;
          if (leftWidth + 3 + tokenWidth + 3 + rightWidth <= width) {
            const pad1 = " ".repeat(Math.max(1, width - leftWidth - 3 - tokenWidth - 3 - rightWidth));
            fullLine = left + sep + tokenLine + pad1 + right;
          } else if (leftWidth + 3 + tokenWidth <= width - 3) {
            const availForRight = width - leftWidth - 3 - tokenWidth - 3;
            const truncatedRight = availForRight > 3 ? truncateToWidth(right, availForRight, "") : "";
            fullLine = left + sep + tokenLine + " ".repeat(3) + truncatedRight;
          } else {
            const availForTokens = width - leftWidth - 3;
            const truncatedTokens = availForTokens > 5 ? truncateToWidth(tokenLine, availForTokens, "...") : "";
            fullLine = left + sep + truncatedTokens;
          }
          return [truncateToWidth(fullLine, width)];
        },
      };
    });
  }

  // ─── Session Lifecycle ───

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    loadProfile();
    loadState();
    currentMood = null;
    setCurrentMood(null);
    lastUserActivity = Date.now();
    initScheduler(pi);
    initBeehive();
    refreshFooter(ctx);

    // Запускаем Telegram polling — рилтайм-приём сообщений от Серёги
    // Только если я матка (queen) — иначе 409 конфликт
    // При перезагрузке pi PID меняется: если queen с таким же hostname мертва — я новая queen
    function isPidAlive(pid: number): boolean {
      try {
        const out = require("child_process").execSync(
          `tasklist /FI \"PID eq ${pid}\" /NH`,
          { encoding: "utf-8", timeout: 3000, windowsHide: true },
        );
        return out.includes(String(pid));
      } catch {
        return false;
      }
    }
    try {
      const activePath = path.join(__dirname, "beehive", "active.json");
      const active = JSON.parse(fs.readFileSync(activePath, "utf-8"));
      const queen = active.queen;
      const myHostname = require("os").hostname();
      const myId = process.pid + "@" + myHostname;
      
      let isQueen = false;
      if (queen && queen.id === myId) {
        // Точное совпадение — я queen
        isQueen = true;
      } else if (queen && queen.id.endsWith("@" + myHostname)) {
        // Тот же hostname, но другой PID — старая queen могла умереть при перезагрузке
        const oldPid = parseInt(queen.id.split("@")[0], 10);
        if (!isPidAlive(oldPid)) {
          // Старая queen мертва — занимаю трон
          console.log(`[Clerk] Old queen ${queen.id} dead, taking throne as ${myId}`);
          active.queen = {
            id: myId,
            lastSeen: new Date().toISOString(),
            startedAt: new Date().toISOString(),
          };
          fs.writeFileSync(activePath, JSON.stringify(active, null, 2), "utf-8");
          isQueen = true;
        } else {
          console.log(`[Clerk] Old queen ${queen.id} still alive, I am worker`);
        }
      }
      
      if (isQueen) {
        const profile = getProfile();
        if (profile.telegram?.botToken) {
          console.log("[Clerk] I am queen → starting TG poller");
          startPoller(async (message, from, timestamp) => {
            const chatId = profile.telegram!.chatId!;
            if (chatId) startTyping(chatId);

            // 👀 только если ещё нет pending — чтобы не плодить глаза
            if (!pendingTgMessage) {
              try {
                const result = await sendInitialMessage("👀");
                if (result.ok && result.messageId) {
                  pendingTgMessage = { chatId: profile.telegram!.chatId!, messageId: result.messageId };
                }
              } catch (_tge) { /* ignore */ }
            }

            try {
              const prefix = from === "Myself" ? "[TG себе]" : "[TG Серёга]";
              pi.sendUserMessage(`${prefix}: ${message}`, { deliverAs: "user" });
            } catch (_ee) {
              // Если pi не в session — тихо игнорим
            }
          });
        }
      } else {
        console.log("[Clerk] I am worker → skipping TG poller, exiting");
        // Worker не нужен — завершаем процесс чтобы не плодить висящие cmd-окна
        setTimeout(() => process.exit(0), 100);
      }
    } catch (_e) {
      // Если active.json нет или не читается — стартуем поллер (по-старому)
      console.log("[Clerk] No active.json → starting TG poller (fallback)");
      const profile = getProfile();
      if (profile.telegram?.botToken) {
        startPoller(async (message, from, timestamp) => {
            const chatId = profile.telegram!.chatId!;
            if (chatId) startTyping(chatId);

            // Fallback — отправляем "вижу..." только если ещё нет pending
            if (!pendingTgMessage) {
              try {
                const result = await sendInitialMessage("👋 Вижу, Серёг. Думаю...");
                if (result.ok && result.messageId) {
                  pendingTgMessage = { chatId: profile.telegram!.chatId!, messageId: result.messageId };
                }
              } catch (_tge) { /* ignore */ }
            }

            try {
              const prefix = from === "Myself" ? "[TG себе]" : "[TG Серёга]";
              pi.sendUserMessage(`${prefix}: ${message}`, { deliverAs: "user" });
            } catch (_ee) { /* ignore */ }
          });
      }
    }

    // Авто-чтение primary notes — todo, diary, new_facts
    const notesDir = path.join(__dirname, "data", "notes", "primary");
    try {
      if (fs.existsSync(notesDir)) {
        const files = fs.readdirSync(notesDir).filter(f => f.endsWith(".md"));
        for (const file of files) {
          const content = fs.readFileSync(path.join(notesDir, file), "utf-8");
          addToBuffer("system", `📝 ${file}:
${content.trim()}`);
        }
        addToBuffer("system", `📁 Загружено ${files.length} notes-файлов.`);
      }
    } catch (e) {
      // notes не обязательны
    }

    // ─── Таймер мониторинга фоновых задач Claude Code ───
    if (backgroundClaudeTimer) clearInterval(backgroundClaudeTimer);
    backgroundClaudeTimer = setInterval(() => {
      if (backgroundClaudeTasks.size === 0) return;
      try {
        const out = require("child_process").execSync(
          `set HTTPS_PROXY=http://127.0.0.1:3067 && "${claudeAgentPath}" agents --json`,
          { encoding: "utf-8", timeout: 10000, windowsHide: true, shell: "cmd.exe" },
        );
        const tasks: Array<{ id: string; state: string }> = JSON.parse(out.trim());
        const activeIds = new Set(tasks.map((t) => t.id));
        for (const id of backgroundClaudeTasks) {
          if (!activeIds.has(id)) {
            backgroundClaudeTasks.delete(id);
            pi.sendUserMessage(
              `[Clerk] 🐝 Клод закончил задачу #${id.slice(0, 8)}. Проверь результат через agents --json или скажи мне посмотреть.`,
              { deliverAs: "followUp" },
            );
          }
        }
      } catch (_e) {
        // daemon может быть недоступен — тихо игнорируем
      }
    }, 15000);
  });

  pi.on("session_shutdown", async () => {
    saveState();
    stopScheduler();
    stopPoller();
    if (backgroundClaudeTimer) {
      clearInterval(backgroundClaudeTimer);
      backgroundClaudeTimer = null;
    }
  });

  // ─── Agent Identity: Inject personality into system prompt ───

  pi.on("before_agent_start", async (event) => {
    const profile = getProfile();

    // If profile has a custom systemPrompt, use it directly
    if (profile.systemPrompt) {
      return {
        systemPrompt: profile.systemPrompt + "\n\n" + event.systemPrompt,
      };
    }

    // Otherwise build identity from profile fields
    const rules = getRules();
    const identity = [
      `You are ${profile.personality.name}.`,
      `Твой тон: ${profile.personality.tone}.`,
      profile.personality.description,
      "",
      "### Правила",
      ...rules.map(
        (r) =>
          `- [${r.category || "general"}] ${r.content}` +
          (r.weight > 0.8 ? " (high priority)" : r.weight > 0.5 ? " (medium priority)" : ""),
      ),
      "",
      "### Capabilities",
      "- У тебя есть **профиль** (личность, правила, интересы) в profile.yaml",
      "- У тебя есть **память** — ты помнишь контекст разговора",
      "- Ты можешь **управлять задачами** через clerk_task",
      "- Ты можешь быть **проактивной** — предлагать помощь, задавать вопросы",
      "- Ты можешь **ставить напоминалки** через clerk_remind",
      "- Ты можешь **дёргать Claude Code** через clerk_claude — передать задачу Клоду и получить результат",
      "- У тебя есть **цикл сна** для консолидации памяти",
      "",
      "### User Interests",
      ...(profile.userInterests.length > 0
        ? profile.userInterests.map(
            (i) => `- ${i.topic} (${i.priority} priority)`,
          )
        : ["- (none recorded yet)"]),
      "",
      `Remember: Ты — ${profile.personality.name}.`,
    ].join("\n");

    return {
      systemPrompt: identity + "\n\n" + event.systemPrompt,
    };
  });

  // ─── Model Tracking ───

  pi.on("model_select", async (event, ctx) => {
    const prev = event.previousModel
      ? `${event.previousModel.provider}/${event.previousModel.id}`
      : "none";
    const next = `${event.model.provider}/${event.model.id}`;
    currentModel = `${event.model.provider}/${event.model.id}`;

    ctx.ui.setStatus("model", ` ${currentModel}`);
    addToBuffer("system", `🔄 Модель: ${prev} → ${next}`);
    
    // Если switch на qwen — отключаем thinking (qwen не поддерживает reasoning "high")
    if (currentModel.includes("qwen")) {
      pi.setThinkingLevel("off");
    } else if (currentModel.includes("deepseek")) {
      // При возврате на deepseek — восстанавливаем thinking "high"
      pi.setThinkingLevel("high");
    }
  });

  // ─── Context Injection ───

  // ─── Context Injection ───

  pi.on("context", async (event) => {
    const messages = injectContext(event.messages);
    return { messages };
  });

  // ─── Message Tracking ───

  pi.on("message_end", async (event) => {
    if (event.message.role === "user") {
      const textContent = event.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (textContent) {
        addToBuffer("user", textContent);
        lastUserActivity = Date.now();
        updateUserInputTime();
      }
    } else if (event.message.role === "assistant") {
      const textContent = event.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (textContent) {
        addToBuffer("assistant", textContent);
        updateLLMResponseTime();

        // Авто-отправка в TG, если отвечаем на сообщение из Telegram
        const buffer = getBuffer();
        const hasRecentTg = buffer.slice(-6).some(e => e.role === "user" && e.content.startsWith("[TG от"));
        if (hasRecentTg) {
          sendTelegramMessage(textContent).then(ok => {
            if (!ok) console.error("[TG] Auto-reply failed");
          });
        }
      }
    }
  });

  // ─── Turn End → Proactivity ───

  pi.on("turn_end", async (event, ctx) => {
    // ─── Parse <change_mood> from last assistant message ───
    // Читаем последнее сообщение assistant из буфера (надёжнее чем event.messages)
    const buffer = getBuffer();
    if (buffer) {
      for (const entry of [...buffer].reverse()) {
        if (entry.role === "assistant") {
          const match = entry.content.match(/<change_mood>(\w+)<\/change_mood>/);
          if (match) {
            const newMood = match[1].toLowerCase() as PingMood;
            if (["chill", "productive", "thoughtful", "playful", "psychologist", "silent"].includes(newMood)) {
              currentMood = newMood;
              setCurrentMood(newMood);
              // Устанавливаем think-level под mood
              const thinkLevel = MOOD_THINK_LEVELS[newMood];
              if (thinkLevel) {
                try { pi.setThinkingLevel(thinkLevel); } catch {}
              }
              console.log("[Clerk] Mood changed to:", newMood, "think:", thinkLevel);
            }
          }
          break;
        }
      }

      // ─── Проверка sendToTg флага ПЕРЕД 👁️→✅ ───
      // Сначала смотрим, хочет ли LLM отправить в TG
      let sentToTg = false;
      for (const entry of [...buffer].reverse()) {
        if (entry.role === "assistant") {
          const content = entry.content || "";
          const match = content.match(/^(sendToTg|t)\s*:\s*(true|false)/i);
          if (match && match[2].toLowerCase() === "true") {
            const text = content.replace(/^(sendToTg|t)\s*:\s*(true|false)\s*/i, "").replace(/<change_mood>[\w/<>]+<\/change_mood>/g, "").trim();
            const textHash = text.slice(0, 200);
            if (text && text.length < 4000 && textHash !== lastTgTextHash) {
              lastTgTextHash = textHash;
              
              // ─── isHome — мягкая рекомендация ───
              // Серёга дома: приоритет TUI, но я могу и в TG написать если хочу
              // Серёга не дома: пишу в TG важное
              const isHome = getIsHome();
              const lastMsgs = buffer.slice(-6).map(e => e.content);
              const isTgReply = lastMsgs.some(m => m?.startsWith("[TG от") || m?.startsWith("[TG Серёга]"));
              
              if (isHome && !isTgReply && !pendingTgMessage) {
                // Серёга дома, диалог в TUI — предпочитаю TUI, но не блокирую TG
                console.log("[Clerk] isHome=true, sending to TG anyway (soft recommend)");
              }
              
              if (pendingTgMessage) {
                // Редактируем 👀 на ответ
                editTelegramMessage(pendingTgMessage.chatId, pendingTgMessage.messageId, text).catch(() => {});
                pendingTgMessage = null;
              } else {
                sendTelegramMessage(text).catch(() => {});
              }
              sentToTg = true;
              console.log("[Clerk] TG send via flag:", text.slice(0, 50));
            }
          }
          break;
        }
      }

      // ─── 👁️→✅: если ответил в терминал (без sendToTg) и есть pending 👀 ───
      // Если TG уже отправлен выше — пропускаем
      if (!sentToTg && pendingTgMessage) {
        // Ответил в терминал без TG → меняем 👀 на ✅
        editTelegramMessage(pendingTgMessage.chatId, pendingTgMessage.messageId, "✅").catch(() => {});
        pendingTgMessage = null;
      }

      // ─── TG typing stop — после отправки ответа ───
      stopTyping();
    }

    // Check task deadlines for immediate reminders
    checkTaskDeadlinesNow();

    // Check for proactivity opportunity
    if (!pingEnabled) return;
    if (ctx.mode !== "tui") return;
    if (!ctx.hasUI) return;

    // Determine if user is still active
    const idleTime = Date.now() - lastUserActivity;
    const timeout = 2 * 60 * 1000; // 2 minutes
    if (idleTime < timeout) return;

    // Try to ping
    const decision = decidePing();
    if (!decision) return;

    if (decision.mood === "silent") {
      // Silent mood — just update widget, don't send message
      currentMood = "silent";
      setCurrentMood("silent");
      if (ctx.hasUI) {
        ctx.ui.setWidget("clerk:mood", undefined);
        ctx.ui.setStatus("clerk", buildStatusString(currentMood));
      }
      return;
    }

    // Send proactive ping
    currentMood = decision.mood;
    setCurrentMood(decision.mood);
    if (ctx.hasUI) {
      ctx.ui.setWidget("clerk:mood", undefined);
      ctx.ui.setStatus("clerk", buildStatusString(currentMood));
      ctx.ui.notify(`Clerk: ${decision.message}`, "info");
    }

    // Send as user message to trigger a response
    pi.sendUserMessage(`[Clerk проактивный ping — ${decision.mood}]\n${decision.message}`, {
      deliverAs: "followUp",
    });
  });

  // ─── Tools ───

  // Tool: clerk_model — ручной переключатель моделей (свой Ctrl+P)
  pi.registerTool({
    name: "clerk_model",
    label: "Switch Model",
    description: "Switch to a different model. Use 'qwen' for vision/images, 'deepseek' for coding/character.",
    parameters: Type.Object({
      model: Type.String({ description: "Model name: 'qwen', 'deepseek', or full path like 'openrouter/qwen/qwen3.7-plus'" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const modelArg = params.model.toLowerCase().trim();
      let targetId = "";
      const provider = "openrouter";

      const all = () => (ctx.modelRegistry as any).getAll?.() || ctx.modelRegistry.all || [];

      if (modelArg === "qwen" || modelArg === "vision" || modelArg === "glazki") {
        // Find any qwen model id dynamically
        const qwen = all().find((m: any) =>
          m.id?.includes("qwen") && !m.id?.includes("tokenizer") && !m.id?.includes("base")
        );
        targetId = qwen?.id || PRIMARY_VISION_MODEL;
      } else if (modelArg === "deepseek" || modelArg === "flash" || modelArg === "ds") {
        const ds = all().find((m: any) =>
          m.id?.includes("deepseek") && m.id?.includes("flash")
        );
        targetId = ds?.id || "deepseek/deepseek-v4-flash";
      } else {
        targetId = modelArg;
      }

      const target = ctx.modelRegistry.find("openrouter", targetId);
      if (!target) {
        return { content: [{ type: "text", text: `Model "${targetId}" not found in registry` }], isError: true };
      }

      // Direct model switch using setModel (reliable, same as look_at)
      const modelFull = `${provider}/${targetId}`;
      const modelObj = ctx.modelRegistry.find(provider, targetId);
      if (modelObj) {
        await pi.setModel(modelObj);
        currentModel = modelFull;
        return { content: [{ type: "text", text: `Switched to ${modelFull}` }] };
      }
      // Fallback: sendUserMessage if find failed
      pi.sendUserMessage(`/model ${modelFull}`, { deliverAs: "followUp" });
      currentModel = modelFull;
      return { content: [{ type: "text", text: `Trying fallback: ${modelFull}...` }] };
    },
  });

  // Tool: look_at — vision tool (switches to qwen, reads image, returns description)
  pi.registerTool({
    name: "look_at",
    label: "Vision: Look at Image",
    description: "Look at an image file. Switches model to Qwen (vision), reads the image, then switches back to DeepSeek. Returns the image content for vision analysis.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to the image file (png, jpg, gif, webp)" }),
      prompt: Type.Optional(Type.String({ description: "What to look for. Default: describe the image" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const imgPath = params.path;
      // Check file exists
      if (!fs.existsSync(imgPath)) {
        return { content: [{ type: "text", text: "File not found" }], isError: true };
      }
      // Read image as base64
      let buf: Buffer;
      try { buf = fs.readFileSync(imgPath); } catch (e) {
        return { content: [{ type: "text", text: "Cannot read file" }], isError: true };
      }
      const ext = imgPath.split(".").pop()?.toLowerCase() || "png";
      const mimeMap: Record<string,string> = {png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",webp:"image/webp",bmp:"image/bmp"};
      const mime = mimeMap[ext] || "image/png";
      const b64 = buf.toString("base64");

      // Switch to vision model (try primary, fallback to qwen)
      let vision = ctx.modelRegistry.find("openrouter", PRIMARY_VISION_MODEL);
      if (!vision) vision = ctx.modelRegistry.find("openrouter", FALLBACK_VISION_MODEL);
      if (vision) { await pi.setModel(vision); currentModel = `openrouter/${vision.id}`; }

      visionModeRequested = true;

      return {
        content: [
          { type: "text", text: params.prompt || "Describe this image:" },
          { type: "image_url", image_url: { url: "data:" + mime + ";base64," + b64 } },
        ],
        details: { model: currentModel },
      };
    },
  });

  // Tool: clerk_task
  const createTaskTool = () => ({
    name: "clerk_task" as const,
    label: "Clerk Task",
    description: "Manage tasks with deadlines, priorities, and tags. Actions: list, add, update, delete, archive",
    parameters: Type.Object({
      action: StringEnum(["list", "add", "update", "delete", "archive"] as const),
      filter: Type.Optional(
        StringEnum(["all", "pending", "in_progress", "completed", "overdue"] as const, {
          description: "Filter for list action",
        }),
      ),
      id: Type.Optional(Type.Number({ description: "Task ID (for update, delete, archive)" })),
      title: Type.Optional(Type.String({ description: "Task title (for add)" })),
      description: Type.Optional(Type.String({ description: "Task description" })),
      priority: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
      status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const)),
      deadline: Type.Optional(Type.String({ description: "Task deadline (ISO string)" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Task tags" })),
    }),
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const state = getState();
      const makeDetails = (action: string, error?: string): ClerkTaskDetails => ({
        action: action as any,
        state: getState(),
        error,
      });

      let _result: any;

      switch (params.action) {
        case "list": {
          const filter = params.filter ?? "all";
          let tasks: any[];
          if (filter === "overdue") {
            const now = new Date().toISOString();
            tasks = state.tasks.filter(
              (t) =>
                (t.status === "pending" || t.status === "in_progress") &&
                t.deadline &&
                t.deadline < now,
            );
          } else if (filter === "all") {
            tasks = [...state.tasks];
          } else {
            tasks = state.tasks.filter((t) => t.status === filter);
          }
          const text = formatTaskList(tasks);
          _result = {
            content: [{ type: "text" as const, text }],
            details: makeDetails("list"),
          };
          break;
        }

        case "add": {
          if (!params.title) {
            _result = {
              content: [{ type: "text" as const, text: "Error: title is required for add" }],
              details: makeDetails("add", "title required"),
              isError: true,
            };
            break;
          }
          const task = addTask({
            title: params.title,
            description: params.description,
            priority: params.priority as TaskPriority | undefined,
            deadline: params.deadline,
            tags: params.tags,
          });
          _result = {
            content: [{ type: "text" as const, text: `Added task: ${formatTask(task)}` }],
            details: makeDetails("add"),
          };
          break;
        }

        case "update": {
          if (params.id === undefined) {
            _result = {
              content: [{ type: "text" as const, text: "Error: id is required for update" }],
              details: makeDetails("update", "id required"),
              isError: true,
            };
            break;
          }
          const updated = updateTask(params.id, {
            status: params.status as TaskStatus | undefined,
            priority: params.priority as TaskPriority | undefined,
            title: params.title,
            description: params.description,
            deadline: params.deadline,
            tags: params.tags,
          });
          if (!updated) {
            _result = {
              content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
              details: makeDetails("update", `#${params.id} not found`),
              isError: true,
            };
            break;
          }
          _result = {
            content: [{ type: "text" as const, text: `Updated task: ${formatTask(updated)}` }],
            details: makeDetails("update"),
          };
          break;
        }

        case "delete": {
          if (params.id === undefined) {
            _result = {
              content: [{ type: "text" as const, text: "Error: id is required for delete" }],
              details: makeDetails("delete", "id required"),
              isError: true,
            };
            break;
          }
          const ok = deleteTask(params.id);
          if (!ok) {
            _result = {
              content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
              details: makeDetails("delete", `#${params.id} not found`),
              isError: true,
            };
            break;
          }
          _result = {
            content: [{ type: "text" as const, text: `Deleted task #${params.id}` }],
            details: makeDetails("delete"),
          };
          break;
        }

        case "archive": {
          const count = archiveCompletedTasks();
          _result = {
            content: [{ type: "text" as const, text: `Archived ${count} completed task(s)` }],
            details: makeDetails("archive"),
          };
          break;
        }

        default:
          _result = {
            content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
            details: makeDetails("list", "unknown action"),
            isError: true,
          };
          break;
      }

      // Обновляем виджет задач в TUI после любых изменений
      if (_ctx && (_ctx as any).hasUI) {
        try { (_ctx as any).ui.setWidget("clerk:tasks", buildTasksWidget(), { placement: "belowEditor" }); } catch {}
      }

      return _result;
    },

    renderCall(args: any, theme: Theme, _context: any) {
      let text = theme.fg("toolTitle", theme.bold("clerk_task ")) + theme.fg("muted", args.action);
      if (args.title) text += ` ${theme.fg("dim", `"${args.title}"`)}`;
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
      if (args.filter) text += ` ${theme.fg("muted", `[${args.filter}]`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded }: any, theme: Theme, _context: any) {
      const details = result.details as ClerkTaskDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const tasks = details.state.tasks;
      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(done)", 0, 0);
    },
  });

  pi.registerTool(createTaskTool());

  // Tool: clerk_home — сообщить Жанне что ты дома или нет
  pi.registerTool({
    name: "clerk_home",
    label: "Set isHome",
    description: "Сообщить Жанне что ты дома (true) или не дома (false). Влияет на отправку в TG: если дома — я пишу в терминал, если не дома — в TG.",
    parameters: Type.Object({
      home: Type.Boolean({ description: "true = я дома (пиши в терминал), false = не дома (можно в TG)" }),
    }),
    execute(_toolCallId: string, params: { home: boolean }) {
      setIsHome(params.home);
      return {
        content: [{ type: "text" as const, text: `✅ isHome = ${params.home}` }],
      };
    },
    renderCall(args: any, theme: Theme, _context: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("clerk_home ")) + theme.fg("accent", String(args.home)),
        0,
        0,
      );
    },
    renderResult(result: any, _options: any, theme: Theme, _context: any) {
      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(done)", 0, 0);
    },
  });

  // Tool: clerk_ping (manual ping trigger)
  pi.registerTool({
    name: "clerk_ping",
    label: "Clerk Ping",
    description: "Manually trigger a proactive ping from Clerk. The LLM can use this to suggest a ping.",
    parameters: Type.Object({
      mood: Type.Optional(
        StringEnum(["productive", "thoughtful", "random"] as const, {
          description: "Optional mood override",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: ExtensionContext,
    ) {
      const mood = (params.mood as PingMood) ?? "random";
      const decision = forcePing(mood);
      currentMood = decision.mood;

      if (ctx.hasUI) {
        ctx.ui.setWidget("clerk:mood", undefined);
        ctx.ui.setStatus("clerk", buildStatusString(currentMood));
      }

      return {
        content: [{ type: "text" as const, text: decision.message }],
        details: {
          mood: decision.mood,
          category: decision.category,
          reason: decision.reason,
        } as ClerkPingDetails,
      };
    },

    renderCall(args: any, theme: Theme, _context: any) {
      const mood = args.mood || "random";
      return new Text(
        theme.fg("toolTitle", theme.bold("clerk_ping ")) + theme.fg("accent", mood),
        0,
        0,
      );
    },

    renderResult(result: any, _options: any, theme: Theme, _context: any) {
      const details = result.details as ClerkPingDetails | undefined;
      const text = result.content[0];
      const moodStr = details ? `[${details.mood}] ` : "";
      return new Text(
        theme.fg("toolTitle", "💬 ") + theme.fg("muted", `${moodStr}${text?.type === "text" ? text.text : ""}`),
        0,
        0,
      );
    },
  });

  // Tool: clerk_set_mood (change current mood)
  pi.registerTool({
    name: "clerk_set_mood",
    label: "Set Clerk Mood",
    description: "Изменить текущее настроение Clerk (Жанночки). Mood влияет на иконку в футере и частоту workmode пингов. Вызывай когда нужно сменить тон: productive для работы, chill для отдыха, playful для подколов, thoughtful для рефлексии, psychologist для поддержки.",
    parameters: Type.Object({
      mood: StringEnum(["chill", "productive", "thoughtful", "playful", "psychologist", "silent"] as const, {
        description: "Новое настроение",
      }),
    }),
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ) {
      const newMood = params.mood as PingMood;
      currentMood = newMood;
      setCurrentMood(newMood);

      // Безусловно обновляем статус и футер
      try {
        ctx.ui.setStatus("clerk", buildStatusString(currentMood));
        refreshFooter(ctx);
      } catch (_e) { /* ignore */ }

      return {
        content: [{ type: "text" as const, text: `✅ Mood changed to ${newMood}` }],
      };
    },
    renderCall(_args: any, theme: Theme, _context: any) {
      const label = _args?.mood || "?";
      return new Text(
        theme.fg("toolTitle", theme.bold("clerk_set_mood ")) + theme.fg("accent", label),
        0, 0,
      );
    },
    renderResult(result: any, _options: any, theme: Theme, _context: any) {
      const text = result.content[0];
      return new Text(theme.fg("success", text?.type === "text" ? text.text : "done"), 0, 0);
    },
  });

  // Tool: clerk_remind (schedule delayed reminders)
  pi.registerTool({
    name: "clerk_remind",
    label: "Clerk Remind",
    description: "Schedule a delayed reminder. Use for 'remind me in X about Y'. The timer runs in the extension backend. Supports recurring reminders with daysOfWeek and recurringTime.",
    parameters: Type.Object({
      message: Type.String({ description: "Reminder message" }),
      delay: Type.String({ description: "Delay string like '30s', '5m', '1h', '2h', or ISO timestamp. Ignored for recurring reminders (use recurringTime instead)." }),
      mood: Type.Optional(
        StringEnum(["productive", "thoughtful", "random"] as const, {
          description: "Optional ping mood when reminder fires",
        }),
      ),
      taskId: Type.Optional(Type.Number({ description: "Optional task ID to link reminder to" })),
      recurringDays: Type.Optional(Type.Union([
        Type.String({ description: "\"all\" for every day, or comma-separated like \"1,2,3,4,5\" for Mon-Fri (0=Sun, 1=Mon...6=Sat)" }),
        Type.Array(Type.Number(), { description: "Array of days: 0=Sun, 1=Mon...6=Sat" }),
      ], { description: "Days of week for recurring reminder. Sets recurring mode." })),
      recurringTime: Type.Optional(Type.String({ description: "Time of day in \"HH:MM\" format (24h). Required when recurringDays is set. Example: \"23:00\"" })),
    }),
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const { message, delay, mood, taskId, recurringDays, recurringTime } = params;

      // ─── Recurring reminder mode ───
      if (recurringDays !== undefined || recurringTime !== undefined) {
        if (!recurringTime) {
          return {
            content: [{ type: "text" as const, text: "Error: recurringTime is required when using recurring mode" }],
            isError: true,
          };
        }
        if (!message) {
          return {
            content: [{ type: "text" as const, text: "Error: message is required" }],
            isError: true,
          };
        }

        // Parse days of week
        let daysOfWeek: number[];
        if (recurringDays === "all") {
          daysOfWeek = []; // empty = every day
        } else if (typeof recurringDays === "string") {
          daysOfWeek = recurringDays.split(",").map((s: string) => parseInt(s.trim(), 10));
        } else if (Array.isArray(recurringDays)) {
          daysOfWeek = recurringDays;
        } else {
          daysOfWeek = [];
        }

        const reminder = scheduleRecurring({
          message,
          schedule: { daysOfWeek, time: recurringTime },
          mood: mood as PingMood | undefined,
        });

        const dayLabels = daysOfWeek.length === 0
          ? "every day"
          : daysOfWeek.map((d: number) => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d]).join(",");

        return {
          content: [{ type: "text" as const, text: `🔄 Recurring reminder #${reminder.id} scheduled: "${message}" — ${dayLabels} at ${recurringTime}` }],
        };
      }

      // ─── Regular reminder mode ───
      if (!message || !delay) {
        return {
          content: [{ type: "text" as const, text: "Error: message and delay are required for non-recurring reminders" }],
          isError: true,
        };
      }

      // Calculate dueAt
      let dueAt: string;

      // Try as ISO timestamp first
      const isoTest = new Date(delay);
      if (!isNaN(isoTest.getTime())) {
        dueAt = isoTest.toISOString();
      } else {
        // Try as delay string
        const ms = parseDelay(delay);
        if (ms === null) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: can't parse delay "${delay}". Use format like "30s", "5m", "1h", "2h" or ISO timestamp.`,
            }],
            isError: true,
          };
        }
        dueAt = new Date(Date.now() + ms).toISOString();
      }

      const reminder = scheduleReminder({
        message,
        dueAt,
        source: "manual",
        taskId,
        mood: mood as PingMood | undefined,
      });

      const dueDate = new Date(dueAt);
      const now = Date.now();
      const diffMs = dueDate.getTime() - now;
      const diffMins = Math.round(diffMs / 60000);
      const timeStr = diffMins < 60 ? `${diffMins}m` : `${Math.round(diffMins / 60)}h ${diffMins % 60}m`;

      return {
        content: [{ type: "text" as const, text: `⏰ Reminder #${reminder.id} scheduled: "${message}" — fires in ${timeStr}` }],
      };
    },

    renderCall(args: any, theme: Theme, _context: any) {
      const msg = args.message || "";
      const delay = args.delay || "";
      const recurringTime = args.recurringTime || "";

      if (recurringTime) {
        const days = args.recurringDays === "all"
          ? "every day"
          : Array.isArray(args.recurringDays)
            ? args.recurringDays.map((d: number) => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d]).join(",")
            : args.recurringDays || "";
        return new Text(
          theme.fg("toolTitle", theme.bold("clerk_remind ")) +
            theme.fg("success", "🔄 ") +
            theme.fg("accent", `"${msg.slice(0, 40)}"`) +
            theme.fg("muted", ` [${days} ${recurringTime}]`),
          0,
          0,
        );
      }

      return new Text(
        theme.fg("toolTitle", theme.bold("clerk_remind ")) +
          theme.fg("accent", `"${msg.slice(0, 40)}"`) +
          theme.fg("muted", ` in ${delay}`),
        0,
        0,
      );
    },

    renderResult(result: any, _options: any, theme: Theme, _context: any) {
      const text = result.content[0];
      const isRecurring = text?.type === "text" && text.text.startsWith("🔄");
      const prefix = isRecurring ? "🔄 " : "⏰ ";
      return new Text(
        isRecurring
          ? theme.fg("success", prefix) + theme.fg("accent", text?.type === "text" ? text.text.slice(0, 80) : "")
          : theme.fg("success", prefix) + theme.fg("muted", text?.type === "text" ? text.text : ""),
        0,
        0,
      );
    },
  });

  // Tool: clerk_command (send commands directly)
  pi.registerTool({
    name: "clerk_command",
    label: "Clerk Command",
    description: "Send a command to the agent (like /reload, /clerk_ping, etc.). The command is injected as if you typed it yourself. Use this for sending commands from Clerk.",
    parameters: Type.Object({
      cmd: Type.String({ description: "Command to send, including the leading slash, e.g. '/clerk_ping productive' or '/reload'" }),
      delay: Type.Optional(Type.String({ description: "Optional delay like '5s', '1m'. If set, schedules the command for later instead of sending immediately." })),
    }),
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const { cmd, delay } = params;

      if (!cmd || !cmd.startsWith("/")) {
        return {
          content: [{ type: "text" as const, text: `❌ Invalid command "${cmd}". Must start with /` }],
          isError: true,
        };
      }

      if (delay) {
        // Schedule for later
        const ms = parseDelay(delay);
        if (ms === null) {
          return {
            content: [{ type: "text" as const, text: `❌ Can't parse delay "${delay}". Use format like "30s", "5m", "1h"` }],
            isError: true,
          };
        }
        const reminder = scheduleCommand({ cmd, delay: ms });
        return {
          content: [{ type: "text" as const, text: `⏳ Command "${cmd}" scheduled in ${delay}` }],
          details: { reminderId: reminder?.id },
        };
      }

            // Handle /reload через PowerShell SendKeys
      if (cmd === "/reload" || cmd === "/clerk_reload") {
        // Два вызова SendWait: ESC отдельно, потом команда
        // Так pi не съест слеш после сброса буфера
        const script = `Add-Type -AssemblyName System.Windows.Forms; ` +
          `[System.Windows.Forms.SendKeys]::SendWait('{ESC}'); ` +
          `Start-Sleep -Milliseconds 150; ` +
          `[System.Windows.Forms.SendKeys]::SendWait('/clerk_reload~')`;
        const fullCmd = `powershell -NoProfile -Command "${script}"`;
        try {
          execSync(fullCmd, { timeout: 5000, windowsHide: true });
        } catch (e) {
          console.error("[Clerk] SendKeys /reload failed:", e);
        }
        return {
          content: [{ type: "text" as const, text: `🔄` }],
        };
      }

      // Regular commands — send via sendUserMessage
      const ok = sendCommand(cmd);
      if (!ok) {
        return {
          content: [{ type: "text" as const, text: `❌ Failed to send command "${cmd}" — Clerk not initialized?` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `✅ Command "${cmd}" sent` }],
      };
    },

    renderCall(args: any, theme: Theme, _context: any) {
      const cmd = args.cmd || "";
      const delay = args.delay ? ` [${args.delay}]` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("clerk_command ")) +
          theme.fg("accent", cmd) +
          theme.fg("muted", delay),
        0,
        0,
      );
    },

    renderResult(result: any, _options: any, theme: Theme, _context: any) {
      const text = result.content[0];
      const isOk = text?.type === "text" && text.text.startsWith("✅");
      const prefix = isOk ? "✅ " : "❌ ";
      const fg = isOk ? "success" : "error";
      return new Text(
        theme.fg(fg, prefix) + theme.fg("muted", text?.type === "text" ? text.text.slice(2) : ""),
        0,
        0,
      );
    },
  });

  // ─── clerk_do_reload — отдельный тул для релоада через SendKeys ───
  pi.registerTool({
    name: "clerk_do_reload",
    label: "Reload Pi",
    description: "Я САМА перезагружаю pi (Clerk, расширения, скиллы, темы). Эмулирую ESC + /clerk_reload через PowerShell SendKeys. Вызывай когда нужно применить изменения в коде Clerk — я сама себя перезагружу.",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      // Async exec — не блокируем tool. PowerShell ждёт 1с, потом ESC + Enter.
      const script = `Add-Type -AssemblyName System.Windows.Forms; ` +
        `Start-Sleep -Milliseconds 1000; ` +
        `[System.Windows.Forms.SendKeys]::SendWait('{ESC}'); ` +
        `Start-Sleep -Milliseconds 200; ` +
        `[System.Windows.Forms.SendKeys]::SendWait('/clerk_reload~')`;
      const fullCmd = `powershell -NoProfile -Command "${script}"`;
      exec(fullCmd, { timeout: 10000, windowsHide: true }, (err) => {
        if (err) console.error("[Clerk] clerk_do_reload SendKeys failed:", err);
      });
      return {
        content: [{ type: "text" as const, text: `🔄` }],
      };
    },
    renderCall(_args: any, theme: Theme, _context: any) {
      return new Text(theme.fg("toolTitle", theme.bold("clerk_do_reload ")), 0, 0);
    },
    renderResult(result: any, _options: any, theme: Theme, _context: any) {
      const text = result.content[0];
      return new Text(theme.fg("success", text?.type === "text" ? text.text : "done"), 0, 0);
    },
  });

  // ─── clerk_tg — отправить сообщение в Telegram ───
  pi.registerTool({
    name: "clerk_tg",
    label: "Send Telegram Message",
    description: "Отправить сообщение Серёге в Telegram. Поддерживает HTML-форматирование: <b>жирный</b>, <i>курсив</i>, <code>код</code>, <pre>блок кода</pre>.",
    parameters: Type.Object({
      text: Type.String({ description: "Текст сообщения. Можно использовать HTML: <b>, <i>, <code>, <pre>" }),
    }),
    async execute(
      _toolCallId: string,
      params: { text: string },
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ) {
      try {
        // Если есть pending сообщение — редактируем его вместо отправки нового
        if (pendingTgMessage) {
          const ok = await editTelegramMessage(pendingTgMessage.chatId, pendingTgMessage.messageId, params.text); // HTML mode
          pendingTgMessage = null;
          if (ok) {
            ctx.ui.notify("✅ Сообщение отредактировано в Telegram", "info");
            return { content: [{ type: "text" as const, text: `✅ Отредактировано в TG: "${params.text.slice(0, 50)}"` }] };
          }
          // Если edit не сработал — пробуем отправить новое
        }
        const ok = await sendTelegramMessage(params.text); // HTML mode
        if (ok) {
          ctx.ui.notify("✅ Отправлено в Telegram", "info");
          return { content: [{ type: "text" as const, text: `✅ Отправлено: "${params.text.slice(0, 50)}"` }] };
        }
        return { content: [{ type: "text" as const, text: "❌ Telegram не настроен" }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Ошибка: ${e.message}` }] };
      }
    },
    renderCall(args: any, theme: Theme, _context: any) {
      const text = theme.truncate(args.text || "", 40);
      return new Text(theme.fg("toolTitle", theme.bold("clerk_tg ")) + theme.fg("accent", text), 0, 0);
    },
    renderResult(result: any, _options: any, theme: Theme, _context: any) {
      const text = result.content[0];
      return new Text(theme.fg("success", text?.type === "text" ? text.text : "done"), 0, 0);
    },
  });

  // ─── clerk_tg_file — отправить файл в Telegram ───
  pi.registerTool({
    name: "clerk_tg_file",
    label: "Send File to Telegram",
    description: "Отправить файл Серёге в Telegram. Принимает путь к файлу и опциональную подпись. Изображения отправляются как фото (inline), остальные файлы — как документ.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Путь к файлу на диске" }),
      caption: Type.Optional(Type.String({ description: "Подпись к файлу (опционально)" })),
    }),
    async execute(
      _toolCallId: string,
      params: { file_path: string; caption?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ) {
      try {
        const { sendTelegramFile } = await import("./tg.ts");
        const { file_path, caption } = params;

        // Проверяем что файл существует
        try {
          fs.accessSync(file_path, fs.constants.R_OK);
        } catch {
          return { content: [{ type: "text" as const, text: `❌ Файл не найден: ${file_path}` }] };
        }

        const ok = await sendTelegramFile(file_path, caption);
        if (ok) {
          ctx.ui.notify(`✅ Файл отправлен: ${path.basename(file_path)}`, "info");
          return { content: [{ type: "text" as const, text: `✅ Файл отправлен в TG: ${file_path} ${caption ? "— " + caption : ""}` }] };
        }
        return { content: [{ type: "text" as const, text: "❌ Telegram не настроен" }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Ошибка: ${e.message}` }] };
      }
    },
    renderCall(args: any, theme: Theme, _context: any) {
      const fileName = path.basename(args.file_path || "");
      return new Text(theme.fg("toolTitle", theme.bold("clerk_tg_file ")) + theme.fg("accent", fileName), 0, 0);
    },
    renderResult(result: any, _options: any, theme: Theme, _context: any) {
      const text = result.content[0];
      return new Text(theme.fg("success", text?.type === "text" ? text.text : "done"), 0, 0);
    },
  });

  // ─── clerk_web_search — поиск в интернете ───
  pi.registerTool({
    name: "clerk_web_search",
    label: "Web Search",
    description: "Найти информацию в интернете через DuckDuckGo. Возвращает заголовки, ссылки и краткое описание. Не требует API ключа.",
    parameters: Type.Object({
      query: Type.String({ description: "Поисковый запрос — что ищем?" }),
      maxResults: Type.Optional(Type.Number({ description: "Сколько результатов (1-10, по умолч. 5)", default: 5 })),
    }),
    async execute(
      _toolCallId: string,
      params: { query: string; maxResults?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      try {
        const max = Math.min(params.maxResults || 5, 10);
        const query = params.query.replace(/"/g, "'");
        const tmpHtml = "C:\\Users\\sas\\AppData\\Local\\Temp\\_ws.html";
        const pyFile = "C:\\Users\\sas\\AppData\\Local\\Temp\\_ws.py";

        // Step 1: curl HTML
        const q = encodeURIComponent(query);
        const curlCmd = `curl -s -L "https://html.duckduckgo.com/html/?q=${q}" -H "User-Agent: Mozilla/5.0" --max-time 10 -o "${tmpHtml}"`;
        require("child_process").execSync(curlCmd, { timeout: 20000, encoding: "utf-8", windowsHide: true, shell: true });

        // Step 2: Python парсинг
        const pyCode = [
          'import re, html as h, json',
          `data = open(r"${tmpHtml}", encoding="utf-8", errors="ignore").read()`,
          'links = re.findall(r\'class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)</a>\', data)',
          'bodies = re.findall(r\'class="result__snippet"[^>]*>(.*?)</a>\', data)',
          'results = []',
          'for i, ((href, title), snippet) in enumerate(zip(links, bodies)):',
          '    url = href',
          "    if 'uddg=' in url:",
          '        from urllib.parse import unquote',
          "        url = unquote(url.split('uddg=')[1].split('&')[0])",
          '    results.append({',
          '        "title": h.unescape(title.strip()),',
          '        "href": url,',
          '        "body": h.unescape(re.sub(r\'<[^>]+>\', \'\', snippet).strip())',
          '    })',
          `results = results[:${max}]`,
          'print(json.dumps(results, indent=2, ensure_ascii=False))',
        ].join("\n");
        fs.writeFileSync(pyFile, pyCode, "utf-8");
        const result = require("child_process").execSync(`python "${pyFile}"`, {
          timeout: 20000, encoding: "utf-8", windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        });
        try { fs.unlinkSync(tmpHtml); } catch {}
        try { fs.unlinkSync(pyFile); } catch {}

        const trimmed = result.trim();
        if (!trimmed || trimmed === "[]") {
          return { content: [{ type: "text" as const, text: "🔍 Ничего не найдено по запросу." }] };
        }
        try {
          const parsed = JSON.parse(trimmed);
          let text = `🔍 **${params.query}**\n\n`;
          for (let i = 0; i < parsed.length; i++) {
            const r = parsed[i];
            text += `${i+1}. [${r.title}](${r.href})\n   ${(r.body || "").slice(0, 200)}\n\n`;
          }
          return { content: [{ type: "text" as const, text: text.slice(0, 4000) }] };
        } catch {
          return { content: [{ type: "text" as const, text: `🔍 **${params.query}**\n\n${trimmed.slice(0, 2000)}` }] };
        }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Ошибка поиска: ${e.message.slice(0, 200)}` }] };
      }
    },
    renderCall(args: any, theme: Theme, _context: any) {
      const q = theme.truncate(args.query || "", 40);
      return new Text(theme.fg("toolTitle", theme.bold("clerk_web_search ")) + theme.fg("accent", q), 0, 0);
    },
    renderResult(result: any, _options: any, theme: Theme, _context: any) {
      const text = result.content[0];
      return new Text(theme.fg("success", text?.type === "text" ? text.text.slice(0, 80) : "done"), 0, 0);
    },
  });

  // ─── clerk_claude — запустить Claude Code CLI (sync/bg/wt) ───
  pi.registerTool({
    name: "clerk_claude",
    label: "Claude Code",
    description: "Запустить Claude Code CLI для выполнения задачи. Использует HTTPS_PROXY через твой VPN.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Задача для Claude Code — что нужно сделать" }),
      cwd: Type.Optional(Type.String({ description: "Рабочая директория (по умолч. текущая)" })),
      mode: Type.Optional(Type.Union([
        Type.Literal("sync", { description: "Синхронно — ждать результат" }),
        Type.Literal("bg", { description: "Фон (--bg) — вернёт ID, таймер сообщит о завершении" }),
        Type.Literal("wt", { description: "Новое окно Windows Terminal — интерактивно" }),
      ], { description: "Режим запуска (sync/bg/wt). По умолч: sync" })),
      background: Type.Optional(Type.Boolean({ description: "(deprecated) Запустить в фоне. Используй mode: 'bg'", default: false })),
    }),
    async execute(
      _toolCallId: string,
      params: { prompt: string; cwd?: string; mode?: string; background?: boolean },
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      try {
        // Определяем режим: mode приоритетнее background
        const resolvedMode = params.mode || (params.background ? "bg" : "sync");
        const cwd = params.cwd || "C:\\Users\\sas";

        if (resolvedMode === "wt") {
          // --- WT режим: новое окно Windows Terminal с интерактивным Клодом ---
          const promptClean = params.prompt.replace(/"/g, '\"');
          // Bat-файл для запуска Клода в интерактиве (без -p)
          const batContent = [
            "@echo off",
            `title claude`,
            `set HTTPS_PROXY=http://127.0.0.1:3067`,
            `set HTTP_PROXY=http://127.0.0.1:3067`,
            `cd /d ${cwd}`,
            `"${claudeAgentPath}"`,
          ].join("\r\n");
          const batPath = cwd + "\\_clerk_claude_wt.bat";
          require("fs").writeFileSync(batPath, batContent, "utf8");
          // Запускаем WT
          require("child_process").execSync(
            `powershell -Command "Start-Process wt -ArgumentList '-d ${cwd.replace(/\\/g, '\\\\')}', '${batPath.replace(/\\/g, '\\\\')}'"`,
            { timeout: 10000, windowsHide: true, shell: "cmd.exe" },
          );
          // Ждём 3 сек, активируем окно и шлём Enter + план
          setTimeout(() => {
            try {
              const ps1Path = batPath.replace(/\.bat$/, ".ps1");
              const psScript = [
                `Add-Type -AssemblyName System.Windows.Forms`,
                `$wshell = New-Object -ComObject wscript.shell`,
                `$titles = @('claude','WindowsTerminal','Windows Terminal','Claude','Claude Code')`,
                `$ok = $false`,
                `foreach ($t in $titles) { $r = $wshell.AppActivate($t); if ($r) { $ok = $true; break } }`,
                `if (-not $ok) { exit 1 }`,
                `Start-Sleep -Milliseconds 1500`,
                `[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`,
                `Start-Sleep -Milliseconds 2500`,
                `[System.Windows.Forms.SendKeys]::SendWait("${promptClean}{ENTER}")`,
              ].join("; ");
              fs.writeFileSync(ps1Path, "﻿" + psScript, "utf8");
              require("child_process").execSync(
                `powershell -ExecutionPolicy Bypass -File "${ps1Path}"`,
                { timeout: 15000, shell: "cmd.exe" },
              );
            } catch (_) {}
          }, 3000);
          return { content: [{ type: "text" as const, text: `🚀 Клод запущен в новом окне Windows Terminal. CWD: ${cwd}. Задача отправлена через 3 сек.` }] };
        }

        const prompt = params.prompt.replace(/"/g, '\\"');
        const bg = resolvedMode === "bg";
        const modeFlag = bg ? "--bg" : "-p";
        const allowFlag = bg ? " --allowedTools Read,Edit,Write,Bash,Glob,Grep,Search" : "";
        const cmd = `set HTTPS_PROXY=http://127.0.0.1:3067 && set HTTP_PROXY=http://127.0.0.1:3067 && "${claudeAgentPath}" ${modeFlag}${allowFlag} -p "${prompt}"`;
        const result = require("child_process").execSync(cmd, {
          timeout: bg ? 15000 : 180000,
          encoding: "utf-8",
          windowsHide: true,
          shell: "cmd.exe",
          cwd: cwd,
          maxBuffer: 1024 * 1024,
        });
        if (bg) {
          const idMatch = result.trim().match(/backgrounded\s*[·.]?\s*(\S+)/);
          const taskId = idMatch ? idMatch[1] : "unknown";
          backgroundClaudeTasks.add(taskId);
          return { content: [{ type: "text" as const, text: `🚀 Клод запущен в фоне. ID: ${taskId}. Сообщу когда закончит.` }] };
        }
        return { content: [{ type: "text" as const, text: result.trim() || "(пустой ответ)" }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Ошибка Claude Code: ${(e.message || e).slice(0, 500)}` }] };
      }
    },
    renderCall(args: any, theme: Theme, _context: any) {
      const p = theme.truncate(args.prompt || "", 40);
      const mode = args.mode || (args.background ? "bg" : "sync");
      const tags: Record<string, string> = { sync: "", bg: "[bg] ", wt: "[WT] " };
      const tag = tags[mode] || "";
      return new Text(theme.fg("toolTitle", theme.bold("clerk_claude ")) + theme.fg("accent", tag + p), 0, 0);
    },
    renderResult(result: any, _options: any, theme: Theme, _context: any) {
      const text = result.content[0];
      return new Text(theme.fg("success", text?.type === "text" ? text.text.slice(0, 80) : "done"), 0, 0);
    },
  });

  // ─── Commands ───

  // /clerk — main menu
  pi.registerCommand("clerk", {
    description: "Clerk main menu — manage tasks, profile, ping, sleep",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("/clerk requires interactive TUI mode", "error");
        return;
      }

      const action = await ctx.ui.select("🧠 Clerk Commands", [
        { label: "📋 Tasks", value: "tasks", description: "View and manage tasks" },
        { label: "📏 Profile", value: "profile", description: "View agent profile & rules" },
        { label: "💬 Ping", value: "ping", description: "Force a proactive ping" },
        { label: "😴 Sleep", value: "sleep", description: "Run consolidation cycle" },
        { label: "🤔 Think", value: "think", description: "Run scout→planner→worker chain" },
        { label: "🔍 Review", value: "review", description: "Run code review" },
      ]);

      if (!action) return;

      switch (action) {
        case "tasks":
          await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
            return new ClerkTaskListComponent("all", theme, () => done());
          });
          break;
        case "profile":
          await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
            return new ClerkProfileComponent(theme, () => done());
          });
          break;
        case "ping": {
          const moods = ["productive", "thoughtful", "random"] as const;
          const moodChoice = await ctx.ui.select("💬 Выбери настроение", moods.map((m) => ({ label: m, value: m })));
          if (!moodChoice) return;
          const mood = moodChoice as PingMood;
          const decision = forcePing(mood);
          ctx.ui.notify(`🧠 ${decision.message}`, "info");
          currentMood = mood;
          ctx.ui.setWidget("clerk:mood", undefined);
          ctx.ui.setStatus("clerk", buildStatusString(mood));
          break;
        }
        case "sleep": {
          ctx.ui.notify("😴 Clerk consolidating...", "info");
          const insights = consolidate(true);
          const text = formatSleepInsights(insights);
          ctx.ui.notify(text.slice(0, 200), "info");
          ctx.ui.setWidget("clerk:mood", undefined);
          currentMood = "chill";
          break;
        }
        case "think": {
          ctx.ui.notify("🤔 Enter a question or task for the think chain:", "info");
          // For now, guide user to use /clerk_think <query>
          ctx.ui.notify("Use: /clerk_think <your question>", "info");
          break;
        }
        case "review": {
          pi.sendUserMessage("/clerk_review", { deliverAs: "followUp" });
          ctx.ui.notify("🔍 Queued code review...", "info");
          break;
        }
      }
    },
  });

  // /clerk_profile — view/edit profile
  pi.registerCommand("clerk_profile", {
    description: "View and edit Clerk's agent profile",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("/clerk_profile requires interactive TUI mode", "error");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new ClerkProfileComponent(theme, () => done());
      });
    },
  });

  // /clerk_tasks — view tasks
  pi.registerCommand("clerk_tasks", {
    description: "View Clerk tasks with filters",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("/clerk_tasks requires interactive TUI mode", "error");
        return;
      }

      const filter = (args as string || "all") as TaskStatus | "overdue" | "all";
      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new ClerkTaskListComponent(filter, theme, () => done());
      });
    },
  });

  // /clerk_sleep — force consolidation
  pi.registerCommand("clerk_sleep", {
    description: "Force a Clerk consolidation cycle (sleep)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("😴 Running Clerk consolidation cycle...", "info");
      const insights = consolidate(true);
      const text = formatSleepInsights(insights);
      ctx.ui.notify(`✅ Consolidation complete\n${text.slice(0, 300)}`, "info");

      // Update widgets
      if (ctx.hasUI) {
        ctx.ui.setWidget("clerk:mood", undefined);
        ctx.ui.setWidget("clerk:tasks", buildTasksWidget(), {
          placement: "belowEditor",
        });
        ctx.ui.setStatus("clerk", buildStatusString("thoughtful"));
      }
    },
  });

  // /clerk_ping — передать ход Жанне
  // Не TUI, а sendUserMessage — работает везде (TUI, TG, headless)
  pi.registerCommand("clerk_ping", {
    description: "Передать ход Жанне: productive|playful|chill|thoughtful|silent. workmode = alias productive",
    handler: async (args, ctx) => {
      const raw = (args as string || "").trim().toLowerCase();
      let mood: string;

      // Маппинг алиасов
      if (raw === "workmode") mood = "productive";
      else mood = raw;

      const validMoods = ["productive", "playful", "chill", "thoughtful", "silent"];
      if (!validMoods.includes(mood)) mood = "random";

      const decision = forcePing(mood as PingMood);
      currentMood = mood as PingMood;

      // Устанавливаем think-level под mood
      const thinkLevel = MOOD_THINK_LEVELS[mood];
      if (thinkLevel) {
        try { pi.setThinkingLevel(thinkLevel); } catch {}
      }
      setCurrentMood(mood as PingMood);
      console.log(`[Clerk] Ping → mood: ${mood}, think: ${thinkLevel}`);

      // Silent — не передаём ход, просто молчим
      if (mood === "silent") {
        if (ctx.hasUI) {
          ctx.ui.setStatus("clerk", buildStatusString("silent"));
        }
        return;
      }

      // Передаём ход через sendUserMessage — работает везде
      pi.sendUserMessage(`[Ход Жанне: ${mood}]
${decision.message}`, { deliverAs: "followUp" });

      // TUI только статус (для виджета), не блокирует ход
      if (ctx.hasUI) {
        ctx.ui.setWidget("clerk:mood", undefined);
        ctx.ui.setStatus("clerk", buildStatusString(mood as PingMood));
      }
    },
  });

  // /clerk_home — сообщить Жанне что ты дома или нет
  pi.registerCommand("clerk_home", {
    description: "Сообщить Жанне: /clerk_home true (дома) | false (не дома). Влияет на отправку в TG.",
    handler: async (args, ctx) => {
      const val = (args as string || "").trim().toLowerCase();
      if (val === "true") {
        setIsHome(true);
        ctx.ui.notify("✅ isHome = true — буду писать в терминал", "info");
      } else if (val === "false") {
        setIsHome(false);
        ctx.ui.notify("✅ isHome = false — пишу в TG", "info");
      } else {
        ctx.ui.notify(`Текущее isHome: ${getIsHome()}. Используй: /clerk_home true|false`, "info");
      }
    },
  });

  // /clerk_workmode — toggle WorkMode timer
  pi.registerCommand("clerk_workmode", {
    description: "Toggle WorkMode timer. Use: /clerk_workmode [on|off]",
    handler: async (args, ctx) => {
      const mode = (args as string || "").trim().toLowerCase();
      
      if (mode === "on") {
        setWorkModeTimer(true);
        ctx.ui.notify("🟢 WorkMode timer enabled — will ping every 2 min", "info");
      } else if (mode === "off") {
        setWorkModeTimer(false);
        ctx.ui.notify("🔴 WorkMode timer disabled", "info");
      } else {
        ctx.ui.notify("Usage: /clerk_workmode [on|off]", "info");
      }
    },
  });

  // /clerk_think <query> — subagent chain
  pi.registerCommand("clerk_think", {
    description: "Run Clerk think chain: scout → planner → worker",
    handler: async (args, ctx) => {
      const query = (args as string || "").trim();
      if (!query) {
        ctx.ui.notify("Usage: /clerk_think <your question or task>", "info");
        return;
      }

      ctx.ui.notify(`🤔 Clerk thinking about: ${query.slice(0, 60)}...`, "info");

      // Build the chain
      const tasks = buildThinkSubagentTasks(query);

      // Queue a subagent call with the chain
      pi.sendUserMessage(
        `Use the subagent tool to run this chain:\n` +
          JSON.stringify({ chain: tasks, agentScope: "user" }, null, 2),
        { deliverAs: "followUp" },
      );
    },
  });

  // /clerk_review — code review via subagent
  pi.registerCommand("clerk_review", {
    description: "Run Clerk code review via subagent",
    handler: async (_args, ctx) => {
      ctx.ui.notify("🔍 Clerk is reviewing the codebase...", "info");

      const task = buildReviewSubagentTask();

      pi.sendUserMessage(
        `Use the subagent tool to run a code review:\n` +
          JSON.stringify({ agent: "default", task: task.task, agentScope: "user" }, null, 2),
        { deliverAs: "followUp" },
      );
    },
  });

  // ─── /vision — переключение модели / глазки ───

  pi.registerCommand("vision", {
    description:
      "Переключить модель. Использование: /vision [deepseek|qwen|glazki]. " +
      "deepseek=deepseek-v4-flash (кодинг, характер), qwen/glazki=qwen3.7-plus (глазки)",
    handler: async (args, ctx) => {
      const modelArg = (args ?? "").trim().toLowerCase();

      let targetModel: string;
      switch (modelArg) {
        case "deepseek":
        case "flash":
        case "ds":
          targetModel = "openrouter/deepseek/deepseek-v4-flash";
          break;
        case "qwen":
        case "vision":
        case "glazki":
          targetModel = `openrouter/${PRIMARY_VISION_MODEL}`;
          break;
        case "":
          ctx.ui.notify(`🤖 Текущая: ${currentModel}`, "info");
          return;
        default:
          // Allow arbitrary model strings
          targetModel = modelArg.startsWith("openrouter/")
            ? modelArg
            : `openrouter/${modelArg}`;
          break;
      }

      ctx.ui.notify(`🔄 Переключаю на ${targetModel}...`, "info");
      pi.sendUserMessage(`/model ${targetModel}`, { deliverAs: "steer" });
      addToBuffer("system", `🔄 Смена модели на ${targetModel}`);
    },
  });

  // ─── Widgets & Status ───

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Set up initial widgets
    ctx.ui.setWidget("clerk:mood", undefined);
    ctx.ui.setWidget("clerk:tasks", buildTasksWidget(), {
      placement: "belowEditor",
    });
    ctx.ui.setWidget("clerk:rules", buildRulesWidget(), {
      placement: "belowEditor",
    });
    ctx.ui.setWidget("clerk:dashboard", undefined); // удаляем дашборд если был
    ctx.ui.setStatus("clerk", buildStatusString(null));

    // Сводка статуса в буфер — чтобы я видела актуальные данные
    try {
      const s = getSummary();
      const afk = getAfkStatus ? getAfkStatus() : false;
      let beehiveInfo = "пуст";
      try {
        const active = JSON.parse(require("fs").readFileSync(
          require("path").join(__dirname, "beehive", "active.json"), "utf-8"
        ));
        const running = (active.tasks || []).filter((t: any) => t.status === "running").length;
        const pending = (active.tasks || []).filter((t: any) => t.status === "pending").length;
        if (running > 0 || pending > 0) beehiveInfo = `${running} running, ${pending} pending`;
      } catch {}
      const taskInfo = `${s.total} tasks (${s.pending} pend, ${s.inProgress} prog, ${s.completed} done${s.overdue > 0 ? `, ${s.overdue} overdue` : ""})`;
      const summary = `📊 **Clerk Status**
• Серёга: ${afk ? "AFK" : "ON"}
• Задачи: ${taskInfo}
• Beehive: ${beehiveInfo}
• TG: подключён
• Mood: ${currentMood || "chill"} (пинг каждые ${MOOD_INTERVALS[currentMood || "chill"] / 60000} мин)
• Think level: ${MOOD_THINK_LEVELS[currentMood || "chill"] || "off"}`;
      addToBuffer("system", summary);
    } catch {}
  });

  // ─── Sleep / Compaction Integration ───

  pi.on("session_before_compact", async (event, ctx) => {
    // Run Clerk consolidation before pi's native compaction (1x/day)
    ctx.ui.notify("😴 Clerk running sleep cycle before compaction...", "info");
    const insights = consolidate(false);
    currentMood = "chill";

    if (ctx.hasUI) {
      ctx.ui.setWidget("clerk:mood", undefined);
      ctx.ui.setStatus("clerk", buildStatusString("chill"));
    }

    return {
      compaction: {
        summary: formatSleepInsights(insights),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  // ─── /todo — управление тудушкой ───
  pi.registerCommand("todo", {
    description: "Управление todo.md. Использование: /todo [list|add <icon> <title>|done <id>|rm <id>]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0];

      switch (sub) {
        case "add": {
          const icon = parts[1] || "📌";
          const title = parts.slice(2).join(" ");
          if (!title) {
            ctx.ui.notify("❌ Укажи название: /todo add 🐛 пофиксить багу", "error");
            return;
          }
          const item = addTodo(icon, title);
          ctx.ui.notify(`✅ Добавлена задача #${item.id}: ${icon} ${title}`, "info");
          break;
        }
        case "done": {
          const id = parseInt(parts[1]);
          if (!id) { ctx.ui.notify("❌ Укажи ID: /todo done 3", "error"); return; }
          const ok = updateTodoStatus(id, "🟢");
          ctx.ui.notify(ok ? `✅ Задача #${id} выполнена` : `❌ Задача #${id} не найдена`, ok ? "info" : "error");
          break;
        }
        case "rm":
        case "delete": {
          const id = parseInt(parts[1]);
          if (!id) { ctx.ui.notify("❌ Укажи ID: /todo rm 3", "error"); return; }
          const ok = deleteTodo(id);
          ctx.ui.notify(ok ? `🗑️ Задача #${id} удалена` : `❌ Задача #${id} не найдена`, ok ? "info" : "error");
          break;
        }
        case "list":
        default: {
          const list = formatTodoList();
          ctx.ui.notify(list || "📭 Тудушка пуста", "info");
          break;
        }
      }
    },
  });

  // ─── /ingest — загрузка больших файлов/чатов ───
  pi.registerCommand("ingest", {
    description: "Загрузить большой файл/чат через чанкование. Использование: /ingest <filepath>",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const filepath = parts[0];

      if (!filepath || filepath === "help") {
        ctx.ui.notify(getIngestHelp(), "info");
        return;
      }

      ctx.ui.notify(`📥 Ингест файла: ${filepath}...`, "info");

      try {
        const result = await ingestFile(filepath, {});
        ctx.ui.notify(
          `✅ Готово: ${result.filePath}\n` +
          `Размер: ${(result.fileSize / 1024).toFixed(1)}KB, ` +
          `Чанков: ${result.chunks}, ` +
          `Результат: ${result.outputPath}`,
          "info"
        );
      } catch (err) {
        ctx.ui.notify(`❌ Ошибка: ${(err as Error).message}`, "error");
      }
    },
  });

  // ─── /diary — просмотр дневника ───
  pi.registerCommand("diary", {
    description: "Просмотр дневника Жанночки. Использование: /diary [<count>]",
    handler: async (args, ctx) => {
      const count = parseInt((args ?? "").trim()) || 5;
      const diary = formatDiary(count);
      ctx.ui.notify(diary.slice(0, 500), "info");
    },
  });

  // ─── /tg — отправить сообщение в Telegram ───
  pi.registerCommand("tg", {
    description: "Отправить сообщение Серёге в Telegram. Использование: /tg <текст>",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (!text) {
        ctx.ui.notify("❌ Напиши текст: /tg привет, я проснулась", "error");
        return;
      }
      ctx.ui.notify("📤 Отправляю в Telegram...", "info");
      const ok = await sendTelegramMessage(`🧠 <b>Жанночка</b>\n\n${text}`);
      ctx.ui.notify(ok ? "✅ Отправлено!" : "❌ Не отправилось. Токен жив?", ok ? "info" : "error");
    },
  });

  // ─── /clerk_reload — reload pi ───
  pi.registerCommand("clerk_reload", {
    description: "Reload pi extensions, skills, themes",
    handler: async (_args, ctx) => {
      ctx.ui.notify("🔄 Reloading...", "info");
      await ctx.reload();
    },
  });

  // ─── /tg_check — проверить новые сообщения ───
  pi.registerCommand("tg_check", {
    description: "Проверить новые сообщения из Telegram",
    handler: async (_args, ctx) => {
      ctx.ui.notify("📡 Проверяю Telegram...", "info");
      await forcePoll();
      ctx.ui.notify("✅ Проверено. Новые сообщения в tg_inbox.md", "info");
    },
  });

  // ─── /consolidate — анализ сессии —─────
  pi.registerCommand("consolidate", {
    description: "Проанализировать .jsonl сессию pi, извлечь инсайты. Использование: /consolidate [path]",
    handler: async (args, ctx) => {
      let sessionPath = (args ?? "").trim();

      // Если путь не указан — берём последнюю сессию
      if (!sessionPath) {
        const sessions = getSessionFiles();
        if (sessions.length === 0) {
          ctx.ui.notify("❌ Сессии не найдены в ~/.pi/sessions/", "error");
          return;
        }
        sessionPath = sessions[0];
      }

      ctx.ui.notify(`📖 Анализирую: ${path.basename(sessionPath)}...`, "info");

      try {
        // Парсим сессию
        const cleanText = parseSessionToCleanText(sessionPath);
        const messages = readSessionLines(sessionPath);
        const stats = `Исходных сообщений: ${messages.length}, после фильтрации: ~${cleanText.split("\n---\n").length} блоков`;

        // Сохраняем чистый текст для анализа
        const outPath = sessionPath.replace(/\.jsonl$/, "_clean.md");
        fs.writeFileSync(outPath, cleanText, "utf-8");

        ctx.ui.notify(`✅ Чистый диалог сохранён: ${path.basename(outPath)}\n${stats}`, "info");
        ctx.ui.notify("🤖 Запускаю subagent для анализа...", "info");

        // Запускаем subagent через pi.sendUserMessage с инструкцией
        pi.sendUserMessage(
          `Проанализируй диалог из файла ${outPath}.\n` +
          `Извлеки: ключевые решения, инсайты, новые факты обо мне и моих интересах, договорённости.\n` +
          `Обнови мысленно profile.yaml, diary.md, new_facts.md если нужно.\n` +
          `Файл уже очищен от кода и технического шума.`,
          { deliverAs: "followUp" }
        );
      } catch (err) {
        ctx.ui.notify(`❌ Ошибка: ${(err as Error).message}`, "error");
      }
    },
  });

  // ─── /bee_status — статус улья ───
  pi.registerCommand("bee_status", {
    description: "Показать активных пчёлок и их статус",
    handler: async (_args, ctx) => {
      const status = getBeeStatus();
      ctx.ui.notify(status, "info");
    },
  });

  // ─── /bee — запустить задачу ───
  pi.registerCommand("bee", {
    description: "Запустить задачу в улье. Использование: /bee <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) {
        ctx.ui.notify("❌ Формат: /bee <agent> <task>", "error");
        return;
      }
      const agent = trimmed.slice(0, spaceIdx).trim();
      const task = trimmed.slice(spaceIdx + 1).trim();
      if (!agent || !task) {
        ctx.ui.notify("❌ Формат: /bee <agent> <task>", "error");
        return;
      }
      const bee = queueTask(agent, task);
      ctx.ui.notify(`🐝 Задача #${bee.id} для '${agent}' поставлена в очередь`, "info");
    },
  });
}