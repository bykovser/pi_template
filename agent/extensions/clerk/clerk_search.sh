#!/bin/bash
# Поиск в сессиях Clerk по ключевому слову
# Использование: bash clerk_search.sh "ключевое слово"
#
# Ищет по всем .md файлам в data/notes/ и data/context/

SEARCH_DIR="C:/Users/sas/.pi/agent/extensions/clerk/data"
QUERY="$1"

if [ -z "$QUERY" ]; then
  echo "❌ Укажи ключевое слово: bash clerk_search.sh \"что ищем\""
  exit 1
fi

echo "🔍 Ищем \"$QUERY\" в сессиях Clerk..."
echo "=============================="

# Ищем в notes (primary + secondary) и context
for f in "$SEARCH_DIR/notes/primary/"*.md "$SEARCH_DIR/notes/secondary/"*.md "$SEARCH_DIR/context/"*.md "$SEARCH_DIR/"*.md; do
  if [ -f "$f" ] && grep -qi "$QUERY" "$f" 2>/dev/null; then
    filename=$(basename "$f")
    echo ""
    echo "📄 $filename:"
    echo "------------------------------"
    grep -n -i --color=never "$QUERY" "$f" | head -10
  fi
done

echo ""
echo "=============================="
echo "✅ Готово"