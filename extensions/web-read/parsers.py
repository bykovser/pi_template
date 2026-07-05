"""
🌐 Web Read parsers for pi extension.

Strategies:
  - extract_readability: Mozilla Readability algorithm (best for articles)
  - extract_html2text: HTML → Markdown (fallback)
  - detect_encoding: auto-detect encoding (chardet) with cp1251 fallback

Usage:
  from parsers import extract_readability, extract_html2text, detect_encoding
"""

import re
from typing import Optional, List

# Try readability-lxml (Mozilla algorithm)
try:
    from readability import Document as ReadabilityDoc
    HAS_READABILITY = True
except ImportError:
    HAS_READABILITY = False

# Try html2text
try:
    import html2text as _h2t
    HAS_HTML2TEXT = True
except ImportError:
    HAS_HTML2TEXT = False

# Try chardet
try:
    import chardet
    HAS_CHARDET = True
except ImportError:
    HAS_CHARDET = False


# ─── NAVIGATION FILTER — слова-мусор для пост-процессинга ───

# Строки, целиком состоящие из этих слов (регистронезависимо), считаются навигацией
_NAV_WORDS = {
    "search", "dashboard", "navigation", "menu", "home",
    "contact", "github", "docs", "overview", "installation",
    "plans", "pricing", "api", "guide", "intro", "changelog",
    "tutorial", "faq", "about", "blog", "careers", "pricing",
    "sign in", "sign up", "log in", "log out", "register",
    "subscribe", "follow", "tweet", "share",
    "cookie", "privacy", "terms", "copyright",
    "all rights reserved", "powered by",
    "table of contents", "on this page", "related articles",
    "cookie preferences", "manage cookies",
    "ask assistant", "ask ai", "ai assistant",
}

# Регулярки для мусорных строк
_CLUTTER_RE = [
    re.compile(r"^search\.{0,3}…?$", re.IGNORECASE),         # "Search", "Search...", "Search…"
    re.compile(r"^⌘k", re.IGNORECASE),                        # "⌘KAsk Assistant"
    re.compile(r"^ctrl\s*k", re.IGNORECASE),                  # "Ctrl K"
    re.compile(r"^[\W_]{1,15}$"),                             # только спецсимволы
    re.compile(r"^[\d\s\.\-\*\(\)\[\]]+$"),                   # только цифры/пули
    re.compile(r"^\[.+\]\(.+\)$"),                            # одинокий маркдаун-линк
    re.compile(r"^\*\s+\[.+\]\(.+\)$"),                       # "* [Link](url)"
    re.compile(r"^-\s+\[.+\]\(.+\)$"),                        # "- [Link](url)"
    re.compile(r"^[\d]+\.\s+\[.+\]\(.+\)$"),                  # "1. [Link](url)"
    re.compile(r"^!\[.+\]\(.+\)$"),                           # одиночная картинка
]


def _is_clutter_line(line: str) -> bool:
    """Check if a line is navigation/UI clutter."""
    raw = line
    line = line.strip()

    if not line or len(line) < 3:
        return True

    # Check regex patterns
    for pat in _CLUTTER_RE:
        if pat.search(line):
            return True

    # Normalize for keyword check: lowercase, remove trailing punctuation
    lower = line.lower().strip().rstrip("….:;!?·•-–—()[]{}<>")

    # Exact match against known nav words
    if lower in _NAV_WORDS:
        return True

    # Single short word that's not a header — likely nav
    words = lower.split()
    if len(words) == 1 and len(lower) < 25 and not raw.startswith(("#", "**", "__")):
        # Check if it's in nav words (partial), or contains link
        if not re.search(r"[а-яёa-z]{4,}", lower) or lower in _NAV_WORDS:
            return True

    # Starts with nav keyword (e.g. "Search results", "Dashboard overview")
    first_word = words[0].rstrip(",…:;") if words else ""
    if len(words) <= 3 and first_word in _NAV_WORDS:
        return True

    # Link-only lines
    if re.match(r"^\s*\[.+\]\(.+\)", line) and not re.search(r"[а-яёa-z]{4,}", line):
        return True

    # Markdown list items with single nav-word
    list_match = re.match(r"^\s*[\*\-\+]\s+(.+)$", line)
    if list_match:
        content = list_match.group(1).strip().rstrip("….:;!?")
        if content.lower() in _NAV_WORDS or len(content) < 2:
            return True

    return False


def _post_process(text: str) -> str:
    """Clean extracted text: remove nav clutter, normalize whitespace."""
    lines = text.split("\n")
    cleaned: List[str] = []
    for line in lines:
        if not _is_clutter_line(line):
            cleaned.append(line)

    text = "\n".join(cleaned)

    # Normalize excessive newlines
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    text = re.sub(r" +\n", "\n", text)
    text = re.sub(r"\n +", "\n", text)

    # Remove leading/trailing whitespace per line
    text = "\n".join(l.strip() for l in text.split("\n"))

    # Remove duplicate empty lines
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()


# ─── EXTRACTION STRATEGIES ───

def extract_readability(html: str) -> Optional[dict]:
    """
    Extract main content using Mozilla Readability algorithm.
    Returns {"title": str, "text": str} or None.
    """
    if not HAS_READABILITY or not html.strip():
        return None

    try:
        doc = ReadabilityDoc(html)
        title = doc.title() or ""
        content = doc.summary()

        if not content or len(content.strip()) < 50:
            return {"title": title, "text": ""}

        # Clean the extracted HTML
        text = _clean_html(content)
        text = _post_process(text)

        if len(text) < 100:
            return {"title": title, "text": ""}

        return {"title": title, "text": text}
    except Exception:
        return None


def extract_html2text(html: str) -> Optional[dict]:
    """
    Convert HTML to Markdown using html2text.
    Returns {"title": str, "text": str} or None.
    """
    if not HAS_HTML2TEXT or not html.strip():
        return None

    try:
        # Extract title
        title_match = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE | re.DOTALL)
        title = title_match.group(1).strip() if title_match else ""

        # Convert to Markdown
        converter = _h2t.HTML2Text()
        converter.body_width = 0  # no line wrapping
        converter.ignore_links = False
        converter.ignore_images = True
        converter.ignore_emphasis = False
        converter.protect_links = True
        converter.unicode_snob = True  # use Unicode, not ASCII
        converter.skip_internal_links = True
        converter.images_to_alt = True

        text = converter.handle(html)
        text = _post_process(text)

        if not text or len(text) < 100:
            return {"title": title, "text": ""}

        return {"title": title, "text": text}
    except Exception:
        return None


# ─── MASTER EXTRACTOR ───

def extract(html: str) -> dict:
    """
    Extract content from HTML using best available strategy.
    Returns {"title": str, "text": str, "strategy": str}.
    """
    # Try readability first
    r = extract_readability(html)
    if r and r["text"]:
        r["strategy"] = "readability"
        return r

    # Fallback to html2text
    r = extract_html2text(html)
    if r and r["text"]:
        r["strategy"] = "html2text"
        return r

    # No content
    title_match = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE | re.DOTALL)
    return {"title": title_match.group(1).strip() if title_match else "", "text": "", "strategy": "empty"}


def _clean_html(html: str) -> str:
    """Clean HTML string: strip tags, normalize whitespace."""
    # Remove scripts and styles
    html = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.IGNORECASE | re.DOTALL)
    html = re.sub(r"<style[^>]*>.*?</style>", "", html, flags=re.IGNORECASE | re.DOTALL)

    # Remove HTML comments
    html = re.sub(r"<!--.*?-->", "", html, flags=re.DOTALL)

    # Replace block tags with newlines
    html = re.sub(r"</?(?:p|div|h[1-6]|li|blockquote|tr|br|hr|section|article|table)[^>]*>", "\n", html, flags=re.IGNORECASE)

    # Strip remaining tags
    html = re.sub(r"<[^>]+>", "", html)

    # Decode common entities
    html = (
        html.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
    )

    # Normalize whitespace
    html = re.sub(r"\n{3,}", "\n\n", html)
    html = re.sub(r" +\n", "\n", html)
    html = re.sub(r"\n +", "\n", html)

    return html.strip()