"""Regenerate Piratify's app icons from the mark.

The mark lives in index.html as #i-logo: a jolly roger flown from a note, drawn
in a 32-unit box, and repeated in icons/icon.svg at 16x. iOS and Android want
PNGs, and a PWA's home-screen icon is cached by the OS in a way no web code can
reach — so when the mark changes, these files have to be rebuilt and the app
*reinstalled* on the phone for the new one to show.

The desktop shell wants the same artwork in two more formats, and both are
written here rather than with a converter, because a converter would resample
the phone tile: Windows takes a multi-size .ico, and macOS takes an .icns drawn
on the Mac grid (see build_mac) — a Mac icon is not the phone tile at a larger
size.

Run from the project root:  python icons/make-icons.py
"""

import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- the mark, straight from the 32-unit geometry in index.html --------------
UNIT = 32.0
# Bounding box of the drawing, so the mark can be centred inside the tile
# however far it is scaled down.
MARK_BOX = (3.23, 2.2, 28.9, 29.56)

# ---- palette: black and white ------------------------------------------------
TILE = (255, 255, 255)
INK = (17, 17, 20)          # #111114, the same ink index.html paints
EDGE = (17, 17, 20, 28)

# Pixels per unit at 512, i.e. how much of the tile the mark fills. A launcher
# icon reads best with the mark inset from the edges; a maskable one is cropped
# to a circle, so it has to stay inside the safe zone — the mark's *diagonal* is
# what decides that, not its width or height.
FIT = 13.2          # mark 339 x 361 in a 512 tile
MASKABLE_FIT = 10.2  # mark 262 x 279, inside the 410px safe circle

BONES = ((11.9, 13.7, 21.1, 4.5), (11.9, 4.5, 21.1, 13.7))
BONE_WIDTH = 2.25
SKULL = (16.5, 9.1, 4.1)
JAW = (14.4, 11.2, 4.2, 2.6, 1.25)
EYES = ((15.0, 8.6, 1.05), (18.0, 8.6, 1.05))
FLAG = ((5.5, 2.2), (28.9, 2.2), (24.1, 9.1), (28.9, 16.0), (5.5, 16.0))
STEM = (5.5, 2.2, 2.6, 23.4, 1.3)
HEAD = (8.9, 24.9, 5.5, 4.3, -20.0)


def ellipse_points(cx, cy, rx, ry, angle, steps=180):
    """A rotated ellipse as a polygon.

    Drawn by hand rather than with ImageDraw.ellipse + Image.rotate: pasting a
    rotated layer back through a mask costs an extra full-size buffer per icon
    and rounds the edge twice.
    """
    a = math.radians(angle)
    ca, sa = math.cos(a), math.sin(a)
    points = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        x, y = rx * math.cos(t), ry * math.sin(t)
        points.append((cx + x * ca - y * sa, cy + x * sa + y * ca))
    return points


def mark_layer(size, fit):
    """The mark on a transparent `size` square, scaled to `fit` pixels per unit
    at 512 and centred on its own bounding box."""
    scale = fit * size / 512.0
    cx = (MARK_BOX[0] + MARK_BOX[2]) / 2
    cy = (MARK_BOX[1] + MARK_BOX[3]) / 2

    def p(x, y):
        return ((x - cx) * scale + size / 2, (y - cy) * scale + size / 2)

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    # flag, pole, note head — one ink shape
    draw.polygon([p(*pt) for pt in FLAG], fill=INK)
    x, y, w, h, r = STEM
    draw.rounded_rectangle(
        [p(x, y)[0], p(x, y)[1], p(x + w, y + h)[0], p(x + w, y + h)[1]],
        radius=r * scale, fill=INK,
    )
    hx, hy, hrx, hry, hrot = HEAD
    draw.polygon([p(*pt) for pt in ellipse_points(hx, hy, hrx, hry, hrot)], fill=INK)

    # skull and crossbones, knocked out in the tile's own white
    for (x0, y0, x1, y1) in BONES:
        draw.line([p(x0, y0), p(x1, y1)], fill=TILE + (255,), width=round(BONE_WIDTH * scale), joint="curve")
        # round caps, which ImageDraw.line does not draw for you
        for (bx, by) in ((x0, y0), (x1, y1)):
            r = BONE_WIDTH * scale / 2
            bx, by = p(bx, by)
            draw.ellipse([bx - r, by - r, bx + r, by + r], fill=TILE + (255,))
    sx, sy, sr = SKULL
    draw.ellipse(
        [p(sx - sr, sy - sr)[0], p(sx - sr, sy - sr)[1], p(sx + sr, sy + sr)[0], p(sx + sr, sy + sr)[1]],
        fill=TILE + (255,),
    )
    jx, jy, jw, jh, jr = JAW
    draw.rounded_rectangle(
        [p(jx, jy)[0], p(jx, jy)[1], p(jx + jw, jy + jh)[0], p(jx + jw, jy + jh)[1]],
        radius=jr * scale, fill=TILE + (255,),
    )

    # eye sockets, back to ink
    for (ex, ey, er) in EYES:
        draw.ellipse(
            [p(ex - er, ey - er)[0], p(ex - er, ey - er)[1], p(ex + er, ey + er)[0], p(ex + er, ey + er)[1]],
            fill=INK + (255,),
        )
    return layer


def build(size, maskable=False):
    """Tile + mark. `maskable` keeps the mark inside the safe zone (80%) and runs
    the tile edge to the border, because the launcher crops it."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    tile = Image.new("RGBA", (size, size), TILE + (255,))
    if maskable:
        canvas.paste(tile, (0, 0))
    else:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, size - 1, size - 1], radius=round(size * 140 / 512), fill=255
        )
        canvas.paste(tile, (0, 0), mask)

    canvas = Image.alpha_composite(canvas, mark_layer(size, MASKABLE_FIT if maskable else FIT))

    if not maskable:
        # Hairline edge, matching the in-app tile. Ink, not white: a white line
        # around a white tile is the one thing that vanishes on a light
        # home-screen wallpaper, and this tile has no colour to fall back on.
        edge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(edge).rounded_rectangle(
            [1, 1, size - 2, size - 2],
            radius=round(size * 140 / 512) - 1,
            outline=EDGE,
            width=max(2, round(size / 170)),
        )
        canvas = Image.alpha_composite(canvas, edge)

    return canvas


# ---- desktop ----------------------------------------------------------------
BUILD_DIR = os.path.join(HERE, os.pardir, "desktop", "build")

# AppKit lays an app icon out on a 1024 grid and keeps the artwork inside 824 of
# it, so that a Dock full of icons shares one optical size. A tile that fills its
# own canvas reads oversized beside every other app, so the Mac icon is the same
# tile inset on that grid — and the grid holds at every size, which is why each
# icns entry is drawn rather than resampled.
MAC_GRID = 824 / 1024
# The sizes macOS reads out of an .icns: 1024 for Quick Look, 512 and 256 for the
# Dock and Finder, 128 down to 32 for list views, Get Info and the menu bar.
MAC_SIZES = (32, 64, 128, 256, 512, 1024)


def build_mac(size):
    """The tile on the Mac grid, drawn at `size`."""
    inner = max(16, round(size * MAC_GRID))
    tile = build(inner)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(tile, ((size - inner) // 2, (size - inner) // 2), tile)
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

    os.makedirs(BUILD_DIR, exist_ok=True)

    # The window icon on Linux, and the source for anything that wants one PNG.
    build(1024).save(os.path.join(BUILD_DIR, "icon.png"))
    print("wrote desktop/build/icon.png", 1024)

    # Windows: one file carrying every size Explorer, the taskbar, Alt-Tab and
    # the shell's shortcut pick from.
    build(256).save(
        os.path.join(BUILD_DIR, "icon.ico"),
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("wrote desktop/build/icon.ico 7 sizes")

    # macOS: Pillow writes the ic08/ic09/ic10 chunks from the 1024 render and
    # takes the smaller entries from append_images, so every size is a real
    # drawing of the mark instead of a blur of the one above it.
    icons = {size: build_mac(size) for size in MAC_SIZES}
    icons[1024].save(
        os.path.join(BUILD_DIR, "icon.icns"),
        format="ICNS",
        append_images=[icons[size] for size in MAC_SIZES if size != 1024],
    )
    print("wrote desktop/build/icon.icns", "+".join(str(s) for s in MAC_SIZES))


if __name__ == "__main__":
    main()
