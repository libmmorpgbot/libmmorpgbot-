// W and H start at the window's own size, NOT undefined.
//
// They used to be declared bare, and every camera assignment in the client is
// `player.x - W / (2 * ZOOM)` — undefined arithmetic, so NaN. Anything that set
// the camera before the first resize() (which needs #app to have a layout size,
// and on a phone in Telegram's WebView that can be later than the first
// gameStart) produced camera NaN,NaN with a perfectly good player position.
//
// From there it never healed: updateCamera decays the camera→target OFFSET,
// and `NaN - tx` is NaN, `Math.abs(NaN) < px` is false, so the NaN carried
// itself frame after frame. The tile pass derives its chunk range from the
// camera, Math.floor(NaN) is NaN, and `for (cx = NaN; cx <= NaN; ...)` never
// iterates — zero chunks, black world, on a live renderer with a live socket.
// That is the report from 27 Aug: "камера NaN,NaN · игрок 1770,1588 · чанки 0/0".
//
// innerWidth/innerHeight are the wrong numbers by a few pixels — #app is not
// the whole window — but they are FINITE, which is the only property that
// matters here. The first resize() corrects them a frame later.
let canvas, ctx, DPR = 1;
let W = (typeof window !== 'undefined' && window.innerWidth) || 360;
let H = (typeof window !== 'undefined' && window.innerHeight) || 640;
let state = 'select';
let player = null, dungeon = null;
let projs = [], otherProjs = [], drops = [], particles = [], dmgNums = [], aoeRings = [];
// Event-boss ground loot, shared by everyone: id -> {id, x, y, item}. The
// server owns it (see pickupWorldDrop in server/index.js) — this map only
// mirrors what's currently on the floor so it can be drawn and walked over.
let worldDrops = new Map();
// Pickup requests already sent and not yet answered, so walking over a pile
// doesn't spam one emit per frame while the round trip is in flight.
let _worldDropPending = new Map();
// Set when the server refuses a pickup because the backpack is full, cleared
// the moment the inventory changes or the floor does. The per-drop 2s dedupe
// above is the right shape for a CONTESTED pile — the answer to "who got it"
// arrives and settles the question. It is the wrong shape for a full bag,
// because retrying cannot change the answer: 185 refusals in a week from two
// players, each one a transaction on the server and a toast on the screen,
// every two seconds, for as long as they stood on the loot.
let _worldDropBagFull = false;
let camera = { x: 0, y: 0 };
let dungeonLvl = 1;
let frameCount = 0;
let activeTab = 0;
// Нажатые клавиши, по e.code — по ФИЗИЧЕСКОЙ клавише, а не по букве, которую
// она печатает. Раньше здесь лежал e.key, и с кириллической раскладкой WASD
// не работал вовсе: W печатает «ц», A — «ф», и ни одна проверка на 'a'/'d' не
// срабатывала. Клавиша под пальцем от раскладки не зависит — и код, который
// её называет, тоже не должен.
let keys = {};
let joy = { active: false, id: null, sx: 0, sy: 0, dx: 0, dy: 0 };
let swingAngle = 0, swingTimer = 0;
let transTimer = 0;

// Multiplayer state
let socket = null;
let otherPlayers = new Map();   // socketId → { x, y, type, facing, hp, maxHp, username }
// socketId → equipped pet id, kept OUTSIDE otherPlayers on purpose: that map
// is rebuilt from scratch on gameStart, which would drop pet ids the server
// only sends on join and on change. Fed by the 'playerPets'/'playerPet'
// events (js/network.js).
let otherPets = new Map();
let serverEnemies = [];     // authoritative enemy list (server-driven, near the player only)
// Flat Int16 [tileX, tileY, ...] of every alive non-boss enemy in the world,
// for the КАРТА panel — which draws a whole arm, well past the radius
// serverEnemies now covers. Pushed at 1Hz and only while that panel is open
// (see 'mapView'/'mapBlips', js/network.js). null = nothing received yet.
let _mapBlips = null;
let serverEnemiesMap = new Map(); // id → enemy for O(1) lookup
let netUsername = null;

// NPCs in current floor
let npcs = [];
let nearNpc = null;

// Skill state
let skillFlash = null; // { key, timer }
let barrierTimer = 0;
let battleCryTimer = 0;
let dodgeTimer = 0;
let atkSpeedTimer = 0;
let faithShieldTimer = 0;
let invisTimer = 0;
let guardTimer = 0;      // Танк (lev) E — +80% DEF buff
let vampirismTimer = 0;  // Рыцарь Смерти (deathknight) Q — % lifesteal buff
// VAMPIRISM_PCT и ADV_VAMPIRISM_PCT переехали в shared/definitions.js: возврат
// здоровья считается от НАНЕСЁННОГО урона, а урон применяет сервер, и держать
// проценты там, куда сервер не смотрит, — это ровно то, из-за чего лечение
// откатывалось. Файл идёт в бандле раньше этого, так что имена здесь видны.

// ── Advanced skills ("вторая профессия") ────────────────────────────────
// Extra buff timers not covered by the base-skill ones above — several
// advanced skills reuse the same slot as their base but at a different
// magnitude/mechanic (bigger %, longer/shorter duration, or an outright new
// effect), so they can't just share the existing timer. See recompute() and
// useSkill() (js/player.js) for how each is actually applied.
let advDkQAtkTimer = 0;      // DK Q adv "Истощение" — +20% atk, 10s (alongside vampirismTimer's own bigger heal %)
let critDmgBuffTimer = 0;    // DK W adv "Жадность" — +5% crit power, 20 min
let madnessTimer = 0;        // DK E adv "Безумие" — +25% atk + basic attacks splash AOE, 5s
let critChanceBuffTimer = 0; // Ranger E adv "Баф Крит" — +5% crit chance, 20 min
let levShieldAtkTimer = 0;   // Lev E adv "Щит" — +10% atk, 10s (alongside guardTimer's own unchanged def)
let butterfliesTimer = 0;    // Warlock Q adv "Бабочки" — periodic self-heal, 10s
let _butterfliesTickAcc = 0; // 1s tick accumulator for the above

// Target & PK mode
let targetId = null;
let targetIsPlayer = false;
let pvpMode = false;
// True only when the attack button was actually pressed on the current
// target — tapping/cycling a target to look at it must not by itself make
// the character run at it.
let _chaseArmed = false;

// Per-corridor boss status, keyed by arm name: { left: {alive,respawnAt}, ... }
let bossStatus = {};

// Party — array of { id, name } for all OTHER members
let partyMembers = [];

// Incoming invite popup { fromId, fromName, timer }
let partyInvitePending = null;

// Attack mode — manual by default; player switches to auto explicitly
let autoAttackMode = false;

// Clan state (null = not in a clan)
let clanData = null;
// Хранилище клана — pushed by the server on every change (see 'clanStorage',
// js/network.js). null = not fetched yet, or not in a clan. Everything in it
// is server-owned; nothing here is computed locally.
let _clanStorage = null;

// Death Battle (Битва на смерть) — scheduled free-for-all, see the handlers
// in js/network.js and the panel in js/ui.js.
let _dbState = { phase: 'idle', startAt: 0, nextAt: 0, count: 0 };
let _dbRegistered = false;
let _dbInFight = false;
// 3v3 arena. _a3Team is 'A' or 'B' while in a match, and _a3Mates holds the
// socket ids of everyone in it by side, so nameplates can colour allies and
// opponents differently — the server already refuses friendly fire, this is
// just so players can tell who is who.
// attemptsLeft is only refreshed by an explicit sync (opening the panel, a
// registration, a match ending) — the frequent queue-count pushes leave it
// alone, so it starts as null meaning "not known yet" rather than 0.
let _a3State = { phase: 'idle', nextAt: 0, queued: 0, needed: 6, live: false, minLevel: 15, reward: 10, attemptsLeft: null, maxAttempts: 3 };
let _a3Registered = false;
let _a3InMatch = false;
let _a3Team = null;
let _a3Mates = { A: [], B: [] };
let _a3Score = { a: 3, b: 3 };
// Wall-clock time the current round ends, or 0 outside a live fight — drives
// the on-screen match countdown (see showArena3Timer, js/ui.js).
let _a3RoundEndAt = 0;
// While set and still in the future, this client is standing in the arena
// waiting out the pre-fight countdown: movement and attacks are blocked here
// as well as on the server (see _dbFrozen).
let _dbFightAt = 0;

// 10-player corridor race (Забег) — queue-driven like the 3v3 arena, but a
// free-for-all against one shared boss instead of a team match: everyone who
// makes it to the boss room fights the SAME boss, and whoever dealt it the
// most cumulative damage wins. myDamage is this client's own running total,
// pushed by the server (see js/network.js's race10Score handler) so the HUD
// can show it live.
let _race10State = { phase: 'idle', nextAt: 0, startAt: 0, queued: 0, needed: 10, live: false, minLevel: 10, reward: 10, winReward: 30, attemptsLeft: null, maxAttempts: 3 };
let _race10Registered = false;
let _race10InMatch = false;
let _race10Lane = null;
let _race10MyDamage = 0;

// Война гильдий (Guild War) — daily 22:00-22:15 MSK sealed zone with one
// stationary tower; whichever clan lands the killing blow owns it until
// another clan re-fights it down to 0 (see server/game/Room.js's capture
// logic). Combat access follows phase (open/closed); ownership/income don't.
// Pushed by js/network.js's guildWarState handler and by gameStart.
//
// No towerHp field here, though the server sends one: the tower is an
// ordinary enemy in the world snapshot, so updateGuildWarHpBar (js/ui.js)
// reads its hp/maxHp straight off serverEnemies.find(e => e.eid ===
// 'guildwar_castle') — live, every tick. A towerHp: 300000 default used to
// sit in this initializer with nothing reading it, and the only thing it
// could do was invite someone to point the bar at a number that moves only
// when a whole guildWarState packet happens to arrive.
let _gwState = { phase: 'closed', nextAt: 0, ownerClanId: null, ownerClanName: null, ownerClanIcon: null, capturedAt: 0 };

// Страх (Fear) — on-demand, solo wave-survival instance: no registration
// queue and no scheduled window, unlike the arena/race above — entering IS
// starting (see js/network.js's netFearEnter/fearStarted). wave/maxWave
// track progress through the current run, pushed by fearWave/fearStarted.
let _fearState = { attemptsLeft: null, maxAttempts: 2, maxWave: 39, minLevel: 10 };
// Wall-clock time the SERVER last placed this player explicitly — every
// instanced deploy and every return home goes through _teleportTo (js/game.js),
// which stamps this. Read by _applyGameStart (js/network.js) to tell a
// gameStart that is still describing where the player WAS from one that is
// current.
//
// It exists because gameStart is not always applied when it arrives: on the
// first visit to a floor its handler defers behind the world-map HTTP fetch.
// The Bloody Tower made that visible — the join that builds gameStart happens
// before raceDeploy assigns a lane, so gameStart said "boss room" (that floor's
// default spawn), race10Started said "your corridor" moments later, and the
// deferred gameStart landed last and put every entrant on the boss.
let _serverPlacedAt = 0;

let _fearInRun = false;
let _fearWave = 0;

// Сотрудничество (Coop) — 2-player-only instance entered through a
// leader-run group rather than solo/random matchmaking (see js/network.js's
// netCoopGroup*/coopStarted). stageNo/maxStage track progress through the
// current run, pushed by coopStage/coopStarted. _coopGroup mirrors the
// server's coopGroupState: null while idle, otherwise
// { isLeader, leaderId, leaderName, memberId, memberName }. _coopOpenGroups
// is the joinable lobby list (coopGroupList) — groups still missing a
// member, from every player, not just this one.
let _coopState = { attemptsLeft: null, maxAttempts: 2, maxStage: 8, minLevel: 10 };
let _coopInRun = false;
let _coopStageNo = 0;
let _coopGroup = null;
let _coopOpenGroups = [];

// Элитная фарм-зона — a FARM2_PARTY_SIZE-only instance entered through a
// leader-run group, same shape as Coop's above (see js/network.js's
// netFarm2Group*/farm2Started). No stages — this is a free-roam farm zone,
// not a wave/boss run — so there is only inRun and the daily minutes cap.
// _farm2Group mirrors the server's farm2GroupState: null while idle,
// otherwise { isLeader, leaderId, leaderName, members, maxMembers }.
// _farm2OpenGroups is the joinable lobby list (farm2GroupList) — groups
// still short a member, from every player, not just this one.
let _farm2State = { entryLevel: 30, partySize: 3, dailyMinutes: 120, minutesLeft: null };
let _farm2InRun = false;
let _farm2Group = null;
let _farm2OpenGroups = [];

// Сезон 2 — points race with a fixed end date. Everything here is pushed by
// the server (points are server-owned, see the seasonSync handler in
// server/index.js); nothing is computed locally. The point VALUES below are
// just a reasonable default for the first paint before seasonState arrives —
// the server's own numbers (shared/definitions.js) always win.
//
// Two fields the server also sends are deliberately not mirrored here. The
// rating threshold is read as _seasonRating.minPoints by _seasonRatingHTML
// (js/ui.js) — a different payload that arrives on its own — so the
// minRatingPoints: 5000 that used to sit below was a second number nobody
// ever consulted. The enhanceable special slots are
// SEASON_ENHANCE_SPECIAL_SLOTS (shared/definitions.js), in this bundle's
// scope and the same set seasonEnhancePoints() prices from server-side, so
// the enhanceSpecialSlots: ['pet', 'cloak', 'artifact'] literal that used
// to sit below was a hand-copy that would not have followed the real one
// when it changed.
let _seasonState = { endAt: 0, active: false, points: 0, prizes: [], vipPrize: null,
                     enhanceSpecial: { common: { norm: 20, bless: 5 }, uncommon: { norm: 40, bless: 15 }, rare: { norm: 100, bless: 40 } },
                     enhanceGear: { rare: 20, epic: 100 },
                     advBookPoints: 300,
                     burn: { common: 1, uncommon: 5 }, bookBurnPoints: 60,
                     ref: { points: 200, level: 20 },
                     empowerPoints: 500, shopPointsPerGram: 100 };
let _seasonRating = null;   // null = not fetched yet
// Whether THIS account owns the season ticket (server-authoritative — set
// from authOk on login, and again the moment a purchase confirms; see
// onGramShopResult, js/ui.js). Drives its chip in the buff strip
// (drawBuffStrip) and its "already owned" state in the GRAM shop card.
let _seasonTicketActive = false;
