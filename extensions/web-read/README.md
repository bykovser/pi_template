# 🏖️ Web Read — парсер веб-страниц для pi

**Плагин для pi-coding-agent**, который позволяет читать содержимое веб-страниц через `clerk_web_read` tool.

## Установка

```bash
pip install readability-lxml html2text chardet
```

Расширение лежит в `~/.pi/extensions/web-read/` — pi подхватывает его автоматически.

## Использование

Скажи агенту: *"прочитай страницу https://..."* или *"почитай статью про..."*

Агент вызовет `clerk_web_read`:

- **url** — полный URL страницы
- **maxLength** — максимальное количество символов (по умолч. 3000)

## Как работает

1. **curl** — загружает HTML страницы (таймаут 15 сек)
2. **readability-lxml** — Mozilla-алгоритм, вычищает мусор, оставляет основной контент
3. **html2text** — fallback, если readability не дал контента
4. **Кодировка** — chardet → cp1251 → utf-8

## Стратегии

| Стратегия | Описание |
|-----------|----------|
| **readability** | Mozilla Readability (алгоритм ридера) — вытаскивает статью, чистит навигацию/рекламу |
| **html2text** | HTML → Markdown — сохраняет структуру |
| **auto** | Сначала readability, если контент пустой — html2text |

## Что НЕ работает

- SPA/React/Vue сайты, где контент рендерится через JS (сообщит об этом)
- Страницы, требующие авторизации
- PDF/бинарные файлы

## Разработка

```
📁 .pi/extensions/web-read/
├── index.ts       # pi tool регистрация
├── parsers.py     # Python: readability + html2text + chardet
└── README.md      # этот файл
```

## Планы

- [ ] puppeteer-core для JS-only страниц
- [ ] Кэширование результатов
- [ ] Чтение PDF через pdftotext