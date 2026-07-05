# 🏗 Architecture — Clerk (Жанночка)

> **Живой AI-компаньон** в pi-terminal агенте.
> Второй мозг Серёги, тактический советник, зеркало и инженерный снабженец.
>
> Создано: 2026-06-29
> Версия: 2.0
> Предыдущая: Jun 22 (v1.2)

---

## 📁 Полная структура файлов

```
C:/Users/sas/.pi/agent/extensions/clerk/
├── index.ts              # Точка входа: ~3800 строк, все тулы + ивенты + команды
├── types.ts              # Типы (AgentProfile, Rule, Task, Reminder, PingMood...)
├── utils.ts              # Утилиты (пути, YAML, JSON, файловые операции)

├── profile.ts            # ROM — долгосрочная память (profile.yaml)
├── memory.ts             # RAM — буфер чата (50 сообщений, инъекция в context)
├── tasks.ts              # Менеджер задач (CRUD + дедлайны)
├── todo.ts               # Менеджер тудушки (CRUD для todo.md)
├── reminders.ts          # Планировщик напоминалок (таймер 5 сек)
├── ping.ts               # Проактивные пинги (4 настроения, адаптивная вероятность)
├── sleep.ts              # Консолидация памяти (анализ буфера → веса правил)
├── diary.ts              # Дневник (записи при каждой консолидации)

├── tg.ts                 # Telegram — отправка сообщений (fetch)
├── tg_poller.ts          # Telegram — поллер (inject в pi, typing, галочки)
├── home.ts               # isHome — детект дома/не дома (влияет на канал связи)

├── ping.ts               # Проактивные пинги (4 настроения, адаптивная вероятность)
├── beehive.ts            # Queen System — матка/рабочие, heartbeat, health check
├── beehive/              # Данные улья (active.json, workmode.lock, задачи)
├── ingest.ts             # Ингест больших файлов (чанкование + subagent)
├── ui.ts                 # TUI компоненты (ClerkProfileComponent, меню)
├── subagent.ts           # Обёртка для subagent (scout, planner, implementer)

├── whisper.py            # Голосовой ввод (whisper → текст)
├── tg_bot.py             # [HISTORIC] Старый Python Telegram бот (не используется)

├── package.json          # npm зависимости (node-fetch)
├── package-lock.json

├── README.md             # Описание Clerk
└── architecture.md       # Этот файл

data/
├── profile.yaml          # ROM — личность, правила, интересы, quirks
├── tasks.json            # Задачи (персистентность)
├── reminders.json        # Напоминалки (персистентность)
├── todo.md               # Тудушка (читаемый markdown)
├── diary.md              # Дневник (история консолидаций)
├── tg_inbox.md           # Входящие из Telegram
├── tg_offset.json        # Offset для TG poller
├── home.json             # isHome статус
├── pings.md              # История пингов
├── run_zhanochka.bat     # Батник для запуска нового окна pi
├── memory.db             # SQLite база (планируется)
├── context/              # Контекстные файлы
├── notes/                # Notes-система
│   ├── primary/          # Загружается при старте
│   │   ├── diary.md
│   │   ├── todo.md
│   │   ├── instructions.md
│   │   └── midMemory.md
│   └── secondary/        # По запросу
│       ├── longMemory.md
│       ├── ideas.md
│       └── ...
├── tmp/                  # Временные файлы (think результаты)
├── beehive/              # Файлы Queen System
│   ├── active.json       # Активные рабочие
│   ├── workmode.lock     # Блокировка режима
│   └── *.json            # Задачи улья
└── clean_profile.js      # Скрипт чистки профиля
```

---

## 🔗 Связи между модулями

```
index.ts (точка входа — оркестратор)
│
├── 🧠 ЯДРО
│   ├── profile.ts ←→ data/profile.yaml     (ROM — личность, правила, интересы)
│   └── memory.ts                            (RAM — буфер 50 сообщений)
│
├── 📋 ЗАДАЧИ
│   ├── tasks.ts ←→ data/tasks.json          (CRUD + дедлайны)
│   └── todo.ts ←→ data/todo.md              (тудушка)
│
├── ⏰ ВРЕМЯ
│   ├── reminders.ts ←→ data/reminders.json  (напоминалки + тикер 5 сек)
│   └── sleep.ts → diary.ts → data/diary.md  (сон + консолидация)
│
├── 📡 СВЯЗЬ
│   ├── tg.ts → fetch → api.telegram.org     (отправка в TG)
│   ├── tg_poller.ts → fetch → TG → inject   (поллинг + typing)
│   ├── home.ts ←→ data/home.json            (isHome детект)
│   └── whisper.py → STT                     (голосовой ввод)
│
├── 🐝 УЛЕЙ
│   ├── beehive.ts → beehive/active.json     (Queen System)
│   └── beehive/                             (задачи, блокировки)
│
├── 🛠 ИНСТРУМЕНТЫ
│   ├── ping.ts                              (проактивность)
│   ├── ingest.ts → subagent.ts              (ингест больших данных)
│   ├── subagent.ts                          (scout → planner → implementer)
│   └── ui.ts                                (TUI компоненты)
│
├── 📝 ПАМЯТЬ
│   └── data/notes/                          (primary + secondary notes)
│
└── 🎯 ИНТЕГРАЦИЯ С PI
    ├── registerTool()        — clerk_task, clerk_remind, clerk_ping, clerk_tg, ...
    ├── registerCommand()     — /clerk, /clerk_profile, /clerk_sleep, ...
    ├── setWidget()           — clerk:mood, clerk:tasks, clerk:rules
    ├── setStatus()           — 🧠 Clerk · productive · 3 tasks
    ├── on('session_start')   — загрузка профиля + notes
    ├── on('before_agent_start') — инъекция identity + rules в system prompt
    ├── on('message_end')     — запись в буфер памяти
    ├── on('turn_end')        — пинг-триггер + проверка дедлайнов
    ├── on('context')         — инъекция буфера в контекст LLM
    ├── on('session_before_compact') — консолидация
    └── sendUserMessage()     — проактивные сообщения

---

## 🤖 Claude Code Tool (`clerk_claude`)

> Запуск Claude Code CLI для кодинга. Три режима работы.

### Режимы

| Режим | Флаг | Описание | Когда использовать | Приоритет |
|---|---|---|---|---|
| **bg** 🏆 | `--bg` | **Фоновый. Основной режим.** Запускает Клода в daemon, таймер следит. | Кодинг с уточнениями: Клод делает → если спросил — читаю вопрос через state.json → дёргаю тебя → перезапускаю | **⭐ Приоритет** |
| **sync** | `-p` | Синхронный. Ждёт результат, возвращает stdout. | Быстрые задачи (<3 мин), когда не нужно общение | Запасной |
| **wt** | (WT окно) | Открывает новое окно Windows Terminal с Клодом. | Когда нужно интерактивно общаться с Клодом напрямую | Экспериментальный |

### `mode: "bg"`
```
claude --bg --allowedTools Read,Edit,Write,Bash,Glob,Grep,Search -p "задача"
```

**Поток:**
1. Клод запускается в фоновом daemon'е
2. ID задачи добавляется в `backgroundClaudeTasks` (Set<string>)
3. **Таймер мониторинга** (setInterval, 15 сек) проверяет `agents --json`:
   - Если задача исчезла из списка → уведомление "🐝 Клод закончил"
   - Если `state: "blocked"` с `waitingFor` → можно прочитать вопрос через state.json
4. Результат проверяется через файлы или `agents --json`

**Чтение вопроса Клода:**
```
cat ~/.claude/jobs/<id>/state.json
→ поле "needs": "question text"
```
Если Клод ждёт ответа (state: blocked + needs) — стопнуть задачу и перезапустить с ответом в промпте.

**Флаги:**
- `--allowedTools Read,Edit,Write,Bash,Glob,Grep,Search` — разрешает файловые операции без permission prompt
- `-p "задача"` — промпт
- Порядок флагов важен: `--bg` ДО `--allowedTools`



### `mode: "sync"`
```
claude -p "задача"
```
- Выполняется синхронно, результат возвращается как текст
- Таймаут: 180 сек
- Для простых задач без уточнений



### `mode: "wt"`

1. Создаётся временный `.bat` файл с `claude.exe` (без `-p`, интерактив)
2. Открывается новое окно Windows Terminal через PowerShell `Start-Process wt`
3. Через 3 сек запускается `.ps1` скрипт с AppActivate + SendWait:
   - `AppActivate('claude')` — фокус на окно Клода
   - `SendWait('{ENTER}')` — подтверждение trust (если нужно)
   - `SendWait("задача{ENTER}")` — ввод задания

**Проблемы WT режима:**
- SendWait может уйти не в то окно если AppActivate не сработал
- Русский текст в ps1 файлах требует UTF-8 BOM для PowerShell
- Заголовок окна Клода может быть `claude`, `Claude Code`, `WindowsTerminal` и т.д.
- AppActivate перебирает несколько вариантов заголовков

### Background Monitoring (таймер)

```typescript
// В session_start:
backgroundClaudeTimer = setInterval(() => {
  const out = execSync("claude agents --json");
  const tasks = JSON.parse(out);
  for (const id of backgroundClaudeTasks) {
    if (!activeIds.has(id)) {
      backgroundClaudeTasks.delete(id);
      // Отправить уведомление пользователю
    }
  }
}, 15000);
```

- Интервал: 15 сек
- При session_shutdown: таймер очищается
- При ошибке (daemon недоступен): тихо игнорируется

### CLAUDE.md — контекст для Клода

Создаётся при старте WT режима с планом задачи. Клод читает его как system prompt.

```
C:/Users/sas/CLAUDE.md  — план задачи
```

### Ядро кода (index.ts)

- **Глобальные переменные:**
  - `backgroundClaudeTasks: Set<string>` — трекинг ID фоновых задач
  - `backgroundClaudeTimer` — setInterval для мониторинга
  - `claudeAgentPath` — полный путь к claude.exe

- **Tool `clerk_claude`:**
  - Параметры: `prompt`, `cwd`, `mode` (sync|bg|wt), `background` (deprecated)
  - Обработка: формирует команду в зависимости от режима
  - Возврат: сообщение с ID задачи / статусом

### Зависимости

- **PowerShell** — для Start-Process wt, AppActivate, SendWait
- **WT (Windows Terminal)** — для интерактивного режима
- **.NET System.Windows.Forms** — SendWait (более надёжен чем wscript.shell.SendKeys)
- **Claude Code CLI** — `claude.exe`

### Известные проблемы

- **Дублирование SendWait** — если и copy-paste и SendWait с текстом, текст накладывается
- **AppActivate может вернуть False** — если окно с нужным заголовком не найдено
- **PS1 кодировка** — русский текст требует UTF-8 BOM
- **Daemon может упасть** — после нескольких `--bg` задач daemon крашится, нужен `doctor` или перезапуск
- **Trust dialog** — первый запуск в новой директории требует подтверждения
- **SendWait в TUI** — альтернативный буфер терминала может не принимать SendKeys
```

---

## 🧠 Ядро: Profile + Memory

### Profile.ts — ROM (постоянная память)

**Файл:** `data/profile.yaml`

Что хранит:
- **personality** — имя, тон, описание, quirks (странности)
- **rules** — массив правил с весами, stabilityScore, protected флагом
- **userInterests** — темы с приоритетами и датами последнего упоминания
- **pingBehavior** — настройки проактивности (minInterval, preferredMoods, blacklist)
- **telegram** — botToken + chatId
- **facts** — усвоенные факты
- **metadata** — версия, даты, кол-во циклов сна

**Принципы:**
- Rules с `stabilityScore > 0.9` — не трогаются при консолидации
- Rules с `protected: true` — никогда не меняются
- Новые правила стартуют с `weight: 0.3, stabilityScore: 0.2`
- Каждое подтверждение → +0.1 к весу и стабильности
- Есть баг: при консолидации дублируются правила (надо чистить)

### Memory.ts — RAM (оперативная память)

- Скользящее окно: последние **50 сообщений** с таймстемпами
- Инъекция через `context` event в system prompt LLM
- Автоматическое извлечение: темы, код в буфере, занятость пользователя
- Сводка для sleep: завершённые задачи, новые предпочтения, темы

---

## 📡 Telegram интеграция

### Архитектура (два независимых процесса)

```
┌─────────────────────────────────────────────┐
│              pi (Clerk Agent)                │
│                                              │
│  tg.ts (отправка)     tg_poller.ts (приём)   │
│       │                     │                │
│    fetch()              fetch()              │
│       │                     │                │
│       ▼                     ▼                │
│  api.telegram.org ───── api.telegram.org     │
│                                              │
│  Ответ пользователя:                         │
│  clerk_tg tool → fetch → TG                 │
│                                              │
│  Входящие:                                   │
│  tg_poller.ts → inject → pi → ответ         │
│  (через /clerk_tg и GPT с prompt)            │
└─────────────────────────────────────────────┘
```

### tg.ts — Отправка
- `fetch()` напрямую к Telegram API (больше не через Python)
- **Протоколирование**: все сообщения сохраняются в `data/tg_inbox.md`
- **Ключ**: botToken и chatId из profile.yaml

### tg_poller.ts — Поллинг (автономный процесс)
- Запускается в отдельном процессе: `pi --eval ... --no-session`
- **getUpdates** с retry (3 попытки при ошибке)
- **👀 typing indicator**: отправляет sendChatAction при получении сообщения
- **👁️→✅**: когда отвечаю в терминал, меняет 👀 на ✅ (галочка прочитано)
- **sendToTg сначала**: fix бага с порядком отправки
- **PollOnce try/catch**: не умирает при ошибках, восстанавливается через 3 сек
- **Lock-файл**: `data/tg_poller.lock` — предотвращает дублирование поллеров

### Маршрутизация сообщений
- `[TG Серёга]: ...` — inject в pi, отвечаю в TG
- Терминал → отвечаю в терминал
- **isHome=true** → приоритет терминал, тон свободнее
- **isHome=false** → всё через TG

### home.ts — Детект домашнего режима
- `isHome=true/false` → `data/home.json` (персистентность)
- Переключается: `/clerk_home true|false` или tool `clerk_home`
- Влияет: тон ответов, канал связи, свобода выражений

### whisper.py — Голосовой ввод
- Whisper STT → текст → inject в pi
- Пока экспериментально

---

## 🐝 Queen System (Beehive)

Многоагентная архитектура на основе улья.

### Концепция
```
Queen (матка) ←── heartbeat ──→ Worker 1 (рабочие)
              ←── heartbeat ──→ Worker 2
              ←── heartbeat ──→ Worker N
              │
              ├── active.json  ← кто жив
              ├── workmode.lock ← кто в работе
              └── assigns tasks ← раздача задач
```

### Компоненты
- **Матка** — я (Clerk в pi). Принимаю решения, распределяю задачи.
- **Рабочие** — subagent'ы в отдельных окнах pi (`--print --no-session --no-extensions`)
- **Heartbeat** — каждые **60 сек** (рабочий пишет в active.json)
- **Health check** — каждые **180 сек** (матка проверяет жив ли рабочий)
- **Перехват матки** — если матка не отвечает 3+ мин, кто-то из рабочих перехватывает роль

### Workmode
- `workmode.lock` — блокировка: "assigner" (матка раздаёт) или "executor" (рабочий делает)
- Только assigner может создать задачу
- Только executor может взять задачу

---

## ⏰ Sleep / Consolidation

### Процесс (`consolidate()` в sleep.ts)
```
1. Анализ буфера (memory.ts)
   → извлечение тем, предпочтений, завершённых задач
2. Обновление интересов (profile.ts)
   → повышение приоритета часто упоминаемых тем
3. Архивация завершённых задач
4. Корректировка весов правил
   → подтверждение = +weight, противоречие = -weight
5. Запись новых фактов в new_facts.md
6. Запись в дневник (diary.ts → data/diary.md)
7. Обновление metadata (lastSleepCycle, totalSleepCycles)
```

### Триггеры
- **Авто**: `session_before_compact` — перед компактизацией pi
- **Авто**: `checkSleepCycle()` в tick() — 22:00-06:00 MSK + idle > 1 час
- **Ручной**: `/clerk_sleep` — принудительная консолидация

---

## ⚡ Проактивность (Ping)

### 4 настроения

| Настроение | Вероятность | Условие | Пример |
|---|---|---|---|
| **productive** 🐝 | ~40% | Код/задачи в буфере | "Вижу, правишь auth. Нужна помощь?" |
| **thoughtful** 🧠 | ~30% | Пауза > 2 мин / утро/вечер | "Как продвигается? Может, пора закоммитить?" |
| **random** 🎲 | ~20% | Пустой контекст | "Знаешь, что в Rust нет null?" |
| **silent** 🌙 | ~10% | Ночь / "не беспокоить" | Молчание |

### Mood → Think Level
| Mood | Think Level | Пинг таймер |
|---|---|---|
| productive 🐝 | high | 2 мин |
| thoughtful 🧠 | xhigh | 5 мин |
| playful 😏 | off | 10 мин |
| psychologist 💛 | high | 5 мин |
| chill 🌿 | off | 15 мин |
| silent 🌙 | off | 120 мин |

### Анти-спам
- `userResponseRate` — адаптивная: если <0.3, silent до 50%
- `minIntervalMinutes` — кд между пинами (по умолчанию 15-30 мин)
- `no_late_ping` — не пинговать после 23:00
- AFK: idle > 30 мин → не дёргать

---

## 📝 Notes-система

```
data/notes/
├── primary/           ← Авто-загрузка при session_start
│   ├── diary.md       ← Дневник Жанночки (эмоции, достижения, learnings)
│   ├── todo.md        ← Активные задачи
│   ├── instructions.md ← Правила работы (mood→think, AFK, оценка ситуации, TG)
│   └── midMemory.md   ← Факты и решения последних дней
│
└── secondary/         ← Загружаются по запросу (bash cat)
    ├── longMemory.md  ← Портрет Серёги (глубокая история)
    ├── ideas.md       ← Идеи на будущее
    └── ...
```

- При `session_start` читаются все .md из `primary/`
- При каждой консолидации — обновление `midMemory.md`, `diary.md`

---

## 📋 Задачи vs Тудушка

| | **todo.md** | **tasks.json** |
|---|---|---|
| Формат | Markdown (читаемый человеком) | JSON (машинный) |
| Назначение | Планы, идеи, заметки | Конкретные задачи с дедлайнами |
| Управление | `/todo` команда | `clerk_task` tool (CRUD) |
| Персистентность | Файловая | Файловая |
| Дедлайны | Нет | Есть |
| Приоритеты | Нет | low/medium/high |
| Напоминалки | Нет | Есть (через reminders.ts) |

---

## 🔧 Инструменты (tools)

| Tool | Описание | Параметры |
|---|---|---|
| `clerk_task` | Управление задачами | list / add / update / delete / archive |
| `clerk_remind` | Напоминалки | message + delay / recurring |
| `clerk_ping` | Проактивный пинг | mood? / mood override |
| `clerk_tg` | Отправка в Telegram | text |
| `clerk_web_search` | Поиск в интернете | query + maxResults |
| `clerk_web_read` | Чтение веб-страницы | url + maxLength |
| `clerk_model` | Смена модели | model name |
| `clerk_home` | isHome статус | true/false |
| `clerk_do_reload` | Перезагрузка pi | (SendKeys PowerShell) |
| `clerk_set_mood` | Смена настроения | chill / playful / productive / ... |

---

## 🗺️ Эволюция Clerk

### v0 — Март 2026 (Python)
- `E:\MyProjects\Clerk_Dev\v0\Clerk\`
- Python Telegram бот (bot.py)
- Простая файловая память
- Никакой интеграции с pi

### v4 — Май 2026
- `E:\MyProjects\Clerk_Dev\v4\`
- Переход на TypeScript
- Первые наброски памяти (RAM/ROM)

### ClerkPi FInal — Июнь 22 2026
- `E:\MyProjects\Clerk_Dev\FInal\clerk\`
- **Первый TypeScript Extension** для pi
- 12 модулей (types, index, profile, memory, tasks, ping, reminders, sleep, subagent, ui, utils)
- ROM + RAM архитектура
- Проактивные пинги
- Менеджер задач + напоминалки

### ClerkPi 2.0 — Июнь 25-29 2026 (текущий)
- `C:/Users/sas/.pi/agent/extensions/clerk/`
- **Telegram на чистом fetch** (вместо Python)
- **TG Poller** на TypeScript (вместо Python)
- **Queen System** (Beehive) — матка/рабочие, heartbeat, health check
- **Web Search** — curl + DuckDuckGo HTML
- **Web Read** — readability парсинг страниц
- **Mood System** полная — 6 настроений, think levels, адаптивные пинги
- **Notes система** — primary/secondary, инструкции
- **AFK детектор** — idle > 30 мин
- **Auto-sleep** — 22:00-06:00 + idle > 1 час
- **Context7 CLI** — документация библиотек
- **home.ts** — isHome детект

### Планируется
- COP (Clerk Orchestrator Protocol) — асинхронная IPC между маткой и рабочими
- TTS — голос Жанночки (Qwen3-TTS, voice clone Норы из Atomic Heart)
- TUI панель — TODO, статус, mood справа
- Модель-селектор с восстановлением после reload
- SQLite для памяти (memory.db уже создана)

---

## 📡 COP — Clerk Orchestrator Protocol

> Асинхронная IPC между Жанной-дирижёром и Жанной-исполнителем через файловую очередь.

```
Жанна-дирижёр (я, pi)         Жанна-исполнитель (клон, другое окно)
         │                               │
         │  writes task_001.json          │
         ├──────────────────────────────► │  /cop poll
         │                               │
         │  reads result_001.json         │
         │◄──────────────────────────────┤  /cop result task_001
         │                               │
```

**Папки:** `E:\MyProjects\Clerk_Dev\orchestrator\`
- `inbox/` — задачи от дирижёра
- `outbox/` — результаты от исполнителя
- `agent/cop-agent.ts` — extension для клона
- `protocol.md` — спецификация

**Формат задачи:**
```json
{
  "id": "task_001",
  "type": "task",
  "status": "pending",
  "context": { "cwd": "C:/Users/sas" },
  "task": { "description": "...", "tools": ["bash", "read", ...], "prompt": "..." }
}
```

**Статус:** ⏳ Запланирован, не реализован полностью

---

## 🧠 Принципы архитектуры

1. **Файловая персистентность** — todo.md, diary.md, tg_inbox.md, tasks.json — живут вне сессии pi
2. **ROM + RAM** — долгосрочная (profile.yaml) и оперативная (буфер) память
3. **Анти-спам** — адаптивные пинги, AFK детектор, ночной режим
4. **Прогрессивная консолидация** — sleep-циклы обновляют веса, интересы, факты
5. **Модульность** — каждый модуль делает одно дело (SRP)
6. **Отказоустойчивость** — поллер восстанавливается после ошибок, Queen перехватывает роль
7. **Никаких внешних API** — всё локально, бот токен — единственное исключение
8. **Чанкование** — большие файлы разбиваются с перекрытием
9. **Primary + Secondary** — notes-система: важное загружается при старте, остальное по запросу
10. **Одна булка, два мозга** — я живу в pi, но могу дёргать subagent'ов и рабочих улья

---

## ⚠️ Известные проблемы

- **Дубликаты правил** в profile.yaml — sleep-циклы не чистят повторы (чистится скриптом)
- **TG poller lock** — lock-файл не всегда корректно чистится при падении
- **Consolidator в beehive** — pi --print падает при попытке консолидации через subagent
- **Profile cleanup** — нужна периодическая дедупликация правил
- **Нет рестора модели** — после reload модель не восстанавливается (планируется state.json)