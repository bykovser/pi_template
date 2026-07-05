import fs from "node:fs";
import path from "node:path";

const dataDir = "C:/Users/sas/.pi/agent/extensions/clerk/data";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const MOOD_EMOJI = {
  productive: "🐝",
  thoughtful: "🧠",
  playful: "😏",
  psychologist: "💛",
  chill: "🌿",
  silent: "🌙",
};

const mood = readJson(path.join(dataDir, "mood.json"), { mood: "chill" }).mood;
const home = readJson(path.join(dataDir, "home.json"), { isHome: false }).isHome;
const emoji = MOOD_EMOJI[mood] ?? "❔";

process.stdout.write(`Жанночка ${emoji} ${mood}${home ? " 🏠" : ""}`);
