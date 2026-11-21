#!/usr/bin/env python3
"""Листы помощников-дракончиков из виверн игры Flare (CC-BY-SA 3.0).

Источник: https://github.com/flareteam/flare-game, mods/fantasycore —
images/enemies/wyvern*/<v>_stance.png + animations/enemies/<v>.txt (атлас с
произвольной упаковкой кадров и точкой опоры у каждого). Модель и анимация —
Clint Bellanger, текстура — Justin Nichol (https://opengameart.org/content/wyvern-1).

Скрипт:
  * вырезает анимацию парения (stance, 8 кадров) во всех 8 направлениях;
  * убирает вшитую тень (полупрозрачные почти чёрные пиксели) — помощник
    летает у плеча, тень упала бы на самого игрока;
  * раскладывает в ровную сетку: строка = направление в порядке FACING8_DIRS
    (js/utils.js: right, frontright, front, frontleft, left, backleft, back,
    backright), столбец = кадр; все кадры на общей точке опоры;
  * перекрашивает под каждого помощника и пишет images/helpers/<id>.png.

Запуск: python3 dev/build-helper-sprites.py /путь/к/flare-game
"""
import colorsys
import os
import re
import sys

from PIL import Image

CELL = 128          # сторона клетки в листе
FRAMES = 8
# FACING8_DIRS index k -> направление Flare: 0 W, 1 SW, 2 S, 3 SE, 4 E, 5 NE, 6 N, 7 NW
FLARE_DIR = [(4 - k) % 8 for k in range(8)]

# helper id -> (вариант виверны, перекраска)
# перекраска: None | ('hue', сдвиг 0..1, множитель насыщенности) | ('tint', '#rrggbb', сила 0..1)
HELPERS = {
    'hl_sprout': ('wyvern',       ('hue', 0.0, 1.15)),
    'hl_pebble': ('wyvern_air',   ('hue', 0.0, 0.25)),
    'hl_bubble': ('wyvern_water', None),
    'hl_coin':   ('wyvern_air',   ('tint', '#f2c14a', 0.75)),
    'hl_storm':  ('wyvern_water', ('hue', 0.11, 1.2)),
    'hl_dragon': ('wyvern_fire',  ('hue', 0.0, 1.25)),
}


def parse(txt, anim):
    s = open(txt).read()
    sec = re.search(r'\[' + anim + r'\](.*?)(?:\n\[|\Z)', s, re.S).group(1)
    fr = {}
    for m in re.finditer(r'frame=(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(-?\d+),(-?\d+)', sec):
        i, d, x, y, w, h, ox, oy = map(int, m.groups())
        fr[(i, d)] = (x, y, w, h, ox, oy)
    return fr


def strip_shadow(im):
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a and a < 215 and max(r, g, b) < 34:
                px[x, y] = (0, 0, 0, 0)
    return im


def recolor(im, rc):
    if not rc:
        return im
    px = im.load()
    if rc[0] == 'tint':
        h = rc[1].lstrip('#')
        tr, tg, tb = (int(h[i:i + 2], 16) for i in (0, 2, 4))
        k = rc[2]
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if not a:
                continue
            if rc[0] == 'hue':
                hh, ll, ss = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
                hh = (hh + rc[1]) % 1.0
                ss = min(1.0, ss * rc[2])
                r2, g2, b2 = colorsys.hls_to_rgb(hh, ll, ss)
                px[x, y] = (round(r2 * 255), round(g2 * 255), round(b2 * 255), a)
            else:
                lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
                lum = min(1.0, lum * 1.35)
                px[x, y] = (
                    round(r * (1 - k) + tr * lum * k),
                    round(g * (1 - k) + tg * lum * k),
                    round(b * (1 - k) + tb * lum * k), a)
    return im


def build_variant(root, v):
    fr = parse(os.path.join(root, f'mods/fantasycore/animations/enemies/{v}.txt'), 'stance')
    atlas = Image.open(os.path.join(root, f'mods/fantasycore/images/enemies/{v}/{v}_stance.png')).convert('RGBA')
    frames = {}
    x0 = y0 = 10 ** 9
    x1 = y1 = -10 ** 9
    for k in range(8):
        for i in range(FRAMES):
            x, y, w, h, ox, oy = fr[(i, FLARE_DIR[k])]
            c = strip_shadow(atlas.crop((x, y, x + w, y + h)))
            bb = c.getbbox()
            if bb:
                x0, y0 = min(x0, bb[0] - ox), min(y0, bb[1] - oy)
                x1, y1 = max(x1, bb[2] - ox), max(y1, bb[3] - oy)
            frames[(k, i)] = (c, ox, oy)
    side = max(x1 - x0, y1 - y0)
    scale = (CELL - 4) / side
    # центр клетки = центр общей рамки всех кадров
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return frames, scale, cx, cy


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else '/home/user/flareteam/flare-game'
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'images', 'helpers')
    os.makedirs(out, exist_ok=True)
    cache = {}
    for hid, (v, rc) in HELPERS.items():
        if v not in cache:
            cache[v] = build_variant(root, v)
        frames, scale, cx, cy = cache[v]
        sheet = Image.new('RGBA', (CELL * FRAMES, CELL * 8), (0, 0, 0, 0))
        for (k, i), (c, ox, oy) in frames.items():
            big = Image.new('RGBA', (int(c.width * 1), int(c.height * 1)))
            big.paste(c)
            w2, h2 = max(1, round(c.width * scale)), max(1, round(c.height * scale))
            sm = big.resize((w2, h2), Image.LANCZOS)
            px = i * CELL + CELL / 2 + (-ox - cx) * scale
            py = k * CELL + CELL / 2 + (-oy - cy) * scale
            sheet.alpha_composite(sm, (round(px), round(py)))
        sheet = recolor(sheet, rc)
        path = os.path.join(out, f'{hid}.png')
        # Палитра 256 цветов с альфой: ~130 КБ вместо ~480 КБ, на глаз то же.
        sheet = sheet.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG)
        sheet.save(path, optimize=True)
        print(path, os.path.getsize(path) // 1024, 'KB')


if __name__ == '__main__':
    main()
