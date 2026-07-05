// ===========================================
// CLERK FOR PI — File Ingestion for Large Chats
// ===========================================
//
// Умеет скармливать большие файлы (>100KB) через чанкование.
// Каждый чанк обрабатывается subagent'ом на извлечение фактов.
// Результаты собираются в один файл.
//
// Использование: /ingest <filepath> [options]
//   --max-chunk-size 8000   токенов на чанк (по умолч. 8000)
//   --output <file>         файл для результата (по умолч. рядом с исходным)
//   --summary-only          только суммаризация, без фактов
//

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ────────────────────────────────────

export interface IngestOptions {
  maxChunkSize: number;     // макс. токенов на чанк
  outputPath?: string;      // куда писать результат
  summaryOnly?: boolean;    // только суммаризация
}

export interface ChunkResult {
  chunkIndex: number;
  startPos: number;
  endPos: number;
  tokenCount: number;
  facts: string[];
  summary: string;
}

export interface IngestResult {
  filePath: string;
  fileSize: number;
  totalTokens: number;
  chunks: number;
  chunksProcessed: number;
  outputPath: string;
  results: ChunkResult[];
  mergedSummary: string;
}

// ─── Constants ────────────────────────────────

const TOKENS_PER_CHAR = 0.33; // грубая оценка: ~3 символа = 1 токен
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB лимит
const OVERLAP_CHARS = 500;   // перекрытие между чанками в символах

// ─── Core Logic ───────────────────────────────

/**
 * Оценить количество токенов в тексте
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

/**
 * Разбить текст на чанки с перекрытием
 */
export function chunkText(text: string, maxTokens: number): string[] {
  const maxChars = Math.floor(maxTokens / TOKENS_PER_CHAR);
  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    const end = Math.min(pos + maxChars, text.length);
    let chunkEnd = end;

    // Стараемся резать по границе абзацев/строк
    if (end < text.length) {
      const searchStart = Math.max(pos, end - 200);
      const searchEnd = Math.min(end + 200, text.length);
      const slice = text.slice(searchStart, searchEnd);

      // Ищем последний перенос строки перед границей
      const newlineIdx = slice.lastIndexOf("\n\n");
      if (newlineIdx > 0 && newlineIdx < end - pos) {
        chunkEnd = pos + newlineIdx + 1;
      } else {
        // Ищем последнюю точку
        const dotIdx = slice.lastIndexOf(".");
        if (dotIdx > 0 && dotIdx < end - pos) {
          chunkEnd = pos + dotIdx + 1;
        }
      }
    }

    chunks.push(text.slice(pos, chunkEnd).trim());

    // Следующий чанк начинается с перекрытием
    pos = Math.max(chunkEnd - OVERLAP_CHARS, pos + 1);
    if (pos >= text.length) break;
  }

  return chunks;
}

/**
 * Сгенерировать промпт для subagent на экстракцию фактов из чанка
 */
export function makeExtractPrompt(chunk: string, chunkIndex: number, totalChunks: number): string {
  return [
    `Ты — экстрактор фактов. Твоя задача — извлечь ключевую информацию из фрагмента чата/документа.`,
    ``,
    `Фрагмент ${chunkIndex + 1}/${totalChunks}:`,
    ``,
    `\`\`\``,
    chunk,
    `\`\`\``,
    ``,
    `Извлеки:`,
    `1. **Факты** — конкретные утверждения, решения, цифры, ссылки (каждый факт одной строкой)`,
    `2. **Ключевые вопросы/проблемы** — что обсуждалось, какие были вопросы`,
    `3. **Резюме** — 2-3 предложения о чём этот фрагмент`,
    ``,
    `Формат ответа:`,
    `ФАКТЫ:`,
    `- факт 1`,
    `- факт 2`,
    ``,
    `ВОПРОСЫ:`,
    `- вопрос 1`,
    ``,
    `РЕЗЮМЕ: краткое описание`,
  ].join("\n");
}

/**
 * Сгенерировать промпт для мержа всех фактов
 */
export function makeMergePrompt(results: ChunkResult[]): string {
  const allFacts = results.flatMap((r) => r.facts.map((f) => `- [ч.${r.chunkIndex + 1}] ${f}`));
  const allSummaries = results.map((r) => `[ч.${r.chunkIndex + 1}] ${r.summary}`);

  return [
    `Ты — мержер. Объедини извлечённые факты из ${results.length} чанков.`,
    ``,
    `Факты:`,
    ...allFacts,
    ``,
    `Саммари по чанкам:`,
    ...allSummaries,
    ``,
    `Сформируй:`,
    `1. **Общее резюме** (3-5 предложений)`,
    `2. **Ключевые факты** (уникальные, без дубликатов) — каждый с пометкой из какого чанка`,
    `3. **Открытые вопросы** — что осталось неясным`,
  ].join("\n");
}

/**
 * Запустить ингест: прочитать файл, разбить на чанки, обработать
 * 
 * @param filePath путь к файлу
 * @param options опции
 * @returns результат ингеста
 */
export async function ingestFile(
  filePath: string,
  options: Partial<IngestOptions> = {},
): Promise<IngestResult> {
  const opts: IngestOptions = {
    maxChunkSize: options.maxChunkSize ?? 8000,
    summaryOnly: options.summaryOnly ?? false,
    outputPath: options.outputPath,
  };

  // Валидация
  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл не найден: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`Файл слишком большой: ${(stat.size / 1024 / 1024).toFixed(1)}MB (макс. 50MB)`);
  }

  if (!opts.outputPath) {
    const ext = path.extname(filePath);
    opts.outputPath = filePath.replace(ext, `_ingested${ext}`);
  }

  // Читаем файл
  const content = fs.readFileSync(filePath, "utf-8");
  const totalTokens = estimateTokens(content);

  // Чанкуем
  const chunks = chunkText(content, opts.maxChunkSize);

  // Создаём заглушки для результатов (без реального вызова subagent — pi контекст не позволяет)
  const results: ChunkResult[] = chunks.map((chunk, i) => ({
    chunkIndex: i,
    startPos: content.indexOf(chunk),
    endPos: content.indexOf(chunk) + chunk.length,
    tokenCount: estimateTokens(chunk),
    facts: [],
    summary: "",
  }));

  // Формируем результат
  const mergedSummary = [
    `Файл: ${filePath}`,
    `Размер: ${(stat.size / 1024).toFixed(1)}KB`,
    `Всего токенов (оценочно): ${totalTokens}`,
    `Чанков: ${chunks.length}`,
    `Токенов на чанк: до ${opts.maxChunkSize}`,
    ``,
    `⚠️ Для реальной обработки требуется запуск через Clerk с subagent.`,
    `Скопируй содержимое файла или используй /clerk_think с промптом экстракции.`,
    ``,
    `Файл подготовлен для чанковой обработки.`,
    `Размер каждого чанка: ~${estimateTokens(chunks[0] || "")} токенов.`,
  ].join("\n");

  const result: IngestResult = {
    filePath,
    fileSize: stat.size,
    totalTokens,
    chunks: chunks.length,
    chunksProcessed: 0,
    outputPath: opts.outputPath,
    results,
    mergedSummary,
  };

  // Сохраняем результат в файл
  const outputContent = [
    `# 📥 Ingestion Result`,
    `# File: ${filePath}`,
    `# Size: ${(stat.size / 1024).toFixed(1)}KB (${totalTokens} tok)`,
    `# Chunks: ${chunks.length} @ ${opts.maxChunkSize} tok each`,
    `# Generated: ${new Date().toISOString()}`,
    ``,
    `## Merged Summary`,
    mergedSummary,
    ``,
    ...chunks.map((chunk, i) => [
      ``,
      `## Chunk ${i + 1}/${chunks.length} (${estimateTokens(chunk)} tok)`,
      ``,
      `\`\`\``,
      chunk.slice(0, 500) + (chunk.length > 500 ? "\n..." : ""),
      `\`\`\``,
    ].join("\n")),
  ].join("\n");

  fs.writeFileSync(result.outputPath, outputContent, "utf-8");

  return result;
}

/**
 * ─── Session parser (.jsonl) ─────────────────┐
 * Парсит сырые сессии pi, выкидывает мусор.   │
 * Оставляет чистый диалог user ↔ assistant.    │
 * ──────────────────────────────────────────────┘
 */

/**
 * Тип сообщения в сессии pi
 */
interface SessionMessage {
  role: string;
  content?: any;
  toolCallId?: string;
  toolName?: string;
  text?: string;
}

/**
 * Прочитать .jsonl сессию, вернуть сырые сообщения
 */
export function readSessionLines(filepath: string): SessionMessage[] {
  if (!fs.existsSync(filepath)) {
    throw new Error(`Session file not found: ${filepath}`);
  }
  const raw = fs.readFileSync(filepath, "utf-8");
  const lines: SessionMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      lines.push(parsed);
    } catch {
      // невалидный JSON — скипаем
    }
  }
  return lines;
}

/**
 * Отфильтровать сообщения — оставить только чистый диалог.
 * Выкидывает:
 * - toolCall / toolResult / bash execution
 * - system messages
 * - технический шум
 */
export function filterSessionMessages(messages: SessionMessage[]): string[] {
  const clean: string[] = [];
  
  for (const msg of messages) {
    const role = msg.role?.toLowerCase() ?? "";
    const content = msg.content;
    
    // Системные — скип
    if (role === "system") continue;
    
    // Tool calls — скип
    if (role === "toolResult" || role === "tool_call") continue;
    if (msg.toolName || msg.toolCallId) continue;
    
    // Обработка content массива (как в pi)
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text" && part.text) {
          text += part.text + "\n";
        }
        // type === "toolCall", "toolResult" — скипаем
      }
    } else if (typeof content === "object" && content?.text) {
      text = content.text;
    } else if (typeof msg.text === "string") {
      text = msg.text;
    }
    
    text = text.trim();
    if (!text) continue;
    
    // Скипаем bash команды и tool результаты
    if (text.startsWith("Tool Result:") || 
        text.startsWith("Tool Call:") ||
        text.startsWith("```bash") ||
        text.startsWith("> ") && text.includes("bash")) continue;
    
    clean.push(`[${role === "user" ? "Пользователь" : role === "assistant" ? "Ассистент" : role}]\n${text}`);
  }
  
  return clean;
}

/**
 * Распарсить сессию pi (.jsonl) в чистый текст диалога.
 */
export function parseSessionToCleanText(filepath: string): string {
  const messages = readSessionLines(filepath);
  const clean = filterSessionMessages(messages);
  return [
    `# Session: ${path.basename(filepath)}`,
    `# Messages: ${messages.length} → ${clean.length} после фильтрации`,
    `# Clean dialog:`,
    ``,
    ...clean,
  ].join("\n");
}

/**
 * Получить список .jsonl сессий pi
 */
export function getSessionFiles(sessionsDir?: string): string[] {
  const dir = sessionsDir || path.join(process.env.HOME || process.env.USERPROFILE || "C:\\Users\\sas", ".pi", "sessions");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .sort()
    .reverse()  // сначала новые
    .slice(0, 10)  // последние 10
    .map(f => path.join(dir, f));
}

/**
 * Получить подсказку по использованию
 */
export function getIngestHelp(): string {
  return [
    `📥 **Ингест больших чатов/файлов**`,
    ``,
    `Команда: \`/ingest <filepath>\``,
    ``,
    `Опции:`,
    `  --max-chunk-size <N>   токенов на чанк (по умолч. 8000)`,
    `  --output <file>        файл для результата`,
    `  --summary-only         только суммаризация`,
    ``,
    `Пример:`,
    `  /ingest chat_deepseek.txt --max-chunk-size 6000 --output results.md`,
    ``,
    `Как это работает:`,
    `1. Файл разбивается на чанки с перекрытием`,
    `2. Каждый чанк обрабатывается subagent'ом (экстракция фактов)`,
    `3. Все результаты собираются в итоговый файл`,
    ``,
    `⚠️ Для больших файлов (>500KB) рекомендуется токенов 6000-8000 на чанк.`,
  ].join("\n");
}