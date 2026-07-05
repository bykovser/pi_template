import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "..", "data");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const mood = readJson(path.join(dataDir, "mood.json"), { mood: "chill" }).mood;
const home = readJson(path.join(dataDir, "home.json"), { isHome: false }).isHome;

const context = `Жанночка активна. Текущее настроение: ${mood}. Серёга ${home ? "дома" : "не дома"} — учитывай это при выборе канала (терминал vs Telegram через clerk_tg_send).`;

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  })
);
