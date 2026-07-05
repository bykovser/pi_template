// ===========================================
// CLERK FOR PI — Profile (ROM)
// ===========================================
//
// Manages the agent profile YAML file — the "ROM" of Clerk.
// Handles loading, saving, rule management, and interest tracking.
//

import * as fs from "node:fs";
import { getProfilePath, readTextFile, writeJsonFile, toYaml } from "./utils.ts";
import type { AgentProfile, Rule, UserInterest } from "./types.ts";
import { createDefaultProfile } from "./types.ts";

/** Current in-memory profile */
let _profile: AgentProfile | null = null;

/** File watcher for hot-reload (optional) */
let _watcher: fs.FSWatcher | null = null;

/**
 * Load profile from disk, falling back to default
 */
export function loadProfile(): AgentProfile {
  const path = getProfilePath();
  try {
    if (!fs.existsSync(path)) {
      _profile = createDefaultProfile();
      saveProfile(_profile);
      return _profile;
    }
    const raw = readTextFile(path);
    _profile = parseYamlProfile(raw);
    return _profile;
  } catch (err) {
    console.error("[Clerk] Failed to load profile, using default:", err);
    _profile = createDefaultProfile();
    return _profile;
  }
}

/**
 * Get current cached profile (loads if not loaded)
 */
export function getProfile(): AgentProfile {
  if (!_profile) _profile = loadProfile();
  return _profile;
}

/**
 * Save profile to disk as YAML
 */
export function saveProfile(profile?: AgentProfile): void {
  const p = profile ?? _profile;
  if (!p) return;
  _profile = p;
  const yaml = serializeProfileToYaml(p);
  fs.writeFileSync(getProfilePath(), yaml, "utf-8");
}

/**
 * Get all active (non-deleted) rules
 */
export function getRules(): Rule[] {
  return getProfile().rules.filter((r) => r.weight > 0);
}

/**
 * Add a new rule (deduplicates by content — если правило с таким же текстом уже есть,
 * просто обновляет его lastUpdated вместо создания дубликата)
 */
export function addRule(content: string, category: Rule["category"] = "preference"): Rule {
  const profile = getProfile();

  // Проверяем — может такое правило уже есть?
  const existing = profile.rules.find(
    (r) => r.content.trim().toLowerCase() === content.trim().toLowerCase(),
  );
  if (existing) {
    existing.lastUpdated = new Date().toISOString();
    saveProfile();
    return existing;
  }

  const rule: Rule = {
    id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    content,
    weight: 0.3,
    stabilityScore: 0.2,
    protected: false,
    lastUpdated: new Date().toISOString(),
    category,
  };
  profile.rules.push(rule);
  saveProfile();
  return rule;
}

/**
 * Add a new fact (deduplicates by content)
 */
export function addFact(content: string, category: Fact["category"] = "knowledge"): Fact {
  const profile = getProfile();

  const existing = profile.facts.find(
    (f) => f.content.trim().toLowerCase() === content.trim().toLowerCase(),
  );
  if (existing) {
    existing.lastUpdated = new Date().toISOString();
    saveProfile();
    return existing;
  }

  const fact: Fact = {
    id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    content,
    category,
    lastUpdated: new Date().toISOString(),
  };
  profile.facts.push(fact);
  saveProfile();
  return fact;
}

/**
 * Get all facts
 */
export function getFacts(): Fact[] {
  return getProfile().facts;
}

/**
 * Update a rule's weight/stability
 */
export function updateRuleWeight(ruleId: string, delta: number): Rule | null {
  const profile = getProfile();
  const rule = profile.rules.find((r) => r.id === ruleId);
  if (!rule || rule.protected) return null;
  rule.weight = Math.max(0, Math.min(1, rule.weight + delta));
  rule.stabilityScore = Math.min(1, rule.stabilityScore + 0.1);
  rule.lastUpdated = new Date().toISOString();
  saveProfile();
  return rule;
}

/**
 * Remove a rule (set weight to 0, or remove if not protected)
 */
export function removeRule(ruleId: string): boolean {
  const profile = getProfile();
  const idx = profile.rules.findIndex((r) => r.id === ruleId);
  if (idx === -1) return false;
  const rule = profile.rules[idx];
  if (rule.protected) return false;
  profile.rules.splice(idx, 1);
  saveProfile();
  return true;
}

/**
 * Get user interests
 */
export function getUserInterests(): UserInterest[] {
  return getProfile().userInterests;
}

/**
 * Upsert a user interest
 */
export function upsertInterest(topic: string, priority: UserInterest["priority"] = "medium"): UserInterest {
  const profile = getProfile();
  const existing = profile.userInterests.find(
    (i) => i.topic.toLowerCase() === topic.toLowerCase(),
  );
  if (existing) {
    existing.priority = priority;
    existing.lastMentioned = new Date().toISOString();
  } else {
    profile.userInterests.push({ topic, priority, lastMentioned: new Date().toISOString() });
  }
  saveProfile();
  return existing ?? profile.userInterests[profile.userInterests.length - 1];
}

/**
 * Serialize profile to YAML string
 */
function serializeProfileToYaml(p: AgentProfile): string {
  return [
    "personality:",
    `  name: "${p.personality.name}"`,
    `  tone: "${p.personality.tone}"`,
    `  description: "${p.personality.description}"`,
    `  quirks: [${(p.personality.quirks ?? []).map(q => `"${q}"`).join(", ")}]`,
    "",
    "rules:",
    ...p.rules.map((r) =>
      [
        `  - id: ${r.id}`,
        `    content: "${r.content.replace(/"/g, '\\"')}"`,
        `    weight: ${r.weight}`,
        `    stabilityScore: ${r.stabilityScore}`,
        `    protected: ${r.protected}`,
        `    lastUpdated: "${r.lastUpdated}"`,
        r.category ? `    category: ${r.category}` : "",
        r.successRate !== undefined ? `    successRate: ${r.successRate}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
    "facts:",
    ...(p.facts.length === 0
      ? ["  []"]
      : p.facts.map((f) =>
          [
            `  - id: ${f.id}`,
            `    content: "${f.content.replace(/"/g, '\\"')}"`,
            f.category ? `    category: ${f.category}` : "",
            `    lastUpdated: "${f.lastUpdated}"`,
          ]
            .filter(Boolean)
            .join("\n"),
        )),
    "",
    "userInterests:",
    ...(p.userInterests.length === 0
      ? ["  []"]
      : p.userInterests.map(
          (i) =>
            `  - topic: "${i.topic}"\n    priority: ${i.priority}\n    lastMentioned: "${i.lastMentioned}"`,
        )),
    "",
    "telegram:",
    `  botToken: "${p.telegram?.botToken ?? ""}"`,
    `  chatId: ${p.telegram?.chatId ?? 0}`,
    "",
    "pingBehavior:",
    `  lastPingSent: ${p.pingBehavior.lastPingSent ? `"${p.pingBehavior.lastPingSent}"` : "null"}`,
    `  userResponseRate: ${p.pingBehavior.userResponseRate}`,
    `  minIntervalMinutes: ${p.pingBehavior.minIntervalMinutes}`,
    "  preferredMoods:",
    ...p.pingBehavior.preferredMoods.map((m) => `    - ${m}`),
    "  moodBlacklist:",
    ...(p.pingBehavior.moodBlacklist.length === 0
      ? ["    []"]
      : p.pingBehavior.moodBlacklist.map((b) => `    - "${b}"`)),
    "",
    "metadata:",
    `  createdAt: "${p.metadata.createdAt}"`,
    `  lastSleepCycle: ${p.metadata.lastSleepCycle ? `"${p.metadata.lastSleepCycle}"` : "null"}`,
    `  totalSleepCycles: ${p.metadata.totalSleepCycles}`,
    `  version: "${p.metadata.version}"`,
    "",
  ].join("\n");
}

/**
 * Minimal YAML parser for our profile structure
 */
function parseYamlProfile(raw: string): AgentProfile {
  const defaultProfile = createDefaultProfile();

  try {
    const lines = raw.split("\n");
    const result: AgentProfile = JSON.parse(JSON.stringify(defaultProfile));

    let section: string | null = null;
    let currentFact: Partial<Fact> | null = null;
    let currentRule: Partial<Rule> | null = null;
    let currentInterest: Partial<UserInterest> | null = null;
    let inList = false;
    let inBlockScalar: string | null = null;
    let blockScalarLines: string[] = [];

    const setValue = (path: string[], value: string) => {
      let obj: any = result;
      for (let i = 0; i < path.length - 1; i++) {
        if (!(path[i] in obj)) obj[path[i]] = {};
        obj = obj[path[i]];
      }
      const key = path[path.length - 1];

      // Type coercion
      if (value === "null" || value === "null") obj[key] = null;
      else if (value === "true") obj[key] = true;
      else if (value === "false") obj[key] = false;
      else if (value === "[]") obj[key] = [];
      else if (!isNaN(Number(value)) && key !== "name" && key !== "content" && key !== "tone" && key !== "description" && key !== "topic" && key !== "id") {
        obj[key] = Number(value);
      } else {
        obj[key] = value.replace(/^"|"$/g, "");
      }
    };

    for (const rawLine of lines) {
      // If we're collecting a block scalar
      if (inBlockScalar) {
        const trimmedLine = rawLine.trim();
        // Check if line is indented (continuation of block scalar)
        if (rawLine.startsWith("  ") && rawLine.length > 2) {
          blockScalarLines.push(rawLine.slice(2));
          continue;
        } else {
          // End of block scalar
          (result as any)[inBlockScalar] = blockScalarLines.join("\n");
          inBlockScalar = null;
          blockScalarLines = [];
          // Fall through to process this line
        }
      }

      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Section headers
      if (trimmed.endsWith(":") && !trimmed.startsWith("-") && !trimmed.startsWith("[")) {
        const secName = trimmed.slice(0, -1).trim();
        if (["personality", "rules", "facts", "userInterests", "pingBehavior", "metadata"].includes(secName)) {
          section = secName;
          inList = false;
          currentRule = null;
          currentFact = null;
          currentInterest = null;
        }
        // Check for block scalar fields
        const blockFieldMatch = trimmed.match(/^(\w+): \|$/);
        if (blockFieldMatch) {
          inBlockScalar = blockFieldMatch[1];
          blockScalarLines = [];
          section = null;
        }
        continue;
      }

      // List items
      if (trimmed.startsWith("- ")) {
        const val = trimmed.slice(2).trim();
        if (section === "preferredMoods") {
          result.pingBehavior.preferredMoods.push(val as any);
          continue;
        }
        if (section === "moodBlacklist") {
          result.pingBehavior.moodBlacklist.push(val.replace(/^"|"$/g, ""));
          continue;
        }
        if (section === "rules") {
          if (currentRule && currentRule.id) {
            result.rules.push(currentRule as Rule);
          }
          currentRule = {};
          inList = true;
          // Could be inline like "- id: foo"
          const colonIdx = val.indexOf(":");
          if (colonIdx > 0) {
            const k = val.slice(0, colonIdx).trim();
            const v = val.slice(colonIdx + 1).trim();
            (currentRule as any)[k] = v.replace(/^"|"$/g, "");
          }
          continue;
        }
        if (section === "facts") {
          if (currentFact && currentFact.id) {
            result.facts.push(currentFact as Fact);
          }
          currentFact = {};
          inList = true;
          const colonIdx = val.indexOf(":");
          if (colonIdx > 0) {
            const k = val.slice(0, colonIdx).trim();
            const v = val.slice(colonIdx + 1).trim();
            (currentFact as any)[k] = v.replace(/^"|"$/g, "");
          }
          continue;
        }
        if (section === "userInterests") {
          if (currentInterest && currentInterest.topic) {
            result.userInterests.push(currentInterest as UserInterest);
          }
          currentInterest = {};
          inList = true;
          const colonIdx = val.indexOf(":");
          if (colonIdx > 0) {
            const k = val.slice(0, colonIdx).trim();
            const v = val.slice(colonIdx + 1).trim();
            (currentInterest as any)[k] = v.replace(/^"|"$/g, "");
          }
          continue;
        }
        continue;
      }

      // Rules continuation lines
      if (inList && currentRule && trimmed.includes(":")) {
        const colonIdx = trimmed.indexOf(":");
        const k = trimmed.slice(0, colonIdx).trim();
        let v = trimmed.slice(colonIdx + 1).trim();
        if (v.endsWith("]")) v = "[]";
        (currentRule as any)[k] = v.replace(/^"|"$/g, "");
        if (k === "weight" || k === "stabilityScore") {
          (currentRule as any)[k] = Number(v.replace(/^"|"$/g, ""));
        }
        if (k === "protected") {
          (currentRule as any)[k] = v.replace(/^"|"$/g, "") === "true";
        }
        continue;
      }

      // Facts continuation lines
      if (inList && currentFact && trimmed.includes(":")) {
        const colonIdx = trimmed.indexOf(":");
        const k = trimmed.slice(0, colonIdx).trim();
        let v = trimmed.slice(colonIdx + 1).trim();
        (currentFact as any)[k] = v.replace(/^"|"$/g, "");
        continue;
      }

      // User interests continuation lines
      if (inList && currentInterest && trimmed.includes(":")) {
        const colonIdx = trimmed.indexOf(":");
        const k = trimmed.slice(0, colonIdx).trim();
        let v = trimmed.slice(colonIdx + 1).trim();
        (currentInterest as any)[k] = v.replace(/^"|"$/g, "");
        continue;
      }

      // Key-value pairs
      if (trimmed.includes(":") && section) {
        const colonIdx = trimmed.indexOf(":");
        const k = trimmed.slice(0, colonIdx).trim();
        let v = trimmed.slice(colonIdx + 1).trim();

        if (v === "" || v === "null") v = "null";

        switch (section) {
          case "personality":
            if (k === "quirks") {
              try {
                result.personality.quirks = JSON.parse(v.replace(/'/g, '"').replace(/\[(.*)\]/, '[$1]'));
              } catch {
                result.personality.quirks = v.replace(/^\[|\]$/g, "").split(",").map((s: string) => s.trim().replace(/^"|"$/g, ""));
              }
            } else if (k in result.personality) {
              (result.personality as any)[k] = v.replace(/^"|"$/g, "");
            }
            break;
          case "telegram":
            if (!(result as any).telegram) (result as any).telegram = { botToken: "", chatId: 0 };
            const tg = (result as any).telegram;
            if (k === "botToken") tg.botToken = v.replace(/^"|"$/g, "");
            if (k === "chatId") tg.chatId = Number(v);
            break;
          case "pingBehavior":
            if (k === "lastPingSent") result.pingBehavior.lastPingSent = v === "null" ? null : v.replace(/^"|"$/g, "");
            else if (k === "userResponseRate") result.pingBehavior.userResponseRate = Number(v);
            else if (k === "minIntervalMinutes") result.pingBehavior.minIntervalMinutes = Number(v);
            break;
          case "metadata":
            if (k === "createdAt") result.metadata.createdAt = v.replace(/^"|"$/g, "");
            else if (k === "lastSleepCycle") result.metadata.lastSleepCycle = v === "null" ? null : v.replace(/^"|"$/g, "");
            else if (k === "totalSleepCycles") result.metadata.totalSleepCycles = Number(v);
            else if (k === "version") result.metadata.version = v.replace(/^"|"$/g, "");
            break;
        }
      }
    }

    // Push last parsed items
    if (currentRule && currentRule.id) result.rules.push(currentRule as Rule);
    if (currentFact && currentFact.id) result.facts.push(currentFact as Fact);
    if (currentInterest && currentInterest.topic) result.userInterests.push(currentInterest as UserInterest);

    return result;
  } catch (err) {
    console.error("[Clerk] YAML parse error, using default:", err);
    return defaultProfile;
  }
}

/**
 * Setup file watcher for hot-reload of profile
 */
export function watchProfile(onChange: (profile: AgentProfile) => void): void {
  try {
    if (_watcher) _watcher.close();
    _watcher = fs.watch(getProfilePath(), (eventType) => {
      if (eventType === "change") {
        const profile = loadProfile();
        onChange(profile);
      }
    });
  } catch {
    // File watching not critical
  }
}

/**
 * Stop watcher
 */
export function unwatchProfile(): void {
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
}