"""Convert the stylesheet's font sizes from px to rem.

Why: the app has to look right on every phone, not on the one it was drawn on.
With every font size in rem, a single fluid root size drives the whole type
scale (see the `html { font-size: clamp(...) }` rule in index.html), so the UI
adapts automatically instead of being pinned to desktop pixels.

This is a one-shot codemod, kept in the repo so the transformation is
reproducible and reviewable rather than a mystery diff. It only touches
`font-size:` declarations inside the <style> block and is idempotent — running
it again on already-converted CSS changes nothing.

    python tools/fluid-type.py [--check]

--check exits non-zero if anything would change, without writing.
"""

import re
import sys
from pathlib import Path

INDEX = Path(__file__).resolve().parent.parent / "index.html"
BASE_PX = 16.0  # 1rem at the reference size


def px_to_rem(match):
    """16px -> 1rem, 13.5px -> 0.84375rem. Handles values inside clamp()/calc()."""
    return f"{round(float(match.group(1)) / BASE_PX, 5):g}rem"


def convert_value(value):
    return re.sub(r"([0-9]*\.?[0-9]+)px", px_to_rem, value)


def convert(css):
    # A declaration runs from `font-size:` to the next `;` or `}`.
    return re.sub(r"font-size:([^;}]+)", lambda m: "font-size:" + convert_value(m.group(1)), css)


def main():
    check = "--check" in sys.argv
    source = INDEX.read_text(encoding="utf-8")

    start = source.index("<style>")
    end = source.index("</style>", start)
    head, css, tail = source[:start], source[start:end], source[end:]

    updated = convert(css)
    if updated == css:
        print("style block already uses rem font sizes — nothing to do")
        return 0

    changed = sum(1 for a, b in zip(css.splitlines(), updated.splitlines()) if a != b)
    if check:
        print(f"{changed} font-size declaration(s) would change")
        return 1

    INDEX.write_text(head + updated + tail, encoding="utf-8")
    print(f"converted {changed} font-size declaration(s) to rem")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
