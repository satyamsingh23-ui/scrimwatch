"""
utils/image_preprocessing.py
OpenCV preprocessing pipeline for BGMI match screenshots.

Two screen types:
  A) Squad result — placement + player cards (finishes, assists, MVP)
  B) Detail stats — full table (damage, rating, survived dist, etc.)
"""

from __future__ import annotations

import hashlib
import io
from typing import NamedTuple

import cv2
import numpy as np

from utils.logger import get_logger

log = get_logger("img_prep")

TARGET_WIDTH = 1280


class PreparedImage(NamedTuple):
    full:          np.ndarray       # full preprocessed grayscale
    header_region: np.ndarray       # top 20% — placement + map
    stats_region:  np.ndarray       # bottom 50% — player names + numbers
    sha256:        str              # hash of original bytes for dedup
    original_size: tuple            # (w, h) before resize


def hash_image(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def preprocess(raw_bytes: bytes) -> PreparedImage:
    """Full preprocessing pipeline. Returns PreparedImage."""
    sha = hash_image(raw_bytes)

    # Decode
    arr = np.frombuffer(raw_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Cannot decode image bytes")

    orig_h, orig_w = img.shape[:2]

    # Resize to standard width
    scale = TARGET_WIDTH / orig_w
    img = cv2.resize(img, (TARGET_WIDTH, int(orig_h * scale)), interpolation=cv2.INTER_LANCZOS4)
    h, w = img.shape[:2]

    # Grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # CLAHE contrast enhancement (handles dark BGMI backgrounds well)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    # Denoise
    denoised = cv2.fastNlMeansDenoising(enhanced, h=7, templateWindowSize=7, searchWindowSize=21)

    # Mild sharpen
    kernel = np.array([[0, -0.5, 0], [-0.5, 3, -0.5], [0, -0.5, 0]])
    sharpened = cv2.filter2D(denoised, -1, kernel)

    # ── Header region (top 22%): placement + map name ─────────────────
    # Upscale 1.5× — small yellow "#16/22" text becomes larger for EasyOCR
    raw_header = sharpened[0:int(h * 0.22), :]
    header = cv2.resize(
        raw_header,
        (raw_header.shape[1] * 3 // 2, raw_header.shape[0] * 3 // 2),
        interpolation=cv2.INTER_LANCZOS4,
    )

    # ── Stats region (bottom 58%): player cards ────────────────────────
    # Adaptive binarize converts semi-transparent dark card backgrounds
    # into clean black-on-white, which EasyOCR reads far more accurately.
    # blockSize=31 handles uneven lighting across the four-card row.
    raw_stats = sharpened[int(h * 0.65):, :]
    stats_bin = cv2.adaptiveThreshold(
        raw_stats, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        blockSize=31, C=8,
    )
    # Morphological close reconnects broken letter strokes after binarize
    morph_k = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    stats = cv2.morphologyEx(stats_bin, cv2.MORPH_CLOSE, morph_k)

    log.debug(
        f"Preprocessed {orig_w}x{orig_h} → {w}x{h}, "
        f"header upscaled={header.shape[1]}x{header.shape[0]}, "
        f"stats binarized, hash={sha[:10]}…"
    )

    return PreparedImage(
        full=sharpened, header_region=header, stats_region=stats,
        sha256=sha, original_size=(orig_w, orig_h)
    )