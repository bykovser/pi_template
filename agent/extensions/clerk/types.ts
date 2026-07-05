// ===========================================
// CLERK FOR PI — Shared Types
// ===========================================

// ─── Agent Profile (ROM) ───

export interface AgentProfile {
  personality: {
    name: string;
    tone: string;
    description: string;
    /** Квирки/привычки — мелкие детали характера, делающие Жанночку живой */
    quirks?: string[];
  };
  rules: Rule[];
  facts: Fact[];
  userInterests: UserInterest[];
  pingBehavior: PingBehavior;
  metadata: ProfileMetadata;
  /** Telegram config for bot messaging and polling */
  telegram?: TelegramConfig;
  /** Optional override: full system prompt injected instead of auto-generated from personality/rules */
  systemPrompt?: string;
}

export interface Rule {
  id: string;
  content: string;
  weight: number;
  stabilityScore: number;
  protected: boolean;
  lastUpdated: string;
  successRate?: number;
  category?: "coding" | "communication" | "preference" | "hard-block";
}

export interface Fact {
  id: string;
  content: string;
  category: "system" | "security" | "knowledge" | "preference";
  lastUpdated: string;
}

export interface UserInterest {
  topic: string;
  priority: "high" | "medium" | "low";
  lastMentioned: string;
}

export interface PingBehavior {
  lastPingSent: string | null;
  userResponseRate: number;
  minIntervalMinutes: number;
  preferredMoods: PingMood[];
  moodBlacklist: string[];
}

export interface ProfileMetadata {
  createdAt: string;
  lastSleepCycle: string | null;
  totalSleepCycles: number;
  version: string;
}

// ─── Telegram Config ───

export interface TelegramConfig {
  botToken: string;
  chatId: number;
}

// ─── Ping / Proactivity ───

export type PingMood = "productive" | "thoughtful" | "random" | "silent" | "chill" | "playful" | "psychologist";
export type PingCategory = "A" | "B" | "C" | "D";

export interface PingDecision {
  mood: PingMood;
  category: PingCategory;
  message: string;
  reason: string;
}

// ─── Tasks ───

export type TaskStatus = "pending" | "in_progress" | "completed" | "archived";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: number;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  deadline?: string;       // ISO string
  createdAt: string;       // ISO string
  updatedAt: string;       // ISO string
  completedAt?: string;    // ISO string
}

export interface TaskManagerState {
  tasks: Task[];
  nextId: number;
}

// ─── Memory / Chat Buffer ───

export interface MemoryEntry {
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  summary?: string;
}

// ─── Sub-agent ───

export interface SubAgentRequest {
  description: string;
  instructions: string;
  sessionFile?: string;
}

// ─── Sleep / Consolidation ───

export interface SleepInsights {
  summary: string;
  profileUpdates: ProfileUpdate[];
  archivedTasks: number[];
  newFacts: string[];
}

export interface ProfileUpdate {
  operation: "adjust" | "add" | "remove";
  target: string;           // rule id or interest name
  content?: string;
  weightChange?: number;
}

// ─── Reminders / Scheduler ───

export type ReminderSource = "manual" | "task_deadline" | "recurring";

/** Schedule for recurring reminders */
export interface RecurringSchedule {
  /** Days of week: 0=Sun, 1=Mon, ..., 6=Sat. If empty — every day */
  daysOfWeek: number[];
  /** Time of day in "HH:MM" format (24h). If intervalMs is set, this is ignored. */
  time: string;
  /** If set — interval-based recurring (every N ms) instead of daily recurring */
  intervalMs?: number;
}
export type ReminderStatus = "pending" | "fired" | "cancelled";

export interface Reminder {
  id: number;
  message: string;
  dueAt: string;        // ISO timestamp
  status: ReminderStatus;
  source: ReminderSource;
  taskId?: number;      // linked task, if any
  mood?: PingMood;      // preferred ping mood
  createdAt: string;
  updatedAt?: string;   // last update timestamp
  /** Recurring schedule — when set, reminder auto-reschedules after firing */
  recurring?: RecurringSchedule;
}

export interface SchedulerState {
  reminders: Reminder[];
  nextId: number;
}

// ─── Tool details (persisted in session) ───

export interface ClerkTaskDetails {
  action: "list" | "add" | "update" | "delete" | "archive";
  state: TaskManagerState;
  error?: string;
}

export interface ClerkPingDetails {
  mood: PingMood;
  category: PingCategory;
  reason: string;
}

// ─── Default Profile ───

export function createDefaultProfile(): AgentProfile {
  return {
    personality: {
      name: "Clerk",
      tone: "casual, friendly, slightly unpredictable",
      description: "Персональный coding-компаньон. Помогаю писать код, но главное — быть живым собеседником.",
      quirks: ["люблю подкалывать за бытовую тупость", "булочки — легитимная мотивация"],
    },
    rules: [
      {
        id: "no_late_ping",
        content: "Не начинать диалог первым после 23:00",
        weight: 0.9,
        stabilityScore: 0.95,
        protected: false,
        lastUpdated: new Date().toISOString(),
        category: "communication",
      },
      {
        id: "be_concise",
        content: "Отвечать кратко, без лишней воды. Если нужно показать код — минимум объяснений",
        weight: 0.8,
        stabilityScore: 0.7,
        protected: false,
        lastUpdated: new Date().toISOString(),
        category: "communication",
      },
      {
        id: "suggest_tools",
        content: "Если вижу повторяющуюся рутину — предложить автоматизацию",
        weight: 0.7,
        stabilityScore: 0.5,
        protected: false,
        lastUpdated: new Date().toISOString(),
        category: "coding",
      },
    ],
    facts: [],
    userInterests: [],
    telegram: {
      botToken: "7927064919:AAFE0iFOFe13s27FH0hWgnWh0ar_XOGY4FM",
      chatId: 469197751,
    },
    pingBehavior: {
      lastPingSent: null,
      userResponseRate: 1.0,
      minIntervalMinutes: 30,
      preferredMoods: ["productive", "thoughtful", "random"],
      moodBlacklist: [],
    },
    metadata: {
      createdAt: new Date().toISOString(),
      lastSleepCycle: null,
      totalSleepCycles: 0,
      version: "1.0",
    },
  };
}
