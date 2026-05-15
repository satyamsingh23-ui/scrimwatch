"""
services/ocr_service.py
Lazy-loaded EasyOCR wrapper with per-word confidence scores.
Singleton — model loads once on first use (~10s), cached forever.
"""

from __future__ import annotations

import numpy as np
from dataclasses import dataclass
from typing import Optional

from utils.logger import get_logger

log = get_logger("ocr")

# Minimum confidence to keep a word (tunable)
DEFAULT_MIN_CONF = 0.30


@dataclass
class OCRWord:
    text:       str
    confidence: float
    bbox:       list    # [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]

    @property
    def x(self) -> int:
        return int(self.bbox[0][0])

    @property
    def y(self) -> int:
        return int(self.bbox[0][1])


@dataclass
class OCRResult:
    words:          list[OCRWord]
    full_text:      str
    avg_confidence: float

    def text_above(self, threshold: float) -> str:
        return " ".join(w.text for w in self.words if w.confidence >= threshold)


class OCRService:
    def __init__(self) -> None:
        self._reader = None

    def _reader_(self):
        if self._reader is None:
            log.info("Loading EasyOCR model (first run — ~10-20s on CPU)…")
            import easyocr
            self._reader = easyocr.Reader(["en"], gpu=False, verbose=False)
            log.info("EasyOCR ready.")
        return self._reader

    def read(self, image: np.ndarray, min_conf: float = DEFAULT_MIN_CONF) -> OCRResult:
        raw = self._reader_().readtext(image, detail=1, paragraph=False, batch_size=4)

        words = []
        for (bbox, text, conf) in raw:
            text = text.strip()
            if text and conf >= min_conf:
                words.append(OCRWord(text=text, confidence=conf, bbox=bbox))

        # Sort top→bottom, left→right
        words.sort(key=lambda w: (w.y // 20, w.x))

        full_text = " ".join(w.text for w in words)
        avg_conf  = sum(w.confidence for w in words) / len(words) if words else 0.0

        log.debug(f"OCR: {len(raw)} raw → {len(words)} kept, avg_conf={avg_conf:.2f}")
        return OCRResult(words=words, full_text=full_text, avg_confidence=avg_conf)


# Singleton
ocr_service = OCRService()