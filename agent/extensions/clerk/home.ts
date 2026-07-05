// ===========================================
// CLERK FOR PI — isHome state
// ===========================================
//
// Флаг "Серёга дома" — влияет на то, пишу я в TG или в терминал.
// Хранится в home.json, переживает reload.
// Переключается: clerk_home tool или я сама по контексту.
//

import { getDataDir, readJsonFile, writeJsonFile } from "./utils.ts";
import * as path from "node:path";

const HOME_FILE = path.join(getDataDir(), "home.json");

interface HomeState {
  isHome: boolean;
  updated: string; // ISO timestamp
}

let _homeState: HomeState = readJsonFile<HomeState>(HOME_FILE, {
  isHome: false,
  updated: new Date().toISOString(),
});

/**
 * Получить текущее состояние isHome
 */
export function getIsHome(): boolean {
  return _homeState.isHome;
}

/**
 * Установить isHome и сохранить в home.json
 */
export function setIsHome(home: boolean): void {
  _homeState = { isHome: home, updated: new Date().toISOString() };
  writeJsonFile(HOME_FILE, _homeState);
  console.log(`[Home] isHome = ${home}`);
}