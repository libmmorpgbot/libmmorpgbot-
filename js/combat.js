function tileAt(wx, wy) {
  const tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
  if (tx < 0 || ty < 0 || tx >= dungeon.w || ty >= dungeon.h) return WALL;
  return dungeon.grid[ty][tx];
}
function isWall(wx, wy) { return tileAt(wx, wy) === WALL; }

function canMoveX(ent, dx, r) {
  const nx = ent.x + dx;
  if (!dungeon || nx - r < 0 || nx + r > dungeon.w * TILE) return false;
  const hr = r * 0.82;
  return !isWall(nx + (dx > 0 ? r : -r), ent.y - hr) &&
         !isWall(nx + (dx > 0 ? r : -r), ent.y + hr);
}
function canMoveY(ent, dy, r) {
  const ny = ent.y + dy;
  if (!dungeon || ny - r < 0 || ny + r > dungeon.h * TILE) return false;
  const hr = r * 0.82;
  return !isWall(ent.x - hr, ny + (dy > 0 ? r : -r)) &&
         !isWall(ent.x + hr, ny + (dy > 0 ? r : -r));
}

function hasLOS(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return true;
  const steps = Math.ceil(len / (TILE * 0.45));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWall(x1 + dx * t, y1 + dy * t)) return false;
  }
  return true;
}

function faceTowards(tx, ty) {
  const dx = tx - player.x, dy = ty - player.y;
  player.facing = facing8FromDelta(dx, dy, player.facing);
}

// Inverse of facing8FromDelta — a unit vector for the character's current
// facing. Used to aim a dash/jump at the direction the player is actually
// looking when there's no joystick input and no nearby target to aim at
// instead (those skills used to fall back to a fixed direction, or to a
// zero vector that meant standing still and pressing the button did nothing).
function _facingVec() {
  const idx = Math.max(0, FACING8_DIRS.indexOf(player.facing));
  const angle = idx * 45 * Math.PI / 180;
  return { dx: Math.cos(angle), dy: Math.sin(angle) };
}

function fireProj(tx, ty, enemyId, pvpTargetId) {
  const d = player.charDef, len = Math.hypot(tx - player.x, ty - player.y);
  if (len < 1) return;
  const vx = (tx - player.x) / len * 360;
  const vy = (ty - player.y) / len * 360;
  const ang = Math.atan2(vy, vx);
  const isArcher = player.type === 'ranger';
  const proj = { x: player.x, y: player.y, vx, vy,
    color: d.projColor, dmg: player.atk, life: 1.8, size: isArcher ? 5 : 7,
    isPlayer: true, projType: isArcher ? 'arrow' : 'ball', angle: ang,
    enemyId: enemyId || null, pvpTargetId: pvpTargetId || null };
  projs.push(proj);
  netSpawnProj({ x: proj.x, y: proj.y, vx, vy, color: d.projColor,
    size: proj.size, projType: proj.projType, angle: ang, life: 1.8 });
}

function pickup(drop) {
  if (drop.type === 'gold') {
    // Currently unreachable: nothing pushes into `drops` any more, because
    // kill gold comes straight down the server's enemyKilled event instead of
    // being dropped on the floor to walk over. This branch is what USED to
    // apply the ×2 gold potion, and it going dead is exactly why that potion
    // stopped working — so it now defers to gainGold like every other reward
    // path, and can't drift out of sync again if ground gold ever returns.
    const amount = gainGold(drop.amount);
    dmgNum(drop.x, drop.y - 12, '+' + amount + '💰', '#e6ac19');
    return;
  }
  const it = drop.item;
  if (it.slot === 'use') {
    if (it.hp) { player.hp = Math.min(player.maxHp, player.hp + it.hp); dmgNum(player.x, player.y - 26, '+' + it.hp + '♥', '#98e456'); }
    return;
  }
  if (addToInventory(it)) {
    dmgNum(drop.x, drop.y - 12, it.name, RARITY_COLOR[it.rarity] || '#c4a276');
    netSaveProgress();
  }
}

// The mob-kill loot roll itself now lives server-side (_rollMobLoot,
// server/index.js) — it used to be entirely computed here (recipe/equipment/
// key/stone/book drops), reaching the server only via the next saveProgress
// blob, which is exactly the "items appearing out of nowhere" hole that
// closed. js/network.js's enemyKilled handler now just displays whatever the
// server's already-granted 'items' array says landed. The formulas this used
// to run are preserved server-side for anyone diffing behaviour; the drop
// preview in js/ui.js's _monsterDropBodyHtml (bestiary) still re-derives the
// same odds independently for display and is unaffected by this.
