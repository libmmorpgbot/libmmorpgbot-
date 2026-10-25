#!/usr/bin/env node
'use strict';
// ── Эмодзи в интерфейсе — только иконками ──────────────────────────────────
//
//   node dev/emoji-icons-check.js
//
// Владелец: «замени все эмодзи на svg иконки под стиль нашей игры». Заменяет
// их одно место — emojifyDom (js/icons.js) по таблице EMOJI_ICON, а холст —
// emojiSplit. Эмодзи, которого в таблице нет, так и останется эмодзи: на
// экране это выглядит как недоделка, а заметить её некому. Поэтому здесь:
//
//   1. каждая строка таблицы указывает на существующую иконку;
//   2. в файлах клиента нет эмодзи, которого нет в таблице;
//   3. обход DOM настоящим вызовом меняет эмодзи на иконку и оставляет
//      textContent прежним (иначе код, сравнивающий его перед перерисовкой,
//      перерисовывал бы каждый кадр);
//   4. на странице обновлений эмодзи в тексте нет — она отдельная, и обход
//      из игры туда не доходит.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const BUNDLE = require('../server/bundle-files');

let pass = 0, fail = 0;
const ok = (c, n, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + n); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + n + (got !== undefined ? ' — ' + got : '')); }
};

const src = fs.readFileSync(path.join(ROOT, 'js/icons.js'), 'utf8');
const lib = new Function('document', src + ';return { EMOJI_ICON, EMOJI_FLAG, ICON_SVG, emojiSplit, emojifyDom, _emojiKey };')(undefined);

console.log('\n  ── таблица ──');
const bad = Object.entries(lib.EMOJI_ICON).filter(([, v]) => !lib.ICON_SVG[v[0]]).map(([k, v]) => `${k}→${v[0]}`);
ok(bad.length === 0, 'каждый эмодзи таблицы указывает на существующую иконку', bad.join(' '));
const badCol = Object.entries(lib.EMOJI_ICON).filter(([, v]) => !/^#[0-9a-f]{6}$/i.test(v[1])).map(([k]) => k);
ok(badCol.length === 0, 'у каждой — свой цвет', badCol.join(' '));

console.log('\n  ── эмодзи в клиенте ──');
// Пиктограммы; типографские знаки (✓ ✕ → ★ ✦ ♥) эмодзи не считаются.
const EMO = /(?:[\u{1F1E6}-\u{1F1FF}]{2}|[\u{1F300}-\u{1FAFF}☀-⛿✀-➿⭐⭕⌚⌛⏩-⏺])️?/gu;
const TYPO = new Set([...'✓✕✦★♥✔✖✗✘☆']);
const files = [...BUNDLE.filter(f => !/pixi\.min|vendor/.test(f)), 'index.html'];
const unmapped = new Map();
for (const f of files) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
    // Комментарии — не интерфейс.
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of text.matchAll(EMO)) {
    const k = lib._emojiKey(m[0]);
    if (TYPO.has(k) || lib.EMOJI_ICON[k] || lib.EMOJI_FLAG[k]) continue;
    unmapped.set(k, (unmapped.get(k) || []).concat(f));
  }
}
ok(unmapped.size === 0, 'в клиенте нет эмодзи без иконки',
  [...unmapped].map(([k, fs2]) => `${k} (${[...new Set(fs2)].join(', ')})`).join('; '));

console.log('\n  ── обход DOM ──');
{
  // Самый маленький DOM, на котором работает обход: текстовые узлы, замена
  // узла фрагментом, innerHTML у временного span.
  class Node_ {
    constructor(type) { this.nodeType = type; this.childNodes = []; this.parentNode = null; }
    appendChild(n) {
      if (n.nodeType === 11) { [...n.childNodes].forEach(c => this.appendChild(c)); n.childNodes = []; return n; }
      n.parentNode = this; this.childNodes.push(n); return n;
    }
    replaceChild(nw, old) {
      const i = this.childNodes.indexOf(old);
      const add = nw.nodeType === 11 ? nw.childNodes : [nw];
      add.forEach(c => { c.parentNode = this; });
      this.childNodes.splice(i, 1, ...add);
    }
    get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(c => c.textContent).join(''); }
    get firstChild() { return this.childNodes[0]; }
    closest(sel) {
      for (let e = this; e && e.nodeType === 1; e = e.parentNode) if (sel.includes('.emo-ico') && /emo-ico/.test(e.className || '')) return e;
      return null;
    }
  }
  const text = (v) => Object.assign(new Node_(3), { nodeValue: v });
  const el = (name) => Object.assign(new Node_(1), { nodeName: name, namespaceURI: 'http://www.w3.org/1999/xhtml', className: '' });
  const doc = {
    createDocumentFragment: () => new Node_(11),
    createTextNode: text,
    createElement: () => {
      const span = el('SPAN');
      Object.defineProperty(span, 'innerHTML', {
        set(html) {
          const ico = el('SPAN'); ico.className = 'emo-ico'; ico.html = html;
          const hidden = /<span class="emo-t">([^<]*)<\/span>/.exec(html);
          if (hidden) ico.appendChild(text(hidden[1]));
          this.childNodes = [ico]; ico.parentNode = this;
        },
      });
      return span;
    },
    createTreeWalker: (root) => {
      const all = []; (function walk(n) { n.childNodes.forEach(c => { if (c.nodeType === 3) all.push(c); else walk(c); }); })(root);
      let i = 0; return { nextNode: () => all[i++] || null };
    },
  };
  const withDom = new Function('document', 'NodeFilter',
    src + ';return { emojifyDom };')(doc, { SHOW_TEXT: 4 });
  const div = el('DIV');
  div.appendChild(text('🏆 Достижение выполнено: ⚔️ бой'));
  const before = div.textContent;
  withDom.emojifyDom(div);
  const icons = div.childNodes.filter(n => n.nodeType === 1 && n.className === 'emo-ico');
  ok(icons.length === 2, 'два эмодзи — две иконки', icons.length);
  ok(icons.every(n => /<svg[^>]+stroke="#/.test(n.html)), 'иконка — SVG в цвете из таблицы');
  ok(div.textContent === before, 'textContent не изменился (эмодзи остаётся невидимым текстом)', JSON.stringify(div.textContent));
  const ta = el('TEXTAREA');
  ta.appendChild(text('🏆'));
  withDom.emojifyDom(ta);
  ok(ta.childNodes.length === 1 && ta.childNodes[0].nodeType === 3, 'поле ввода не трогается');
}

console.log('\n  ── холст ──');
{
  const a = lib.emojiSplit('🔒 Навык не изучен');
  ok(a.icon && a.icon[0] === 'lock' && a.text === 'Навык не изучен', '«🔒 Навык…» → иконка замка и текст без эмодзи', JSON.stringify(a));
  const b = lib.emojiSplit('+12💰');
  ok(b.icon && b.icon[0] === 'moneyBag' && b.text === '+12', '«+12💰» → иконка мешка и «+12»', JSON.stringify(b));
  const c = lib.emojiSplit('Без эмодзи');
  ok(c.icon === null && c.text === 'Без эмодзи', 'строка без эмодзи не меняется');
  const pt = fs.readFileSync(path.join(ROOT, 'js/particles.js'), 'utf8');
  ok(/emojiSplit\(text\)/.test(pt), 'dmgNum отделяет эмодзи от текста (js/particles.js)');
  const px = fs.readFileSync(path.join(ROOT, 'js/pixi-world.js'), 'utf8');
  ok(/d\.icon \? _dmgIconTex\(/.test(px), 'летящий текст рисует иконку спрайтом (js/pixi-world.js)');
}

console.log('\n  ── страница обновлений ──');
{
  const html = fs.readFileSync(path.join(ROOT, 'patches.html'), 'utf8')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<!--[\s\S]*?-->|<[^>]+>/g, ' ');
  const left = [...html.matchAll(EMO)].map(m => lib._emojiKey(m[0])).filter(k => !TYPO.has(k));
  ok(left.length === 0, 'в тексте patches.html нет эмодзи', [...new Set(left)].join(' '));
}

console.log('');
console.log(fail === 0
  ? `  \x1b[32m${pass} прошло, 0 упало\x1b[0m\n`
  : `  \x1b[31m${pass} прошло, ${fail} упало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
