function dmgNum(x, y, text, color, fontSize) {
  const t = String(text);
  dmgNums.push({ x, y, text: t, color, life: 1.1, vy: -52, fontSize: fontSize || (isNaN(t) ? 12 : 15) });
}


function spawnBurst(x, y, color, n) {
  // On a device the adaptive tier flagged as struggling, hold far fewer live
  // particles — each one is a pooled sprite + a physics step, so a lower
  // ceiling directly cuts CPU/GPU load where it's needed most.
  const _cap = (typeof _qualityTier !== 'undefined' && _qualityTier > 0) ? 45 : 120;
  const _space = _cap - particles.length;
  if (_space <= 0) return;
  n = Math.min(n, _space);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 120;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, color, life: .7, size: 3 + Math.random() * 4 });
  }
}

// Tiny seeded PRNG so a jittery style (fissure/frost) keeps the SAME jagged
// shape for its whole life instead of reshuffling every frame — reshuffling
// reads as flicker/noise, not a cast. Not used for anything security-
// sensitive, just visual variety, so Math.random-derived seeding is fine.
function _aoeSeededRand(n) {
  let s = (Math.random() * 0xffffffff) >>> 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return out;
}

// How long each style's animation runs — long enough for its shape to read,
// short enough not to linger over the next swing. 'classic' (the default,
// no style passed) keeps the original 0.45s plain ring untouched, so every
// existing small hit-confirm flash (Пинок, Оковы тьмы, Кувырок's arrival,
// ...) is unaffected by any of this.
const _AOE_STYLE_LIFE = {
  classic: 0.45, shockwave: 0.55, pulse: 0.55, flash: 0.42, frost: 0.6,
  fissure: 0.65, bloodwave: 0.5,
};

// style/color/color2 are optional — omitting all three reproduces the exact
// previous behavior (plain blue ring, see _updateAoeRings in js/pixi-
// world.js). Colors are CSS hex strings ('#9c2a3a'), same convention as
// spawnProj's color — this is what travels over the wire for other players
// to see the same ring (shared/netcodec.js's aoe entry, sent via
// netSpawnAoe/js/network.js), and what _updateAoeRings converts to a PIXI
// numeric color at draw time the same way projectile rendering already does.
function spawnAOE(x, y, r, style, color, color2) {
  const st = style || 'classic';
  const life = _AOE_STYLE_LIFE[st] || 0.45;
  const ring = {
    x, y, r: r || 50, life, maxLife: life, style: st,
    color: color || '#44aaff', color2: color2 || color || '#44aaff',
  };
  if (st === 'fissure' || st === 'frost') ring.rand = _aoeSeededRand(48);
  aoeRings.push(ring);
}
