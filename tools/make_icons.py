"""Chrome Web Store assets for Lil Bro (grey history lines + teal erase sweep).

Generates:
  icons/icon{16,32,48,128}.png   extension icon. Artwork sits inside the 96/128 safe
                                 area with transparent padding, and nothing touches the
                                 canvas edge, which is what the store asks for.
  store/promo-440x280.png        required small promo tile
  store/marquee-1400x560.png     optional marquee tile, only needed for featuring

Run from the extension root:  python tools/make_icons.py
"""

from PIL import Image, ImageChops, ImageDraw, ImageFont

BG = (11, 18, 32, 255)
PLATE = (17, 26, 43, 255)
LINE = (150, 165, 190, 255)
LINE_DIM = (96, 110, 138, 255)
ACCENT = (45, 212, 191, 255)
TEXT = (232, 238, 252, 255)
MUTED = (147, 163, 191, 255)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_REG = "C:/Windows/Fonts/segoeui.ttf"


def glyph(size: int) -> Image.Image:
    """The mark on transparent canvas, plate inset so no edge reaches the border."""
    s = size * 4

    pad = int(s * 0.14)
    plate = Image.new("L", (s, s), 0)
    ImageDraw.Draw(plate).rounded_rectangle(
        [pad, pad, s - pad, s - pad], radius=int(s * 0.19), fill=255
    )
    base = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    base.paste(Image.new("RGBA", (s, s), PLATE), (0, 0), plate)

    inner = int(s * 0.20)
    bw = s - inner * 2
    bar_h = int(s * 0.075)
    gap = int(s * 0.10)
    y = int(s * 0.28)
    lines = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lines)
    for i, (frac, col) in enumerate(zip([1.0, 0.76, 0.88], [LINE, LINE, LINE_DIM])):
        top = y + i * gap
        ld.rounded_rectangle(
            [inner, top, inner + int(bw * frac), top + bar_h],
            radius=bar_h // 2,
            fill=col,
        )

    band_top = int(s * 0.53)
    band_bottom = int(s * 0.76)
    skew = int(s * 0.13)
    ld.polygon(
        [
            (inner - skew, band_bottom),
            (inner + bw - skew, band_bottom),
            (inner + bw, band_top),
            (inner, band_top),
        ],
        fill=ACCENT,
    )

    # clip the sweep and bars to the plate so nothing spills onto the padding
    lines.putalpha(ImageChops.multiply(lines.getchannel("A"), plate))
    base.alpha_composite(lines)
    return base


def font(path: str, px: int) -> ImageFont.FreeTypeFont:
    for candidate in (path, FONT_BOLD, FONT_REG, "C:/Windows/Fonts/arialbd.ttf"):
        try:
            return ImageFont.truetype(candidate, px)
        except OSError:
            continue
    return ImageFont.load_default()


def tile(width: int, height: int, title_px: int, body_px: int) -> Image.Image:
    img = Image.new("RGBA", (width, height), BG)
    d = ImageDraw.Draw(img)

    icon_size = int(height * 0.42)
    icon = glyph(icon_size).resize((icon_size, icon_size), Image.LANCZOS)
    left = int(width * 0.055)
    img.paste(icon, (left, (height - icon_size) // 2), icon)

    tx = left + icon_size + int(width * 0.045)
    d.text((tx, int(height * 0.30)), "Lil Bro", font=font(FONT_BOLD, title_px), fill=TEXT)
    d.text(
        (tx, int(height * 0.30) + int(title_px * 1.2)),
        "History Wipe",
        font=font(FONT_REG, title_px),
        fill=ACCENT,
    )
    d.text(
        (tx, int(height * 0.72)),
        "Keeps chosen sites and words out of your history",
        font=font(FONT_REG, body_px),
        fill=MUTED,
    )
    return img


def main() -> None:
    import os

    os.makedirs("icons", exist_ok=True)
    os.makedirs("store", exist_ok=True)

    src = glyph(512)
    for size in (16, 32, 48, 128):
        path = f"icons/icon{size}.png"
        src.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)
        print("wrote", path)

    tile(440, 280, 40, 17).save("store/promo-440x280.png", "PNG", optimize=True)
    print("wrote store/promo-440x280.png")
    tile(1400, 560, 96, 34).save("store/marquee-1400x560.png", "PNG", optimize=True)
    print("wrote store/marquee-1400x560.png")


if __name__ == "__main__":
    main()
