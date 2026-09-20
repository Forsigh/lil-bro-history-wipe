"""Turn the live probe's raw captures into the store's 1280x800 screenshots.

The probe writes four raw files. Three are already the store size. The popup is a
360x520 panel, so it is a composition rather than a capture: a narrow tall panel
cannot fill an 8:5 frame without shrinking into a padded box, so it is cropped to
its own content and centred on a canvas filled with its own background, darkened.

Writes, into the output directory:
  01-options-1280x800.png       the settings page, top
  02-list-and-log-1280x800.png  the settings page, scrolled to the list and the log
  03-locked-1280x800.png        the settings page with the PIN on
  04-popup-1280x800.png         the popup, composed

The store accepts 1280x800 or 640x400 and nothing else, in 24-bit PNG with no alpha,
so every file is converted to RGB and measured before it is written.

Run from the extension root:
  python tools/make_shot_sheets.py <raw-dir> <out-dir>
"""

import os
import sys

from PIL import Image, ImageDraw, ImageStat

CANVAS = (1280, 800)
PANEL_H = 620  # the popup panel's height on the canvas, in pixels
BACKDROP_FACTOR = 0.6  # the popup's own background, darkened, behind the panel
CORNER_RADIUS = 16

# raw name -> store name. The popup is the one that gets composed.
SHEETS = [
    ("options.png", "01-options-1280x800.png"),
    ("options-lower.png", "02-list-and-log-1280x800.png"),
    ("options-locked.png", "03-locked-1280x800.png"),
]
POPUP_RAW = "popup-compact.png"
POPUP_OUT = "04-popup-1280x800.png"


def content_box(im: Image.Image, bg, tolerance: int = 10):
    """The panel's bounds inside the capture, ignoring the empty viewport around it."""
    px = im.load()
    w, h = im.size

    def differs(c) -> bool:
        return abs(c[0] - bg[0]) + abs(c[1] - bg[1]) + abs(c[2] - bg[2]) > tolerance

    rows = [y for y in range(h) if any(differs(px[x, y]) for x in range(0, w, 8))]
    cols = [x for x in range(w) if any(differs(px[x, y]) for y in range(0, h, 8))]
    if not rows or not cols:
        raise SystemExit("popup capture is blank: no panel to compose")
    return cols[0], rows[0], cols[-1], rows[-1]


def compose_popup(raw_path: str) -> Image.Image:
    raw = Image.open(raw_path).convert("RGB")
    px = raw.load()
    bg = px[2, raw.size[1] - 3]  # the empty viewport below the panel

    x0, y0, x1, y1 = content_box(raw, bg)
    panel = raw.crop((x0, y0, x1 + 1, y1 + 1))
    scale = PANEL_H / panel.size[1]
    panel = panel.resize((max(1, int(panel.size[0] * scale)), PANEL_H), Image.LANCZOS)

    backdrop = tuple(max(0, int(c * BACKDROP_FACTOR)) for c in bg)
    canvas = Image.new("RGB", CANVAS, backdrop)

    mask = Image.new("L", panel.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, panel.size[0] - 1, panel.size[1] - 1], radius=CORNER_RADIUS, fill=255
    )
    pos = ((CANVAS[0] - panel.size[0]) // 2, (CANVAS[1] - panel.size[1]) // 2)
    canvas.paste(panel, pos, mask)
    print(
        "  popup panel %dx%d from %dx%d content, at %s, backdrop %s"
        % (panel.size[0], panel.size[1], x1 - x0 + 1, y1 - y0 + 1, pos, backdrop)
    )
    return canvas


def check(path: str) -> bool:
    im = Image.open(path)
    st = ImageStat.Stat(im.convert("RGB"))
    spread = min(st.stddev)
    ok = im.size == CANVAS and im.mode == "RGB" and spread >= 10
    note = "ok" if ok else "FAILED"
    if im.size != CANVAS:
        note = "FAILED: %dx%d" % im.size
    elif im.mode != "RGB":
        note = "FAILED: mode %s" % im.mode
    elif spread < 10:
        note = "FAILED: flat image, stddev %.1f" % spread
    print("  %-30s %dx%d %s  stddev %.1f  %s" % (os.path.basename(path), im.size[0], im.size[1], im.mode, spread, note))
    return ok


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    raw_dir, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    print("writing into %s" % out_dir)
    for raw_name, out_name in SHEETS:
        src = os.path.join(raw_dir, raw_name)
        if not os.path.exists(src):
            raise SystemExit("missing capture: %s" % src)
        Image.open(src).convert("RGB").save(os.path.join(out_dir, out_name), "PNG", optimize=True)

    popup_raw = os.path.join(raw_dir, POPUP_RAW)
    if not os.path.exists(popup_raw):
        raise SystemExit("missing capture: %s" % popup_raw)
    compose_popup(popup_raw).save(os.path.join(out_dir, POPUP_OUT), "PNG", optimize=True)

    print("checking every file against the store's size and format rules")
    bad = [name for _, name in SHEETS + [(POPUP_RAW, POPUP_OUT)] if not check(os.path.join(out_dir, name))]
    if bad:
        raise SystemExit("these files are not usable: %s" % ", ".join(bad))


if __name__ == "__main__":
    main()
