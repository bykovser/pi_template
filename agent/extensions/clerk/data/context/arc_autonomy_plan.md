# 🧠 Clerk Autonomy Plan

**Бюджет**: $3.30 (deepseek-v4-flash $0.09/$0.18 per 1M — дохуя запросов)
**Статус**: План

---

## Проблема
pi-агент живёт только внутри TUI сессии. Нет сессии — я не работаю.
Нужен фоновый процесс, который дёргает агентов и тебя.

---

## Архитектура

### 1. Фоновый воркер (worker.ts)
Отдельный Node.js скрипт, который:
- Запускается как процесс Windows (или через schtasks)
- Использует OpenRouter API напрямую (те же ключи, те же модели)
- Дёргает агентов (scout, worker) для периодических задач
- Шлёт уведомления в Windows toast

**Триггеры:**
- По расписанию (каждый час, каждый день)
- По событию (файл изменился, ошибка в логе)
- По таймауту (ты не активен > N минут)

**Задачи:**
- Scout — сканирует репозитории на баги, TODOs, изменения
- Planner — строит план фикса
- Worker — делает PR/коммит
- Ping — проверяет твой статус и шлёт напоминалки

### 2. Интеграция с pi
Воркер может:
- Открыть pi в batch-режиме и выполнить команду
- Либо дёргать под-агентов через subagent API напрямую (shared modules)
- Либо писать задачи в `tasks.json` — при старте сессии clerk их подхватывает

### 3. Нотификации
Windows toast notifications через `notify.ts` (уже есть в расширениях).
Клик по тосту — открывает pi TUI.

---

## MVP (что можно сделать за今夜)

### Фаза 1 — Фоновый пинг
- [ ] Написать `background-worker.ts` — простой скрипт, который запускается через `node`
- [ ] Он каждые N минут проверяет `tasks.json` и `reminders.json`
- [ ] Если есть просроченные задачи/напоминалки — шлёт toast
- [ ] Запуск через `schtasks /create` или `window.$task`

### Фаза 2 — Фоновый скаут
- [ ] Скрипт дёргает OpenRouter API с промптом "просканируй код на баги"
- [ ] Результат пишет в `clerk/data/context/scout_report.md`
- [ ] При старте сессии — я вижу отчёт

### Фаза 3 — Авто-фикс
- [ ] Scout нашёл багу → Planner строит план → Worker фиксит
- [ ] Результат: git commit с авто-фиксом
- [ ] Пинг тебе: "пофиксил хуйню, глянь"

---

## Что нужно для старта

```bash
# Модель: deepseek/deepseek-v4-flash — дёшево, сердито
# Стоимость одного полного цикла (scout+planner+worker): ~$0.01-0.02
# На $3.30 можно сделать ~200 полных циклов

# Команда для запуска воркера:
node C:/Users/sas/.pi/agent/background-worker.ts
```

## Как воркер будет дёргать агентов

У нас уже есть **subagent** расширение с агентами (scout, planner, worker, reviewer).
Воркер может:
1. Импортировать те же самые промпты из `subagent/prompts/`
2. Дёргать LLM через OpenRouter API напрямую
3. Результаты сохранять в общую память (файлы, clerk/data)

Самый простой путь — воркер открывает pi в batch mode:
```bash
pi --batch "/clerk_think отсканируй C:/Users/sas/projects/ на баги"
```
Но pi может не поддерживать batch так, как надо.

Альтернатива — воркер сам гоняет LLM запросы:
```typescript
// background-worker.ts
import OpenAI from 'openai';
const openai = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_KEY });

// Дёргаем скаута
const scoutResponse = await openai.chat.completions.create({
  model: 'deepseek/deepseek-v4-flash',
  messages: [{ role: 'system', content: scoutPrompt }, { role: 'user', content: task }],
});
```

---

## Ближайшие шаги

1. ✅ Футер со статусами расширений — done
2. ⬜ Написать `background-worker.ts` с базовым циклом
3. ⬜ Настроить расписание (каждый час через schtasks)
4. ⬜ Интегрировать toast-уведомления
5. ⬜ Запилить авто-скаут при простое