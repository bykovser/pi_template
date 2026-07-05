// ===========================================
// CLERK FOR PI — Sub-agent Wrapper
// ===========================================
//
// Adds Clerk-style chain commands: /clerk_think, /clerk_review.
// Delegates to pi's built-in subagent tool via user messages.
//

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Generate a prompt for the scout agent (problem exploration)
 */
export function makeScoutPrompt(query: string): string {
  return [
    "You are a **scout agent** — your job is to explore and understand the problem space.",
    "",
    `## Query: ${query}`,
    "",
    "Explore this problem from multiple angles:",
    "- What is the core issue or goal?",
    "- What technologies or approaches might be relevant?",
    "- What are potential pitfalls or challenges?",
    "- What information is missing?",
    "",
    "Output a structured exploration with at least 3-5 angles.",
    "Be thorough but concise — focus on actionable insights.",
  ].join("\n");
}

/**
 * Generate a prompt for the planner agent (solution design)
 */
export function makePlannerPrompt(scoutOutput: string, query: string): string {
  return [
    "You are a **planner agent** — your job is to design a solution based on exploration.",
    "",
    `## Original Query: ${query}`,
    "",
    "## Exploration Results",
    scoutOutput.length > 2000
      ? scoutOutput.slice(0, 2000) + "\n\n...[truncated]..."
      : scoutOutput,
    "",
    "Based on the exploration above, create a detailed plan:",
    "- Step-by-step implementation approach",
    "- Files to create or modify",
    "- Key decisions and their rationale",
    "- Testing strategy",
    "",
    "Output a concrete, actionable plan.",
  ].join("\n");
}

/**
 * Generate a prompt for the worker agent (execution)
 */
export function makeWorkerPrompt(planOutput: string, query: string): string {
  return [
    "You are a **worker agent** — your job is to execute the plan.",
    "",
    `## Original Query: ${query}`,
    "",
    "## Plan",
    planOutput.length > 3000
      ? planOutput.slice(0, 3000) + "\n\n...[truncated]..."
      : planOutput,
    "",
    "Execute the plan step by step. Use read, write, edit, and bash tools as needed.",
    "Report progress as you go. Ask for clarification if needed.",
  ].join("\n");
}

/**
 * Generate a prompt for the reviewer agent (code review)
 */
export function makeReviewerPrompt(): string {
  return [
    "You are a **reviewer agent** — your job is to review code changes critically.",
    "",
    "Review the current state of the project. Focus on:",
    "- Code quality and correctness",
    "- Potential bugs or edge cases",
    "- Performance considerations",
    "- Security implications",
    "- Adherence to best practices",
    "- Documentation needs",
    "",
    "For each issue found, provide:",
    "1. **Severity**: critical / major / minor",
    "2. **Location**: file and line (if applicable)",
    "3. **Description**: what the issue is",
    "4. **Suggestion**: how to fix it",
    "",
    "Be constructive and specific. Praise good patterns too!",
  ].join("\n");
}

/**
 * Save think output to a temp file (for reference)
 */
export function saveThinkOutput(stage: string, content: string): string {
  const tmpDir = path.join(os.tmpdir(), "clerk-think");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const safeStage = stage.replace(/[^\w-]/g, "_");
  const filePath = path.join(tmpDir, `${safeStage}-${Date.now()}.md`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Build a subagent task for the scout → planner → worker chain
 */
export function buildThinkSubagentTasks(
  query: string,
): Array<{ agent: string; task: string }> {
  return [
    {
      agent: "default",
      task: makeScoutPrompt(query),
    },
    {
      agent: "default",
      task: "Based on the previous exploration, now create a detailed implementation plan. {previous}",
    },
    {
      agent: "default",
      task: "Execute the plan from the previous step. Use tools (read, write, edit, bash) as needed. {previous}",
    },
  ];
}

/**
 * Build a subagent task for code review
 */
export function buildReviewSubagentTask(): { agent: string; task: string } {
  return {
    agent: "default",
    task: makeReviewerPrompt(),
  };
}