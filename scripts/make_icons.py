"""Draws the app icons (pastel gradient, white circle, check mark) as PNG files.

Run from the repo root:  python3 scripts/make_icons.py
Uses only the Python standard library.
"""
import math
import os
import struct
import zlib

TOP = (0xC9, 0xB8, 0xF0)      # lavender
BOTTOM = (0xF8, 0xCB, 0xB0)   # peach
WHITE = (255, 255, 255)
INK = (0x6A, 0x55, 0xC2)

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")


def seg_dist(px, py, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def mix(c1, c2, t):
    return [c1[i] + (c2[i] - c1[i]) * t for i in range(3)]


def render(size):
    s = float(size)
    r = 0.30 * s
    pts = [(0.36 * s, 0.52 * s), (0.46 * s, 0.62 * s), (0.66 * s, 0.41 * s)]
    half_stroke = 0.0375 * s
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            col = mix(TOP, BOTTOM, (px + py) / (2 * s))
            circle = min(1.0, max(0.0, 0.5 - (math.hypot(px - s / 2, py - s / 2) - r)))
            if circle > 0:
                col = mix(col, WHITE, circle)
                d = min(seg_dist(px, py, pts[0], pts[1]), seg_dist(px, py, pts[1], pts[2])) - half_stroke
                check = min(1.0, max(0.0, 0.5 - d))
                if check > 0:
                    col = mix(col, INK, check)
            row += bytes((round(col[0]), round(col[1]), round(col[2]), 255))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#C9B8F0"/><stop offset="1" stop-color="#F8CBB0"/>
  </linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <circle cx="256" cy="256" r="154" fill="#fff"/>
  <path d="M184 266 L236 318 L338 210" fill="none" stroke="#6A55C2" stroke-width="38"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>
"""

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, size in [("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180)]:
        write_png(os.path.join(OUT, name), size, render(size))
        print("wrote", name)
    with open(os.path.join(OUT, "icon.svg"), "w") as f:
        f.write(SVG)
    print("wrote icon.svg")
