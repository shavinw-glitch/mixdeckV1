"""Regenerate Wavefy's app icons from the mark.

The mark lives in index.html as #i-logo / #i-logo-light, four bars in a 32-unit
box. iOS and Android want PNGs, and a PWA's home-screen icon is cached by the OS
in a way no web code can reach — so when the mark changes, these files have to be
rebuilt and the app *reinstalled* on the phone for the new one to show.

Run from the project root:  python icons/make-icons.py
"""

import math
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- the mark, straight from the 32-unit geometry in index.html --------------
UNIT = 32
BARS = [  # x, y, w, h  (common baseline at y = 27)
    (3.9, 11, 4.4, 16),
    (10.5, 5, 4.4, 22),
    (17.1, 15, 4.4, 12),
    (23.7, 8, 4.4, 19),
]
RADIUS = 2.2

# ---- palette: black and white, matching the in-app mark ---------------------
# The logo is one colour now — ink on a white tile — so both stop lists are flat
# on purpose. Kept as stop lists so the gradient machinery still runs and a
# future change is one line.
TILE_STOPS = [(0.0, "#ffffff"), (1.0, "#ffffff")]
INK_STOPS = [(0.0, "#111114"), (1.0, "#111114")]


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def sample(stops, t):
    """Colour at t along a stop list, linearly interpolated between stops."""
    t = max(0.0, min(1.0, t))
    for i in range(len(stops) - 1):
        a, b = stops[i], stops[i + 1]
        if a[0] <= t <= b[0]:
            span = (b[0] - a[0]) or 1.0
            f = (t - a[0]) / span
            ca, cb = hex_rgb(a[1]), hex_rgb(b[1])
            return tuple(round(ca[k] + (cb[k] - ca[k]) * f) for k in range(3))
    return hex_rgb(stops[-1][1])


def diagonal_gradient(size, stops, angle=(1.0, 1.0)):
    """A linear gradient across the square, one pixel at a time.

    Deliberately not drawn with `Image.linear_gradient` + rotate: the rotated
    version leaves transparent corners, which then show up as a hard diagonal
    edge when the gradient is pasted through a rounded mask.
    """
    ax, ay = angle
    norm = math.hypot(ax, ay) or 1.0
    ax, ay = ax / norm, ay / norm
    # Project every pixel onto the axis and normalise to 0..1.
    xs = [x * ax for x in range(size)]
    ys = [y * ay for y in range(size)]
    lo = min(xs) + min(ys)
    hi = max(xs) + max(ys)
    small = min(size, 256)
    img = Image.new("RGB", (small, small))
    px = img.load()
    step = size / small
    for j in range(small):
        y = j * step
        for i in range(small):
            x = i * step
            t = ((x * ax + y * ay) - lo) / ((hi - lo) or 1.0)
            px[i, j] = sample(stops, t)
    return img.resize((size, size), Image.LANCZOS)


def bar_mask(size, scale=1.0):
    """White bars on black, drawn to the geometry above at `size`/32 units."""
    unit = size / UNIT * scale
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    off = (size - size * scale) / 2
    for (x, y, w, h) in BARS:
        x0 = off + x * unit
        y0 = off + y * unit
        draw.rounded_rectangle(
            [x0, y0, x0 + w * unit, y0 + h * unit],
            radius=RADIUS * unit,
            fill=255,
        )
    return mask


def squircle_mask(size, radius_ratio=140 / 512):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=round(size * radius_ratio), fill=255
    )
    return mask


def sheen(size):
    """A soft white highlight from the top-left, additive over the tile."""
    img = Image.new("L", (size, size), 0)
    px = img.load()
    cx, cy, r = size * 0.30, size * 0.04, size * 0.9
    for j in range(size):
        for i in range(size):
            d = math.hypot(i - cx, j - cy) / r
            px[i, j] = max(0, round(255 * 0.55 * (1 - min(1.0, d)) ** 1.6))
    return img.filter(ImageFilter.GaussianBlur(size * 0.02))


def build(size, maskable=False):
    """Tile + mark. `maskable` keeps the mark inside the safe zone (80%) and runs
    the tile edge to the border, because the launcher crops it."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    tile = diagonal_gradient(size, TILE_STOPS, angle=(0.1, 1.0))
    glow = sheen(size)
    tile = Image.composite(Image.new("RGB", (size, size), (255, 255, 255)), tile, glow.point(lambda v: v // 2))

    if maskable:
        canvas.paste(tile, (0, 0))
    else:
        canvas.paste(tile, (0, 0), squircle_mask(size))

    ink = diagonal_gradient(size, INK_STOPS, angle=(1.0, 1.0))
    bars = bar_mask(size, scale=0.80 if maskable else 1.0)
    canvas.paste(ink, (0, 0), bars)

    if not maskable:
        # Hairline edge, matching the in-app tile. Ink, not white: a white line
        # around a white tile is the one thing that vanishes on a light
        # home-screen wallpaper, and this tile has no colour left to sit on.
        edge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(edge).rounded_rectangle(
            [1, 1, size - 2, size - 2],
            radius=round(size * 140 / 512) - 1,
            outline=(17, 17, 20, 28),
            width=max(2, round(size / 170)),
        )
        canvas = Image.alpha_composite(canvas, edge)

    return canvas


def main():
    targets = [
        ("icon-512.png", 512, False),
        ("icon-192.png", 192, False),
        ("apple-touch-icon.png", 180, False),
        ("maskable-512.png", 512, True),
    ]
    for name, size, maskable in targets:
        path = os.path.join(HERE, name)
        build(size, maskable).save(path)
        print("wrote", name, size)


if __name__ == "__main__":
    main()
