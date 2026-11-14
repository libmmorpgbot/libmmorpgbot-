#!/usr/bin/env python3
# ── Атласы героев из слоёв Flare ─────────────────────────────────────────────
#
#   python3 dev/hero-atlas.py /path/to/flare-game
#
# Герой Flare (flare-game, mods/fantasycore, CC-BY-SA 3.0) собирается из
# слоёв: голова, торс, руки, ноги, обувь, оружие, щит — у каждого свой лист и
# свой файл кадров (animations/avatar/<пол>/<слой>.txt), а порядок слоёв
# зависит от направления (engine/hero_layers.txt). Здесь для каждого класса
# Liberty слои складываются в готовые кадры заранее: стойка, бег, атака
# класса (удар/каст/выстрел), попадание и смерть — во всех 8 направлениях.
#
# На выходе:
#   images/pm/hero_<класс>.webp — атлас кадров, уменьшенный (SCALE);
#   js/hero-data.js             — координаты кадров в формате PM_SPR
#                                 (js/pm-data.js): f — [x,y,w,h,якорьX,якорьY]
#                                 на кадр, номер = кадрАнимации*8 + направление
#                                 (0=З,1=СЗ,2=С,3=СВ,4=В,5=ЮВ,6=Ю,7=ЮЗ),
#                                 an — [начало,кадров,мс,режим], bh — рост.
#
# Нужен только Pillow. Сам набор Flare в репозиторий не кладётся — только то,
# что из него собрано (с указанием авторов в images/pm/HEROES-CREDITS.txt).
import json, os, re, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FLARE = sys.argv[1] if len(sys.argv) > 1 else None
if not FLARE:
    sys.exit('usage: hero-atlas.py /path/to/flare-game')
MOD = os.path.join(FLARE, 'mods', 'fantasycore')

SCALE = 0.55          # атлас мельче исходника: тело ~75 px — столько и на экране
SHEET_W = 2048
DIRS = {'W': 0, 'NW': 1, 'N': 2, 'NE': 3, 'E': 4, 'SE': 5, 'S': 6, 'SW': 7}
MODE = {'back_forth': 'bf', 'looped': 'loop', 'play_once': 'once'}

# Снаряжение классов. tint — множитель цвета слоя (RGB, 255 — без изменений,
# больше — светлее), чтобы два класса в одной броне не были близнецами, а
# тёмная кожа не сливалась с землёй.
DK_TINT = (150, 130, 190)
AS_TINT = (300, 270, 340)
RG_TINT = (330, 390, 300)
CLASSES = {
    'lev': ('male', 'swing', {'head': 'plate_helm', 'chest': 'plate_cuirass', 'hands': 'plate_gauntlets',
            'legs': 'plate_greaves', 'feet': 'plate_boots', 'main': 'longsword', 'off': 'kite_shield'}, {}),
    'deathknight': ('male', 'swing', {'head': 'chain_coif', 'chest': 'chain_cuirass', 'hands': 'chain_gloves',
            'legs': 'chain_greaves', 'feet': 'chain_boots', 'main': 'greatsword'},
            {k: DK_TINT for k in ('head', 'chest', 'hands', 'legs', 'feet')}),
    'ranger': ('male', 'shoot', {'head': 'leather_hood', 'chest': 'leather_chest', 'hands': 'leather_gloves',
            'legs': 'leather_pants', 'feet': 'leather_boots', 'main': 'longbow'},
            {k: RG_TINT for k in ('head', 'chest', 'hands', 'legs', 'feet')}),
    'mage': ('male', 'cast', {'head': 'mage_hood', 'chest': 'mage_vest', 'hands': 'mage_sleeves',
            'legs': 'mage_skirt', 'feet': 'mage_boots', 'main': 'greatstaff'}, {}),
    'warlock': ('female', 'cast', {'head': 'mage_hood_alt1', 'chest': 'mage_vest_alt1', 'hands': 'mage_sleeves_alt1',
            'legs': 'mage_skirt_alt1', 'feet': 'mage_boots_alt1', 'main': 'staff'}, {}),
    'runefighter': ('male', 'swing', {'head': 'head_short', 'chest': 'leather_chest', 'hands': 'plate_gauntlets',
            'legs': 'chain_greaves', 'feet': 'plate_boots', 'main': 'war_hammer'}, {}),
    'assassin': ('female', 'swing', {'head': 'head_long', 'chest': 'leather_chest', 'hands': 'leather_gloves',
            'legs': 'leather_pants', 'feet': 'leather_boots', 'main': 'dagger'},
            {k: AS_TINT for k in ('chest', 'legs', 'hands', 'feet')}),
}
# Какие анимации берём и под каким именем они будут в игре.
ANIMS = [('stance', 'stance'), ('run', 'run'), (None, 'atk'), ('hit', 'hit'), ('die', 'die')]


def layer_order():
    order = {}
    with open(os.path.join(MOD, 'engine', 'hero_layers.txt')) as fh:
        for line in fh:
            line = line.strip()
            if line.startswith('layer='):
                parts = line[6:].split(',')
                order[DIRS[parts[0]]] = parts[1:]
    return order


def parse_anim(path):
    anims, cur, img = {}, None, None
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line.startswith('image='):
                img = line[6:]
            m = re.match(r'\[(\w+)\]', line)
            if m:
                cur = m.group(1)
                anims[cur] = {'frames': 0, 'dur': 0, 'type': '', 'f': {}}
                continue
            if cur is None:
                continue
            if line.startswith('frames='):
                anims[cur]['frames'] = int(line[7:])
            elif line.startswith('duration='):
                anims[cur]['dur'] = int(re.sub(r'\D', '', line[9:]))
            elif line.startswith('type='):
                anims[cur]['type'] = line[5:]
            elif line.startswith('frame='):
                v = [int(x) for x in line[6:].split(',')]
                anims[cur]['f'][(v[0], v[1])] = v[2:]
    return img, anims


_cache = {}


def layer(gender, name):
    key = (gender, name)
    if key not in _cache:
        img, anims = parse_anim(os.path.join(MOD, 'animations', 'avatar', gender, name + '.txt'))
        _cache[key] = (Image.open(os.path.join(MOD, img)).convert('RGBA'), anims)
    return _cache[key]


def tint(im, rgb):
    r, g, b, a = im.split()
    k = [c / 255 for c in rgb]
    return Image.merge('RGBA', (r.point(lambda v: min(255, int(v * k[0]))), g.point(lambda v: min(255, int(v * k[1]))),
                                b.point(lambda v: min(255, int(v * k[2]))), a))


CANVAS, ANCHOR = (220, 220), (110, 165)


def compose(gender, loadout, tints, anim, idx, d, order):
    canvas = Image.new('RGBA', CANVAS, (0, 0, 0, 0))
    for slot in order[d]:
        name = loadout.get(slot)
        if not name:
            continue
        im, anims = layer(gender, name)
        a = anims.get(anim)
        fr = a and a['f'].get((idx, d))
        if not fr:
            continue
        x, y, w, h, ox, oy = fr
        piece = im.crop((x, y, x + w, y + h))
        if slot in tints:
            piece = tint(piece, tints[slot])
        canvas.alpha_composite(piece, (ANCHOR[0] - ox, ANCHOR[1] - oy))
    return canvas


def body_height(gender, loadout, tints, order):
    body = {k: v for k, v in loadout.items() if k not in ('main', 'off')}
    im = compose(gender, body, tints, 'stance', 0, 6, order)
    bb = im.getbbox()
    return round((ANCHOR[1] - bb[1]) * SCALE)


def anim_meta(gender, loadout, anim):
    # Число кадров, длительность и режим — с торса: он есть у всех классов.
    _, anims = layer(gender, loadout['chest'])
    a = anims[anim]
    return a['frames'], a['dur'], MODE.get(a['type'], 'loop')


def build(cls, order):
    gender, atk, loadout, tints = CLASSES[cls]
    frames, an = [], {}
    for src, key in ANIMS:
        anim = src or atk
        n, dur, mode = anim_meta(gender, loadout, anim)
        an[key] = [len(frames) // 8, n, dur, mode]
        for i in range(n):
            for d in range(8):
                im = compose(gender, loadout, tints, anim, i, d, order)
                if SCALE != 1:
                    im = im.resize((round(CANVAS[0] * SCALE), round(CANVAS[1] * SCALE)), Image.LANCZOS)
                bb = im.getbbox() or (0, 0, 1, 1)
                frames.append((im.crop(bb), ANCHOR[0] * SCALE - bb[0], ANCHOR[1] * SCALE - bb[1]))
    # Полочная упаковка: по высоте, слева направо.
    idx = sorted(range(len(frames)), key=lambda k: -frames[k][0].height)
    pos, x, y, row_h = [None] * len(frames), 0, 0, 0
    for k in idx:
        w, h = frames[k][0].size
        if x + w > SHEET_W:
            x, y, row_h = 0, y + row_h + 1, 0
        pos[k] = (x, y)
        x += w + 1
        row_h = max(row_h, h)
    sheet = Image.new('RGBA', (SHEET_W, y + row_h), (0, 0, 0, 0))
    f = []
    for k, (im, ax, ay) in enumerate(frames):
        px, py = pos[k]
        sheet.paste(im, (px, py))
        f += [px, py, im.width, im.height, round(ax, 1), round(ay, 1)]
    # Рост тела — от якоря (ноги) до макушки в кадре «стойка, лицом к нам»,
    # без оружия и щита: посох над головой не должен делать мага мельче.
    bh = body_height(gender, loadout, tints, order)
    out = os.path.join(ROOT, 'images', 'pm', f'hero_{cls}.webp')
    sheet.save(out, 'WEBP', quality=82, method=4)
    print(f'{cls}: {len(frames)} кадров, {sheet.size}, {os.path.getsize(out) // 1024} КБ, bh={bh}')
    return {'f': f, 'an': an, 'bh': bh}


def main():
    order = layer_order()
    data = {cls: build(cls, order) for cls in CLASSES}
    js = ('// Сгенерировано dev/hero-atlas.py из слоёв героя Flare (flare-game,\n'
          '// CC-BY-SA 3.0 — авторы в images/pm/HEROES-CREDITS.txt). Формат — как\n'
          '// PM_SPR (js/pm-data.js); атласы — images/pm/hero_<класс>.webp.\n'
          '// Кадры: стойка, бег, атака класса, попадание, смерть × 8 направлений.\n')
    for cls, d in data.items():
        js += f'PM_SPR.hero_{cls} = {json.dumps(d, separators=(",", ":"))};\n'
    with open(os.path.join(ROOT, 'js', 'hero-data.js'), 'w') as fh:
        fh.write(js)


main()
