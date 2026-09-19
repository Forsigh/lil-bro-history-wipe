"""Store artwork for Lil Bro: the promo tiles, drawn from the extension icon.

Writes, for each language:
  store/<lang>/promo-440x280.png     the small promo tile
  store/<lang>/marquee-1400x560.png  the marquee, only needed for featuring

The English set is also written to store/ itself, which is what the store reads as the
all-languages fallback.

The icons in icons/ are artwork, not output. This tool reads icon128.png and never writes
the icons, so replacing them is safe.

Run from the extension root:  python tools/make_icons.py
"""

import os

from PIL import Image, ImageDraw, ImageFont, ImageStat

ICON = "icons/icon128.png"
BG = (11, 18, 32)
TEXT = (232, 238, 252)
MUTED = (147, 163, 191)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_REG = "C:/Windows/Fonts/segoeui.ttf"

# title, subtitle, one plain line about what it does
COPY = {
    "en": ("Lil Bro", "History Wipe", "Wipes the sites and words you pick out of your history."),
    "pl": ("Lil Bro", "Czyszczenie historii", "Czyści z historii wybrane strony i słowa."),
}


def font(path: str, px: int) -> ImageFont.FreeTypeFont:
    for candidate in (path, FONT_BOLD, FONT_REG, "C:/Windows/Fonts/arialbd.ttf"):
        try:
            return ImageFont.truetype(candidate, px)
        except OSError:
            continue
    return ImageFont.load_default()


def icon_rgb() -> Image.Image:
    """The icon flattened onto the tile colour.

    The source is a palette PNG carrying a transparency chunk. Flattening it to RGB
    directly leaves Pillow warning about it, and keeping the alpha bleeds black into the
    rounded corners, so it goes onto the tile's own colour instead.
    """
    art = Image.open(ICON).convert("RGBA")
    flat = Image.new("RGB", art.size, BG)
    flat.paste(art, (0, 0), art)
    return flat


def accent() -> tuple:
    """The icon's own colour, so the tiles sit next to the artwork instead of fighting it."""
    mean = ImageStat.Stat(icon_rgb().resize((16, 16))).mean
    return tuple(int(c) for c in mean)


def fit(draw: ImageDraw.ImageDraw, text: str, path: str, px: int, limit: int):
    """Largest size at or below px whose text fits in limit pixels.

    The old tiles drew one long line at a fixed size and let it run off the canvas, so the
    number is measured here rather than guessed.
    """
    while px > 8:
        f = font(path, px)
        if draw.textlength(text, font=f) <= limit:
            return f, px
        px -= 1
    return font(path, 8), 8


def tile(width: int, height: int, lang: str):
    """The composed tile, and the text sizes that ended up in it."""
    title, sub, body = COPY[lang]
    img = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(img)

    icon_size = int(height * 0.42)
    left = int(width * 0.055)
    top = (height - icon_size) // 2

    icon = icon_rgb().resize((icon_size, icon_size), Image.LANCZOS)
    mask = Image.new("L", (icon_size, icon_size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, icon_size - 1, icon_size - 1], radius=int(icon_size * 0.22), fill=255
    )
    img.paste(icon, (left, top), mask)

    tx = left + icon_size + int(width * 0.045)
    column = width - tx - left
    title_f, t_px = fit(d, title, FONT_BOLD, int(height * 0.15), column)
    sub_f, s_px = fit(d, sub, FONT_REG, int(height * 0.10), column)
    d.text((tx, int(height * 0.26)), title, font=title_f, fill=TEXT)
    d.text((tx, int(height * 0.26) + int(t_px * 1.16)), sub, font=sub_f, fill=accent())

    body_f, b_px = fit(d, body, FONT_REG, int(height * 0.062), width - left * 2)
    d.text((left, int(height * 0.74)), body, font=body_f, fill=MUTED)
    return img, (t_px, s_px, b_px)


def main() -> None:
    for lang in ("en", "pl"):
        os.makedirs(os.path.join("store", lang), exist_ok=True)
        for width, height, name in (
            (440, 280, "promo-440x280.png"),
            (1400, 560, "marquee-1400x560.png"),
        ):
            img, sizes = tile(width, height, lang)
            out = os.path.join("store", lang, name)
            img.save(out, "PNG", optimize=True)
            print("wrote %s  (%dx%d, text %s px)" % (out, width, height, sizes))
            if lang == "en":
                root = os.path.join("store", name)
                img.save(root, "PNG", optimize=True)
                print("wrote %s  (the all-languages copy)" % root)

    # GitHub's social preview, same 2:1 shape the marquee uses. English only: the repo
    # is read in English, and the store is where the Polish tile lives.
    img, sizes = tile(1280, 640, "en")
    out = os.path.join("store", "social-preview-1280x640.png")
    img.save(out, "PNG", optimize=True)
    print("wrote %s  (1280x640, upload it under Settings, Social preview; text %s px)" % (out, sizes))


if __name__ == "__main__":
    main()
