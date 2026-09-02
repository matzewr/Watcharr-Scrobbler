#!/usr/bin/env python3
"""Generates the extension icons as PNG with Pillow.

Design language (2026-09-02):
  * Netflix: dark background + Netflix red #E50914 (play triangle/"N")
  * Watcharr: the OFFICIAL Watcharr W from `watcharr_logo.png` (in the same
    folder as this script), inserted undistorted (yellow #F1DB84 + black
    outline, transparent background)

Usage:
    python3 tools/generate_icons/generate_icons.py                # variant B -> icons/icon-48/96/128.png
    python3 tools/generate_icons/generate_icons.py A              # write variant A (play below)
    python3 tools/generate_icons/generate_icons.py --preview B    # 128px preview to /tmp
"""
import os
import sys

from PIL import Image, ImageDraw

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))     # project folder
OUT = os.path.join(ROOT, "icons")
LOGO = os.path.join(SCRIPT_DIR, "watcharr_logo.png")
SIZES = [48, 96, 128]

# --- Brand colors -----------------------------------------------------------
RED = (229, 9, 20, 255)          # Netflix red  #E50914
RED_DARK = (140, 5, 13, 255)     # darker edge of the red "N"/play triangle
YELLOW = (241, 218, 131, 255)    # Watcharr yellow #F1DA83
YELLOW_DARK = (176, 147, 60, 255)  # shadow edge of the W
DARK_TOP = (27, 27, 31, 255)     # Netflix-dark gradient top
DARK_BOT = (6, 6, 8, 255)        #  … bottom
RING = (255, 255, 255, 26)       # subtle edge against dark taskbars

SUPERSAMPLE = 4  # for smooth edges/gradient: render 4x, then downscale

# --- Embed the official Watcharr logo (watcharr_logo.png) -------------------

_ASSET = None


def load_w_asset():
    """Loads the official Watcharr W (watcharr_logo.png), cached (RGBA)."""
    global _ASSET
    if _ASSET is None:
        _ASSET = Image.open(LOGO).convert("RGBA")
    return _ASSET


def paste_w(img, box):
    """Pastes the Watcharr W UN-DISTORTED (aspect ratio preserved) into the
    box (x0, y0, x1, y1) – centred, scaled to 'contain' in the box."""
    asset = load_w_asset()
    alpha = asset.getchannel("A")
    bb = alpha.getbbox()                       # cropped outline (no margin)
    if not bb:
        return
    pad = max(1, int(0.01 * max(bb[2] - bb[0], bb[3] - bb[1])))
    bb = (max(0, bb[0] - pad), max(0, bb[1] - pad),
          min(asset.width, bb[2] + pad), min(asset.height, bb[3] + pad))
    wmark = asset.crop(bb)

    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    scale = min(bw / wmark.width, bh / wmark.height)
    nw, nh = max(1, int(round(wmark.width * scale))), max(1, int(round(wmark.height * scale)))
    wmark = wmark.resize((nw, nh), Image.LANCZOS)
    px = int(round((x0 + x1) / 2 - nw / 2))
    py = int(round((y0 + y1) / 2 - nh / 2))
    img.alpha_composite(wmark, (px, py))


def draw_gradient_bg(img, d, size, radius):
    """Dark Netflix gradient as a rounded square + subtle edge."""
    # render the vertical gradient
    grad = Image.new("RGBA", (size, size), DARK_TOP)
    gp = grad.load()
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(int(DARK_TOP[i] + (DARK_BOT[i] - DARK_TOP[i]) * t) for i in range(3))
        for x in range(size):
            gp[x, y] = (c[0], c[1], c[2], 255)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1],
                                           radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius,
                        outline=RING, width=max(1, size // 128))


def draw_play(d, size, box, fill=RED, edge=None, offset=(0, 0)):
    """Netflix-red play triangle (N/play symbol) inside the box."""
    x0, y0, x1, y1 = box
    tri = [(x0, y0), (x0, y1), (x1, (y0 + y1) / 2.0)]
    if offset != (0, 0):
        d.polygon([(px + offset[0], py + offset[1]) for px, py in tri],
                  fill=edge if edge is not None else fill)
    d.polygon(tri, fill=fill)


def variant_a(size):
    """Watcharr W (original logo) on top + Netflix play below, centred."""
    s = float(size)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_gradient_bg(img, d, size, int(s * 0.24))

    # official Watcharr W (watcharr_logo.png), undistorted, in the upper area
    box_w = (int(s * 0.16), int(s * 0.10), int(s * 0.84), int(s * 0.66))
    paste_w(img, box_w)

    # Netflix-red play triangle, centred below it
    box_p = (int(s * 0.36), int(s * 0.76), int(s * 0.64), int(s * 0.97))
    draw_play(d, size, box_p, fill=RED, edge=RED_DARK,
              offset=(max(1, int(s * 0.015)), max(1, int(s * 0.015))))
    return img


def variant_b(size):
    """Official Watcharr W centred + Netflix play badge bottom right."""
    s = float(size)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_gradient_bg(img, d, size, int(s * 0.24))

    # official Watcharr W, centred & large
    box_w = (int(s * 0.04), int(s * 0.12), int(s * 0.96), int(s * 0.88))
    paste_w(img, box_w)

    # red badge circle bottom right with white play glyph
    c = (int(s * 0.72), int(s * 0.74))
    r = int(s * 0.19)
    d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=RED)
    d.ellipse([c[0] - r - int(s * 0.02), c[1] - r - int(s * 0.02),
               c[0] + r + int(s * 0.02), c[1] + r + int(s * 0.02)],
              outline=(0, 0, 0, 120), width=1)
    d.polygon([(c[0] - int(s * 0.05), c[1] - int(s * 0.07)),
               (c[0] - int(s * 0.05), c[1] + int(s * 0.07)),
               (c[0] + int(s * 0.09), c[1])], fill=(245, 245, 245, 255))
    return img


def render(builder, size):
    """Supersampled rendering: draw 4x larger, then downscale smoothly."""
    big = builder(size * SUPERSAMPLE)
    return big.resize((size, size), Image.LANCZOS)


def main():
    variant = "B"
    preview = False
    args = sys.argv[1:]
    if "--preview" in args:
        preview = True
        i = args.index("--preview")
        if i + 1 < len(args):
            variant = args[i + 1].upper()
    else:
        # optional positional variant argument, e.g. "python3 … A"
        if args and args[0].upper() in ("A", "B"):
            variant = args[0].upper()

    builder = {"A": variant_a, "B": variant_b}[variant]
    if preview:
        os.makedirs("/tmp/watcharr_icons", exist_ok=True)
        p = os.path.join("/tmp/watcharr_icons", f"preview-{variant}.png")
        render(builder, 128).save(p)
        print(f"Vorschau: {p}")
        return

    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT, f"icon-{size}.png")
        render(builder, size).save(path)
        print(f"geschrieben: {path}")


if __name__ == "__main__":
    main()
