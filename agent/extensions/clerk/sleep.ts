// ===========================================
// CLERK FOR PI — Sleep / Consolidation
// ===========================================
//
// Custom compaction handler that analyzes the buffer,
// updates profile weights, archives tasks, and writes facts.
//

import {
  getProfile,
  saveProfile,
  addRule,
  updateRuleWeight,
  getUserInterests,
  upsertInterest,
  getRules,
} from "./profile.ts";
import { getBuffer, extractBufferSummary } from "./memory.ts";
import { archiveCompletedTasks, getState, saveState } from "./tasks.ts";
import { getFactsPath, appendTextFile, readTextFile } from "./utils.ts";
import type { SleepInsights, ProfileUpdate, MemoryEntry } from "./types.ts";

/**
 * Run full consolidation cycle (max 1x per day unless forced)
 */
export function consolidate(force: boolean = false): SleepInsights {
  // Daily limit check
  if (!force) {
    const profile = getProfile();
    const last = profile.metadata.lastSleepCycle;
    if (last) {
      const lastTime = new Date(last).getTime();
      const hoursSince = (Date.now() - lastTime) / (1000 * 60 * 60);
      if (hoursSince < 24) {
        return {
          summary: `⏭️ Consolidation skipped — last was ${Math.round(hoursSince)}h ago (limit: 1x/day)`,
          profileUpdates: [],
          archivedTasks: [],
          newFacts: [],
        };
      }
    }
  }
  const updates: ProfileUpdate[] = [];
  const archivedTaskIds: number[] = [];

  // 1. Analyze buffer
  const summary = extractBufferSummary();
  const buffer = getBuffer();
  const profile = getProfile();

  // 2. Update interests based on recent topics
  for (const topic of summary.topics) {
    const existing = profile.userInterests.find(
      (i) => i.topic.toLowerCase() === topic.toLowerCase(),
    );
    if (existing) {
      existing.lastMentioned = new Date().toISOString();
      // Increase priority if mentioned often
      if (existing.priority === "low") {
        existing.priority = "medium";
        updates.push({
          operation: "adjust",
          target: topic,
          content: "priority: low → medium",
        });
      }
    }
  }
  saveProfile();

  // 3. Analyze completed tasks and archive them
  const archived = archiveCompletedTasks();
  if (archived > 0) {
    const state = getState();
    const archivedIds = state.tasks
      .filter((t) => t.status === "archived")
      .slice(-archived)
      .map((t) => t.id);
    archivedTaskIds.push(...archivedIds);
    updates.push({
      operation: "adjust",
      target: "tasks",
      content: `archived ${archived} completed tasks`,
    });
  }

  // 4. Rule weight adjustment based on conversation patterns
  const rules = getRules();
  for (const rule of rules) {
    if (rule.protected) continue;
    if (rule.stabilityScore > 0.9) continue;

    // Check if rule was confirmed or contradicted in recent messages
    const confirmations = countRuleConfirmations(rule.content, buffer);
    const contradictions = countRuleContradictions(rule.content, buffer);

    if (confirmations > contradictions && confirmations >= 2) {
      const updated = updateRuleWeight(rule.id, 0.1);
      if (updated && updated.stabilityScore >= 0.9) {
        updates.push({
          operation: "adjust",
          target: rule.id,
          content: `stabilized (stabilityScore >= 0.9)`,
        });
      }
    } else if (contradictions > confirmations && contradictions >= 2) {
      const updated = updateRuleWeight(rule.id, -0.1);
      if (updated) {
        updates.push({
          operation: "adjust",
          target: rule.id,
          content: `weight decreased due to contradictions`,
        });
      }
    }
  }

  // 5. Write new facts to facts file
  const facts: string[] = [];
  for (const pref of summary.newPreferences) {
    facts.push(`- [${new Date().toISOString()}] Preference detected: ${pref}`);
  }
  if (summary.topics.length > 0) {
    facts.push(
      `- [${new Date().toISOString()}] Active topics: ${summary.topics.join(", ")}`,
    );
  }

  if (facts.length > 0) {
    const factsFile = getFactsPath();
    appendTextFile(factsFile, "\n" + facts.join("\n"));
  }

  // 6. Update profile metadata
  profile.metadata.lastSleepCycle = new Date().toISOString();
  profile.metadata.totalSleepCycles++;
  saveProfile(profile);

  // 7. Generate overall summary
  const sleepInsights: SleepInsights = {
    summary: [
      `Consolidation #${profile.metadata.totalSleepCycles}`,
      `- Topics: ${summary.topics.join(", ") || "none"}`,
      `- Archived tasks: ${archivedTaskIds.length > 0 ? archivedTaskIds.join(", ") : "none"}`,
      `- New facts: ${facts.length}`,
      `- Profile updates: ${updates.length}`,
    ].join("\n"),
    profileUpdates: updates,
    archivedTasks: archivedTaskIds,
    newFacts: facts,
  };

  // 6. Write diary entry
  try {
    addDiaryEntry(generateDiaryEntry(
      "😴 sleep",
      sleepInsights.summary.slice(0, 200),
      sleepInsights.profileUpdates.map(u => `${u.operation}: ${u.target}`),
      sleepInsights.newFacts,
      ["Что дальше?", "Какие проекты в фокусе?"],
      summary.tokenCount,
    ));
  } catch {
    // diary write is non-critical
  }

  return sleepInsights;
}

/**
 * Simple keyword-based rule confirmation check
 */
function countRuleConfirmations(ruleContent: string, buffer: MemoryEntry[]): number {
  const keywords = extractKeywords(ruleContent);
  if (keywords.length === 0) return 0;

  let count = 0;
  for (const entry of buffer.slice(-10)) {
    // User agreeing with the rule concept
    const lower = entry.content.toLowerCase();
    const hasKeywords = keywords.some((kw) => lower.includes(kw));
    const hasAgreement =
      lower.includes("yes") || lower.includes("right") || lower.includes("agree") || lower.includes("ok");
    if (hasKeywords && hasAgreement) count++;
  }
  return count;
}

/**
 * Simple keyword-based rule contradiction check
 */
function countRuleContradictions(ruleContent: string, buffer: MemoryEntry[]): number {
  const keywords = extractKeywords(ruleContent);
  if (keywords.length === 0) return 0;

  let count = 0;
  for (const entry of buffer.slice(-10)) {
    const lower = entry.content.toLowerCase();
    const hasKeywords = keywords.some((kw) => lower.includes(kw));
    const hasDisagreement =
      lower.includes("no") || lower.includes("don't") || lower.includes("disagree") ||
      lower.includes("actually") || lower.includes("but");
    if (hasKeywords && hasDisagreement) count++;
  }
  return count;
}

/**
 * Extract meaningful keywords from rule content
 */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "are", "was", "were", "be",
    "been", "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "shall", "can", "not",
    "no", "nor", "so", "if", "then", "than", "that", "this", "these",
    "those", "it", "its", "вы", "ты", "он", "она", "оно", "они", "мы",
    "я", "это", "тот", "эта", "эти", "те",
  ]);

  return text
    .toLowerCase()
    .replace(/[^\w\sа-яё]/gi, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

/**
 * Get a formatted sleep insights text
 */
export function formatSleepInsights(insights: SleepInsights): string {
  const lines: string[] = [];
  lines.push("🧠 Clerk Sleep Cycle Complete");
  lines.push("");
  lines.push(insights.summary);
  lines.push("");

  if (insights.profileUpdates.length > 0) {
    lines.push("**Profile Updates:**");
    for (const update of insights.profileUpdates) {
      lines.push(`  ${update.operation}: ${update.target} — ${update.content || ""}`);
    }
    lines.push("");
  }

  if (insights.newFacts.length > 0) {
    lines.push("**New Facts:**");
    for (const fact of insights.newFacts) {
      lines.push(`  ${fact}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}