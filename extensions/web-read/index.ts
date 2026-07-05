// 🏖️ WEB-READ — pi tool for reading web page content
//
// Cleans HTML from CSS/JS/nav/ad clutter, returns readable text.
// Strategies (auto-fallback):
//   1) readability-lxml  (Mozilla algorithm — best for articles)
//   2) html2text         (HTML → Markdown conversion)
//   3) JS detection      (if content empty → report "requires JS")
//
// Standalone extension — no Clerk dependency, safe to /reload independently.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

// Puppeteer-core — опционально, для JS страниц
let puppeteer: any = null;
try {
  puppeteer = require("puppeteer-core");
} catch {
  console.log("[web-read] puppeteer-core not available, JS pages won't work");
}

const PY_PARSER = join(__dirname, "parsers.py");
const TMP_HTML = "C:\\Users\\sas\\AppData\\Local\\Temp\\_wr.html";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/** Download URL → save to temp file */
function curl(url: string): void {
  const q = url.replace(/"/g, "'");
  execSync(
    `curl -s -L "${q}" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --max-time 15 -o "${TMP_HTML}"`,
    { timeout: 20000, encoding: "utf-8", windowsHide: true, shell: true }
  );
}

/** Download URL via headless Chrome (Puppeteer) → save rendered HTML */
async function puppeteerFetch(url: string): Promise<boolean> {
  let browser: any = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.goto(url, { waitUntil: "networkidle0", timeout: 15000 });
    // Extra wait for any lazy-loaded content
    await new Promise((r) => setTimeout(r, 1000));
    const html = await page.content();
    writeFileSync(TMP_HTML, html, "utf-8");
    return true;
  } catch (e: any) {
    console.log("[web-read] puppeteer failed:", e.message?.slice(0, 100));
    return false;
  } finally {
    if (browser) await browser.close();
  }
}

/** Run python parser script → return result as JSON */
function parse(strategy: string, maxLength: number): any {
  // Используем прямые слэши — Python на Windows отлично их понимает
  const pyDir = __dirname.replace(/\\/g, "/");
  const pyHtml = TMP_HTML.replace(/\\/g, "/");

  const pyCode = [
    `import subprocess, json, sys, chardet`,
    `sys.stdout.reconfigure(encoding="utf-8")`,
    `sys.path.insert(0, "${pyDir}")`,
    `from parsers import extract`,
    `with open("${pyHtml}", "rb") as f: raw = f.read()`,
    `enc = chardet.detect(raw)["encoding"] if chardet else "utf-8"`,
    `html = raw.decode(enc, errors="replace")`,
    `result = extract(html)`,
    `result["encoding"] = enc`,
    `result["html_len"] = len(html)`,
    `if result.get("text"):`,
    `    result["text"] = result["text"][:${maxLength}]`,
    `print(json.dumps(result))`,
  ].join("\n");

  const tmpPy = "C:\\Users\\sas\\AppData\\Local\\Temp\\_wr_parser.py";
  writeFileSync(tmpPy, pyCode, "utf-8");
  try {
    const out = execSync(`python "${tmpPy}"`, {
      timeout: 20000,
      encoding: "utf-8",
      windowsHide: true,
    });
    return JSON.parse(out.trim());
  } finally {
    try { unlinkSync(tmpPy); } catch {}
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "clerk_web_read",
    label: "Web Read",
    description:
      "Загрузить веб-страницу по URL и прочитать её содержимое. " +
      "Очищает от CSS/JS/рекламы/навигации, возвращает чистый текст. " +
      "Использует readability (Mozilla algorithm) с fallback на html2text. " +
      "Для JS-сайтов — подключает headless Chrome (Puppeteer).",

    parameters: Type.Object({
      url: Type.String({ description: "URL страницы для чтения" }),
      maxLength: Type.Optional(
        Type.Number({
          description: "Макс. количество символов (500-5000)",
          default: 3000,
        })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: { url: string; maxLength?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: any
    ) {
      const { url } = params;
      const maxLength = Math.min(Math.max(params.maxLength || 3000, 500), 5000);

      if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
        return {
          content: [
            { type: "text" as const, text: "❌ Некорректный URL. Нужно начинать с http:// или https://" },
          ],
        };
      }

      try {
        // Step 1: try curl
        curl(url);

        let result: any;
        if (!existsSync(TMP_HTML)) {
          result = { strategy: "empty", title: url, text: "" };
        } else {
          result = parse("readability", maxLength);
        }

        // Step 2: if empty → try headless Chrome (Puppeteer) for JS pages
        if (result.strategy === "empty") {
          const puppeteerOk = await puppeteerFetch(url);
          if (puppeteerOk && existsSync(TMP_HTML)) {
            result = parse("readability", maxLength);
          }
        }

        // Step 3: still empty → report
        if (result.strategy === "empty") {
          let msg = `⚠️ Страница "${result.title || url}" не содержит читаемого текста.\n`;
          msg += `Возможно, это SPA или JS-only сайт. Попробуй найти информацию через поиск.`;
          return { content: [{ type: "text" as const, text: msg }] };
        }

        // Step 4: construct response
        let text = `📄 **${result.title || "Без названия"}**\n`;
        text += `🔗 ${url}\n`;
        text += `📊 ${result.text.length} зн. | стратегия: ${result.strategy} | кодировка: ${result.encoding}\n\n`;
        text += result.text;
        text += `\n\n_Обрезано до ${maxLength} символов. Скажи "полностью" если нужно больше._`;

        return { content: [{ type: "text" as const, text: text.slice(0, 4000) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Ошибка: ${e.message?.slice(0, 200) || "неизвестная"}` }] };
      } finally {
        try { unlinkSync(TMP_HTML); } catch {}
      }
    },

    renderCall(args: any, theme: Theme, _context: any) {
      const q = theme.truncate(args.url || "", 50);
      return new Text(theme.fg("toolTitle", theme.bold("clerk_web_read ")) + theme.fg("accent", q), 0, 0);
    },

    renderResult(result: any, _options: any, theme: Theme, _context: any) {
      const text = result.content?.[0]?.text || "";
      const preview = text.length > 80 ? text.slice(0, 80) + "…" : text;
      return new Text(theme.fg("success", preview), 0, 0);
    },
  });
}