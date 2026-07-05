#!/usr/bin/env python
"""
Clerk Whisper — распознавание голосовых сообщений из TG через faster-whisper.
Модель хранится на E: (cache_dir=/e/whisper).
Использование: python whisper.py <file.ogg> [--model tiny|base|small]
"""

import sys
import os
import json
import argparse

# Кэш моделей — на E:
CACHE_DIR = "E:/whisper"

def transcribe(file_path: str, model_size: str = "tiny") -> dict:
    """Распознать аудиофайл, вернуть {text, language, segments}"""
    from faster_whisper import WhisperModel

    os.makedirs(CACHE_DIR, exist_ok=True)

    model = WhisperModel(
        model_size,
        device="cpu",
        compute_type="int8",
        download_root=CACHE_DIR,
    )

    segments, info = model.transcribe(
        file_path,
        beam_size=5,
        language="ru",
        vad_filter=True,
    )

    text_parts = []
    all_segments = []

    for seg in segments:
        text_parts.append(seg.text.strip())
        all_segments.append({
            "start": seg.start,
            "end": seg.end,
            "text": seg.text.strip(),
        })

    return {
        "text": " ".join(text_parts),
        "language": info.language,
        "duration": info.duration,
        "segments": all_segments,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Whisper transcription")
    parser.add_argument("file", help="Path to audio file (.ogg)")
    parser.add_argument("--model", default="tiny", choices=["tiny", "base", "small"],
                        help="Model size (default: tiny)")
    args = parser.parse_args()

    if not os.path.exists(args.file):
        print(json.dumps({"error": f"File not found: {args.file}"}))
        sys.exit(1)

    try:
        result = transcribe(args.file, args.model)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)