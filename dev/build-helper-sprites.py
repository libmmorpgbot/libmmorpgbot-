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

Бесы (hl_spark, hl_ember) — демон umask007 в листах для Flare (CC0):
https://opengameart.org/content/demon-flare-sprite-sheets, файл demon_0.png —
ровная сетка 256×256, 8 строк-направлений (тот же порядок, что у Flare),
42 столбца: idle 4, walk 9, attack1 5, attack2 5, cast 6, flinch 2, die 11.
Берём idle (0–3) туда-обратно, чтобы вышло 8 кадров.

Остальные помощники — монстры «Пограничья» из самой игры (images/pm/<вид>.webp,
кадры — js/pm-data.js; набор передан владельцем проекта, см. images/pm/README.txt).
Направления там по часовой: 0 З, 1 СЗ, 2 С (спиной), 3 СВ, 4 В, 5 ЮВ, 6 Ю (лицом),
7 ЮЗ; кадр атласа = кадрАнимации*8 + направление. Берём стойку (stance).

Запуск: python3 dev/build-helper-sprites.py /путь/к/flare-game /путь/к/demon_0.png
"""
import colorsys
import os
import re
import sys

from PIL import Image

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CELL = 128          # сторона клетки в листе
FRAMES = 8
# FACING8_DIRS index k -> направление Flare. Порядок у Flare (и у demon_0.png)
# тот же, что у «Пограничья» (pmDir, js/pm-monsters.js): по часовой от запада —
# 0 З, 1 СЗ, 2 С (спиной к нам), 3 СВ, 4 В, 5 ЮВ, 6 Ю (лицом к нам), 7 ЮЗ.
# (Сначала здесь стоял обратный порядок — перед/спина и диагонали были
# перепутаны, совпадали только «влево» и «вправо».)
FLARE_DIR = [(k + 4) % 8 for k in range(8)]

# helper id -> (вариант виверны, перекраска)
# перекраска: None | ('hue', сдвиг 0..1, множитель насыщенности) | ('tint', '#rrggbb', сила 0..1)
HELPERS = {
    'hl_sprout': ('wyvern',       ('hue', 0.0, 1.15)),
    'hl_pebble': ('wyvern_air',   ('hue', 0.0, 0.25)),
    'hl_bubble': ('wyvern_water', None),
    'hl_coin':   ('wyvern_air',   ('tint', '#f2c14a', 0.75)),
    'hl_storm':  ('wyvern_water', ('hue', 0.11, 1.2)),
    'hl_dragon': ('wyvern_fire',  ('hue', 0.0, 1.25)),
    'hl_spark':  ('demon',        None),
    'hl_ember':  ('demon',        ('hue', 0.07, 1.1)),
}
# Помощники из монстров «Пограничья»: ('pm:<вид>', перекраска)
HELPERS.update({
    'hl_firefly': ('pm:goblin',                  ('tint', '#ffe66b', 0.55)),
    'hl_breeze':  ('pm:hobgoblin_archer',        ('tint', '#bfe8ff', 0.55)),
    'hl_moth':    ('pm:skeleton_mage',           ('tint', '#c8bbff', 0.6, 1.3)),
    'hl_leaf':    ('pm:hobgoblin',               ('tint', '#7fe06a', 0.5)),
    'hl_frost':   ('pm:skeleton_archer',         ('tint', '#9fe4ff', 0.6)),
    'hl_crystal': ('pm:vesuvvio',                ('tint', '#ff6ab0', 0.45, 1.9)),
    'hl_phoenix': ('pm:fire_ant',                None),
    'hl_void':    ('pm:necromancer',             ('tint', '#b45cff', 0.6, 2.6)),
    'hl_wisp':    ('pm:skeleton_mage_high_boss', ('tint', '#6dffa4', 0.4)),
    'hl_seraph':  ('pm:skeleton_knight_boss',    ('tint', '#fff2a0', 0.65, 1.7)),
    'hl_kitsune': ('pm:antlion',                 ('tint', '#ff9ae6', 0.65, 1.8)),
})
# FACING8_DIRS index k -> направление атласа «Пограничья» (тот же порядок)
PM_DIR = FLARE_DIR
DEMON_CELL = 256
DEMON_IDLE = [0, 1, 2, 3, 3, 2, 1, 0]


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
        gain = rc[3] if len(rc) > 3 else 1.0   # осветление тёмных исходников
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
                lum = min(1.0, lum * 1.35 * gain)
                px[x, y] = (
                    min(255, round(r * gain * (1 - k) + tr * lum * k)),
                    min(255, round(g * gain * (1 - k) + tg * lum * k)),
                    min(255, round(b * gain * (1 - k) + tb * lum * k)), a)
    return im


def build_demon(path):
    atlas = Image.open(path).convert('RGBA')
    frames = {}
    for k in range(8):
        for i, col in enumerate(DEMON_IDLE):
            d = FLARE_DIR[k]
            c = strip_shadow(atlas.crop((col * DEMON_CELL, d * DEMON_CELL, (col + 1) * DEMON_CELL, (d + 1) * DEMON_CELL)))
            frames[(k, i)] = (c, 0, 0)
    return frames


_PM_SPR = None


def pm_spr():
    global _PM_SPR
    if _PM_SPR is None:
        import json
        js = open(os.path.join(REPO, 'js', 'pm-data.js')).read()
        i = js.index('const PM_SPR = ') + len('const PM_SPR = ')
        _PM_SPR, _ = json.JSONDecoder().raw_decode(js[i:])
    return _PM_SPR


def build_pm(kind):
    d = pm_spr()[kind]
    atlas = Image.open(os.path.join(REPO, 'images', 'pm', kind + '.webp')).convert('RGBA')
    start, n, _ms, mode = d['an']['stance']
    seq = list(range(n)) if mode == 'loop' else list(range(n)) + list(range(n - 1, -1, -1))
    seq = [seq[round(j * len(seq) / FRAMES) % len(seq)] for j in range(FRAMES)]
    f = d['f']
    frames = {}
    for k in range(8):
        for i, a in enumerate(seq):
            o = ((start + a) * 8 + PM_DIR[k]) * 6
            x, y, w, h, ax, ay = f[o:o + 6]
            c = strip_shadow(atlas.crop((int(x), int(y), int(x + w), int(y + h))))
            frames[(k, i)] = (c, round(ax), round(ay))
    return frames


def build_variant(root, v, demon_path=None):
    if v == 'demon':
        frames = build_demon(demon_path)
    elif v.startswith('pm:'):
        frames = build_pm(v[3:])
    else:
        frames = None
    if frames is not None:
        x0 = y0 = 10 ** 9
        x1 = y1 = -10 ** 9
        for c, ox, oy in frames.values():
            bb = c.getbbox()
            if bb:
                x0, y0 = min(x0, bb[0] - ox), min(y0, bb[1] - oy)
                x1, y1 = max(x1, bb[2] - ox), max(y1, bb[3] - oy)
        side = max(x1 - x0, y1 - y0)
        # Клиент рисует клетку чуть крупнее (D=142 на сетке 128, js/helpers.js);
        # у демона крылья раскрыты на всю ширину рамки — запас, чтобы не резало.
        sc = (CELL - 4) / side * 0.88
        if v.startswith('pm:'):
            sc = min(sc, 1.5)   # атласы уже уменьшены — сильнее растянешь, будет мыло
        return frames, sc, (x0 + x1) / 2, (y0 + y1) / 2
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
    demon_path = sys.argv[2] if len(sys.argv) > 2 else None
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'images', 'helpers')
    os.makedirs(out, exist_ok=True)
    cache = {}
    for hid, (v, rc) in HELPERS.items():
        if v == 'demon' and not demon_path:
            print('skip', hid, '(нет пути к demon_0.png)')
            continue
        if v not in cache:
            cache[v] = build_variant(root, v, demon_path)
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
