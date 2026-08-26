// ═══════════════════════════════════════════════════════════════════════
//  LOCALIZATION — ru (source of truth) / en / uk / es / tr / pt (Brazil)
// ═══════════════════════════════════════════════════════════════════════
// Architecture: every data array (ITEM_DEF, QUEST_DEF, ENEMY_DEF, SKILL_DEF,
// CHAR_DEF, PASSIVE_CLASS_DEF, PASSIVE_COMMON_DEF, NPC_DEF, MERCHANT_SHOP,
// EQ_SLOTS, UPGRADE_DEF, CLAN_LEVELS, _RARITY_NAMES, _SLOT_NAMES) already has
// Russian text baked directly into its name/desc/title/label fields, and
// every UI call site just reads those fields (`ITEM_DEF.find(d => d.id ===
// x).name`). Rather than rewiring every one of those (100+) call sites,
// applyLocale() below MUTATES the fields in place when the language changes
// — every existing lookup then automatically shows the right language with
// zero call-site changes. _i18nSnapshot() captures a pristine copy of every
// RU field ONCE (before any mutation ever happens), so applyLocale() always
// derives a language's text from the untouched original, however many times
// the user switches back and forth — never from a possibly-already-mutated
// current value.
//
// Scope note: this pass covers game "content" (item/material/quest/skill/
// class/NPC/rarity names) and the static chrome wired up via data-i18n
// attributes (nav tabs, chat panel, death screen). It deliberately does NOT
// retranslate the live monster nameplate (target-frame health bar, drawn
// from server-computed e.name) — the server bakes a rank word + species
// name with no per-client language concept, and localizing it correctly
// needs either server changes or the client independently recomputing names
// from e.eid — a reasonable follow-up, not attempted here. Quest kill-
// tracking (which matches by these same RU species names client-side, see
// onEnemyKill in js/quests.js) is kept correct since QUEST_DEF's enemies[]
// arrays are retranslated in lockstep with ENEMY_DEF's names below.
// Dynamically-generated modal HTML deep inside js/ui.js (market rows, craft
// dialogs, etc.) isn't rewired either — untranslated UI chrome just falls
// back to displaying Russian, which never breaks anything.

const I18N_LANGS = [
  { code: 'ru', native: 'Русский',    flag: '🇷🇺' },
  { code: 'en', native: 'English',    flag: '🇬🇧' },
  { code: 'uk', native: 'Українська', flag: '🇺🇦' },
  { code: 'es', native: 'Español',    flag: '🇪🇸' },
  { code: 'tr', native: 'Türkçe',     flag: '🇹🇷' },
  { code: 'pt', native: 'Português',  flag: '🇧🇷' },
];
let currentLang = 'ru';

// ── UI chrome strings (static HTML wired via data-i18n / data-i18n-placeholder) ──
const I18N_UI = {
  navGame:      { ru: 'Игра',      en: 'Game',      uk: 'Гра',        es: 'Juego',       tr: 'Oyun',      pt: 'Jogo' },
  navChar:      { ru: 'Персонаж',  en: 'Character', uk: 'Персонаж',   es: 'Personaje',   tr: 'Karakter',  pt: 'Personagem' },
  navMap:       { ru: 'Карта',     en: 'Map',        uk: 'Карта',      es: 'Mapa',        tr: 'Harita',    pt: 'Mapa' },
  navQuests:    { ru: 'Квесты',    en: 'Quests',     uk: 'Квести',     es: 'Misiones',    tr: 'Görevler',  pt: 'Missões' },
  navClans:     { ru: 'Кланы',     en: 'Clans',      uk: 'Клани',      es: 'Clanes',      tr: 'Klanlar',   pt: 'Clãs' },
  navProfile:   { ru: 'Профиль',   en: 'Profile',    uk: 'Профіль',    es: 'Perfil',      tr: 'Profil',    pt: 'Perfil' },

  chatTabGlobal:{ ru: 'Общий', en: 'Global', uk: 'Загальний', es: 'General', tr: 'Genel',   pt: 'Geral' },
  chatTabClan:  { ru: 'Клан',  en: 'Clan',   uk: 'Клан',      es: 'Clan',    tr: 'Klan',    pt: 'Clã' },
  chatTabDm:    { ru: 'Беседа',en: 'Chat',   uk: 'Бесіда',    es: 'Chat',    tr: 'Sohbet',  pt: 'Conversa' },
  chatTitle:    { ru: 'Чат',   en: 'Chat',   uk: 'Чат',       es: 'Chat',    tr: 'Sohbet',  pt: 'Chat' },
  chatPlaceholder: { ru: 'Сообщение...', en: 'Message...', uk: 'Повідомлення...', es: 'Mensaje...', tr: 'Mesaj...', pt: 'Mensagem...' },
  chatPlaceholderClan: { ru: 'Сообщение клану...', en: 'Message to clan...', uk: 'Повідомлення клану...', es: 'Mensaje al clan...', tr: 'Klana mesaj...', pt: 'Mensagem ao clã...' },
  chatPlaceholderDmEmpty: { ru: '@ник сообщение...', en: '@nick message...', uk: '@нік повідомлення...', es: '@nick mensaje...', tr: '@kullanıcı mesaj...', pt: '@nick mensagem...' },
  chatPlaceholderDmActive: { ru: 'Сообщение @{u}...', en: 'Message @{u}...', uk: 'Повідомлення @{u}...', es: 'Mensaje a @{u}...', tr: '@{u} mesaj...', pt: 'Mensagem @{u}...' },
  chatDmNoPartner: { ru: 'Выберите беседу выше или отметьте @ник', en: 'Pick a conversation above or mention @nick', uk: 'Оберіть бесіду вище або відмітьте @нік', es: 'Elige una conversación arriba o menciona a @nick', tr: 'Yukarıdan bir sohbet seç ya da @kullanıcı etiketle', pt: 'Escolha uma conversa acima ou mencione @nick' },
  chatTranslateError: { ru: 'Не удалось перевести', en: 'Translation failed', uk: 'Не вдалося перекласти', es: 'No se pudo traducir', tr: 'Çeviri başarısız', pt: 'Falha ao traduzir' },
  chatTranslateBusy: { ru: 'Слишком часто — подождите секунду', en: 'Too fast — wait a second', uk: 'Занадто часто — зачекайте секунду', es: 'Demasiado rápido: espera un segundo', tr: 'Çok hızlı — bir saniye bekleyin', pt: 'Rápido demais — espere um segundo' },
  chatTranslateUnavailable: { ru: 'Перевод временно недоступен, попробуйте позже', en: 'Translation is unavailable right now, try again later', uk: 'Переклад тимчасово недоступний, спробуйте пізніше', es: 'La traducción no está disponible ahora, inténtalo más tarde', tr: 'Çeviri şu anda kullanılamıyor, daha sonra deneyin', pt: 'A tradução está indisponível agora, tente mais tarde' },

  deathTitle:   { ru: 'ВЫ ПАЛИ', en: 'YOU DIED', uk: 'ВИ ЗАГИНУЛИ', es: 'HAS MUERTO', tr: 'ÖLDÜN', pt: 'VOCÊ MORREU' },
  deathRespawn: { ru: 'Возродиться (10% HP)', en: 'Respawn (10% HP)', uk: 'Відродитися (10% HP)', es: 'Reaparecer (10% HP)', tr: 'Yeniden Doğ (%10 HP)', pt: 'Reviver (10% HP)' },

  profileTabWallet:  { ru: 'Кошелёк', en: 'Wallet', uk: 'Гаманець', es: 'Billetera', tr: 'Cüzdan', pt: 'Carteira' },
  profileTabFriends: { ru: 'Друзья',  en: 'Friends', uk: 'Друзі',    es: 'Amigos',    tr: 'Arkadaşlar', pt: 'Amigos' },
  profileTabLang:    { ru: 'Язык',    en: 'Language', uk: 'Мова',    es: 'Idioma',    tr: 'Dil',    pt: 'Idioma' },
  langPickerTitle:   { ru: 'Язык игры', en: 'Game Language', uk: 'Мова гри', es: 'Idioma del juego', tr: 'Oyun Dili', pt: 'Idioma do Jogo' },
  profileTabSound:   { ru: 'Звук',    en: 'Sound', uk: 'Звук',    es: 'Sonido',    tr: 'Ses',    pt: 'Som' },
  profileTabHistory: { ru: 'История', en: 'History', uk: 'Історія', es: 'Historial', tr: 'Geçmiş', pt: 'Histórico' },
  pvpHistoryHdr:     { ru: 'История боёв', en: 'Battle history', uk: 'Історія боїв', es: 'Historial de combates', tr: 'Savaş geçmişi', pt: 'Histórico de batalhas' },
  noPvpHistoryHint:  { ru: 'Пока нет истории боёв', en: 'No battle history yet', uk: 'Поки немає історії боїв', es: 'Aún no hay historial de combates', tr: 'Henüz savaş geçmişi yok', pt: 'Ainda não há histórico de batalhas' },
  pvpModeDeathBattle:{ ru: 'Битва на смерть', en: 'Death Battle', uk: 'Битва на смерть', es: 'Batalla a muerte', tr: 'Ölüm Savaşı', pt: 'Batalha mortal' },
  pvpModeArena3:     { ru: 'Арена 3х3', en: 'Arena 3v3', uk: 'Арена 3х3', es: 'Arena 3v3', tr: 'Arena 3v3', pt: 'Arena 3x3' },
  pvpModeRace10:     { ru: 'Кровавая Башня', en: 'Blood Tower', uk: 'Кривава Вежа', es: 'Torre de Sangre', tr: 'Kan Kulesi', pt: 'Torre de Sangue' },
  pvpModeOpenPvp:    { ru: 'PvP', en: 'PvP', uk: 'PvP', es: 'PvP', tr: 'PvP', pt: 'PvP' },
  pvpHistKillFmt:    { ru: 'Вы убили {u}', en: 'You killed {u}', uk: 'Ви вбили {u}', es: 'Mataste a {u}', tr: '{u} adlı oyuncuyu öldürdün', pt: 'Você matou {u}' },
  pvpHistKill:       { ru: 'Убийство', en: 'Kill', uk: 'Вбивство', es: 'Asesinato', tr: 'Öldürme', pt: 'Assassinato' },
  pvpHistDeathFmt:   { ru: 'Вас убил {u}', en: '{u} killed you', uk: 'Вас вбив {u}', es: '{u} te mató', tr: '{u} seni öldürdü', pt: '{u} te matou' },
  pvpHistDeath:      { ru: 'Вас убили', en: 'You died', uk: 'Вас вбили', es: 'Moriste', tr: 'Öldün', pt: 'Você morreu' },
  pvpHistWin:        { ru: 'Победа', en: 'Victory', uk: 'Перемога', es: 'Victoria', tr: 'Zafer', pt: 'Vitória' },
  pvpHistLose:       { ru: 'Поражение', en: 'Defeat', uk: 'Поразка', es: 'Derrota', tr: 'Yenilgi', pt: 'Derrota' },
  sfxSectionTitle:   { ru: 'Звуковые эффекты', en: 'Sound effects', uk: 'Звукові ефекти', es: 'Efectos de sonido', tr: 'Ses efektleri', pt: 'Efeitos sonoros' },
  sfxOnLbl:          { ru: 'Включены', en: 'On', uk: 'Увімкнено', es: 'Activados', tr: 'Açık', pt: 'Ativados' },
  sfxOffLbl:         { ru: 'Выключены', en: 'Off', uk: 'Вимкнено', es: 'Desactivados', tr: 'Kapalı', pt: 'Desativados' },
  sfxHint:           { ru: 'Удары, смерть врагов, лут и появление босса', en: 'Hits, enemy deaths, loot and boss spawns', uk: 'Удари, смерть ворогів, лут і поява боса', es: 'Golpes, muertes de enemigos, botín y aparición del jefe', tr: 'Vuruşlar, düşman ölümleri, ganimet ve boss belirmesi', pt: 'Acertos, mortes de inimigos, saque e aparição do chefe' },
  bgmSectionTitle:   { ru: 'Фоновая музыка', en: 'Background music', uk: 'Фонова музика', es: 'Música de fondo', tr: 'Arka plan müziği', pt: 'Música de fundo' },

  // ── Death Battle (Битва на смерть) ──────────────────────
  // ── Events panel (События) ──────────────────────────────────────────────
  eventsBtn:    { ru: 'События', en: 'Events', uk: 'Події', es: 'Eventos', tr: 'Etkinlikler', pt: 'Eventos' },
  eventsHdr:    { ru: 'События', en: 'Events', uk: 'Події', es: 'Eventos', tr: 'Etkinlikler', pt: 'Eventos' },
  worldBossTab: { ru: 'Мировой босс', en: 'World boss', uk: 'Світовий бос', es: 'Jefe mundial', tr: 'Dünya patronu', pt: 'Chefe mundial' },
  // Day names for the "next event" line, indexed by Date#getDay() — Sunday
  // first, matching JS, not the Russian week.
  eventWeekdays:{ ru: 'Вс,Пн,Вт,Ср,Чт,Пт,Сб', en: 'Sun,Mon,Tue,Wed,Thu,Fri,Sat', uk: 'Нд,Пн,Вт,Ср,Чт,Пт,Сб', es: 'Dom,Lun,Mar,Mié,Jue,Vie,Sáb', tr: 'Paz,Pzt,Sal,Çar,Per,Cum,Cmt', pt: 'Dom,Seg,Ter,Qua,Qui,Sex,Sáb' },
  // One-line "what it is · when it runs" subtitle for each row in the events
  // list (index.html's #events-tab-list) — the schedule half is static text
  // mirroring the real windows server/index.js runs them on (DEATH_BATTLE_/
  // ARENA3_/RACE10_/GUILD_WAR_*_DAYS_MSK/HOURS_MSK, shared/definitions.js),
  // not a live countdown (that's what the event's own detail page is for).
  eventSubBattle:   { ru: 'Схватка на выживание без союзников', en: 'Free-for-all survival duel', uk: 'Бій на виживання без союзників', es: 'Duelo de supervivencia sin aliados', tr: 'Müttefiksiz hayatta kalma düellosu', pt: 'Duelo de sobrevivência sem aliados' },
  eventSubA3:       { ru: 'Командный бой 3 на 3', en: '3v3 team battle', uk: 'Командний бій 3 на 3', es: 'Batalla en equipo 3 contra 3', tr: '3v3 takım savaşı', pt: 'Batalha em equipe 3x3' },
  eventSubRace10:   { ru: 'Забег через коридоры с монстрами', en: 'Corridor run past waves of monsters', uk: 'Забіг крізь коридори з монстрами', es: 'Carrera por pasillos con monstruos', tr: 'Canavar dolu koridorlarda yarış', pt: 'Corrida por corredores com monstros' },
  eventSubFear:     { ru: 'Волны монстров на выживание', en: 'Survive endless waves of monsters', uk: 'Хвилі монстрів на виживання', es: 'Oleadas de monstruos, sobrevive', tr: 'Canavar dalgalarına karşı hayatta kal', pt: 'Ondas de monstros, sobreviva' },
  eventSubCoop:     { ru: 'Совместное прохождение вдвоём', en: 'Clear it together with a partner', uk: 'Спільне проходження удвох', es: 'Complétalo junto a otro jugador', tr: 'İki kişiyle birlikte tamamla', pt: 'Complete junto com outro jogador' },
  eventSubBoss:     { ru: 'Общий рейд на мирового босса', en: 'Raid the shared world boss', uk: 'Спільний рейд на світового боса', es: 'Asalto conjunto al jefe mundial', tr: 'Ortak dünya patronuna baskın', pt: 'Ataque conjunto ao chefe mundial' },
  eventSubGuildWar: { ru: 'Кланы сражаются за замок', en: 'Guilds fight for the castle', uk: 'Гільдії бʼються за замок', es: 'Los clanes luchan por el castillo', tr: 'Klanlar kale için savaşır', pt: 'Clãs lutam pelo castelo' },

  // Schedule line (third row on each event card) — same fixed windows the
  // eventSub* strings above used to carry after their own "·", split into
  // its own row now that the card has room for one. Mirrors the real
  // windows server/index.js runs them on (DEATH_BATTLE_/ARENA3_/RACE10_/
  // GUILD_WAR_*_DAYS_MSK/HOURS_MSK, shared/definitions.js), not a live
  // countdown (that's what the event's own detail page is for).
  eventSchedBattle:   { ru: 'Вт, Чт, Сб в 10:00 МСК', en: 'Tue, Thu, Sat at 10:00 MSK', uk: 'Вт, Чт, Сб о 10:00 МСК', es: 'Mar, Jue, Sáb a las 10:00 MSK', tr: 'Sal, Per, Cmt 10:00 MSK', pt: 'Ter, Qui, Sáb às 10:00 MSK' },
  eventSchedA3:       { ru: 'Ежедневно 21:00–22:00 МСК', en: 'Daily 21:00–22:00 MSK', uk: 'Щодня 21:00–22:00 МСК', es: 'Todos los días 21:00–22:00 MSK', tr: 'Her gün 21:00–22:00 MSK', pt: 'Todos os dias 21:00–22:00 MSK' },
  eventSchedRace10:   { ru: 'Ежедневно в 20:30 МСК', en: 'Daily at 20:30 MSK', uk: 'Щодня о 20:30 МСК', es: 'Todos los días a las 20:30 MSK', tr: 'Her gün 20:30 MSK', pt: 'Todos os dias às 20:30 MSK' },
  eventSchedFear:     { ru: 'Доступно всегда', en: 'Always available', uk: 'Доступно завжди', es: 'Siempre disponible', tr: 'Her zaman açık', pt: 'Sempre disponível' },
  eventSchedCoop:     { ru: 'Доступно всегда', en: 'Always available', uk: 'Доступно завжди', es: 'Siempre disponible', tr: 'Her zaman açık', pt: 'Sempre disponível' },
  eventSchedBoss:     { ru: 'Пн, Ср, Пт, Вс в 20:00 МСК', en: 'Mon, Wed, Fri, Sun at 20:00 MSK', uk: 'Пн, Ср, Пт, Нд о 20:00 МСК', es: 'Lun, Mié, Vie, Dom a las 20:00 MSK', tr: 'Pzt, Çar, Cum, Paz 20:00 MSK', pt: 'Seg, Qua, Sex, Dom às 20:00 MSK' },
  eventSchedGuildWar: { ru: 'Ежедневно 22:00–22:15 МСК', en: 'Daily 22:00–22:15 MSK', uk: 'Щодня 22:00–22:15 МСК', es: 'Todos los días 22:00–22:15 MSK', tr: 'Her gün 22:00–22:15 MSK', pt: 'Todos os dias 22:00–22:15 MSK' },
  // ── 3v3 arena ───────────────────────────────────────────────────────────
  a3Tab:        { ru: '3х3', en: '3v3', uk: '3х3', es: '3v3', tr: '3v3', pt: '3v3' },
  a3ArenaLbl:   { ru: 'Арена 3х3', en: '3v3 Arena', uk: 'Арена 3х3', es: 'Arena 3v3', tr: '3v3 Arena', pt: 'Arena 3v3' },
  a3TeamA:      { ru: 'Синие', en: 'Blue', uk: 'Сині', es: 'Azules', tr: 'Mavi', pt: 'Azuis' },
  a3StartedFmt: { ru: '⚔️ Бой! Ваша команда: {team}', en: '⚔️ Fight! Your team: {team}', uk: '⚔️ Бій! Ваша команда: {team}', es: '⚔️ ¡Lucha! Tu equipo: {team}', tr: '⚔️ Savaş! Takımın: {team}', pt: '⚔️ Luta! Seu time: {team}' },
  a3PhaseIdle:  { ru: 'Ждём игроков', en: 'Waiting for players', uk: 'Чекаємо гравців', es: 'Esperando jugadores', tr: 'Oyuncular bekleniyor', pt: 'Aguardando jogadores' },
  a3PhaseClosed:{ ru: 'До открытия арены 3х3', en: '3v3 arena opens in', uk: 'До відкриття арени 3х3', es: 'La arena 3v3 abre en', tr: '3v3 arenası açılışına', pt: 'A arena 3v3 abre em' },
  a3RuleSchedule:{ ru: 'Открыта каждый день с 21:00 до 22:00 по Москве', en: 'Open every day, 21:00–22:00 Moscow time', uk: 'Відкрита щодня з 21:00 до 22:00 за Москвою', es: 'Abierta todos los días de 21:00 a 22:00 (hora de Moscú)', tr: 'Her gün 21:00–22:00 Moskova saatiyle açık', pt: 'Aberta todos os dias das 21h às 22h (horário de Moscou)' },
  a3PhaseQueued:{ ru: 'Вы в очереди', en: "You're in the queue", uk: 'Ви в черзі', es: 'Estás en la cola', tr: 'Sıradasın', pt: 'Você está na fila' },
  a3PhaseFighting:{ ru: 'Бой идёт', en: 'Match in progress', uk: 'Бій триває', es: 'Combate en curso', tr: 'Maç sürüyor', pt: 'Partida em andamento' },
  a3ScoreFmt:   { ru: 'Синие {a} — {b} Красные', en: 'Blue {a} — {b} Red', uk: 'Сині {a} — {b} Червоні', es: 'Azules {a} — {b} Rojos', tr: 'Mavi {a} — {b} Kırmızı', pt: 'Azuis {a} — {b} Vermelhos' },
  a3NeedLevelFmt:{ ru: 'Нужен {n} уровень', en: 'Level {n} required', uk: 'Потрібен {n} рівень', es: 'Se requiere nivel {n}', tr: '{n}. seviye gerekli', pt: 'Nível {n} necessário' },
  a3Eliminated: { ru: 'Вы выбыли — возврат в мир', en: 'You are out — back to the world', uk: 'Ви вибули — повернення у світ', es: 'Estás fuera: de vuelta al mundo', tr: 'Elendin — dünyaya dönüş', pt: 'Você saiu — de volta ao mundo' },
  a3Rule1:      { ru: 'Матч стартует, как только наберётся {n} человек', en: 'The match starts as soon as {n} players are queued', uk: 'Матч стартує, щойно набереться {n} осіб', es: 'La partida empieza cuando haya {n} jugadores', tr: '{n} oyuncu toplanınca maç başlar', pt: 'A partida começa quando houver {n} jogadores' },
  a3Rule2:      { ru: 'Делит на две команды по 3 случайным образом', en: 'Split at random into two teams of three', uk: 'Ділить на дві команди по 3 випадково', es: 'División aleatoria en dos equipos de tres', tr: 'Rastgele üçerli iki takıma bölünür', pt: 'Divisão aleatória em dois times de três' },
  a3Rule3:      { ru: 'Союзники не могут ранить друг друга', en: 'Allies cannot damage each other', uk: 'Союзники не можуть поранити одне одного', es: 'Los aliados no pueden dañarse entre sí', tr: 'Müttefikler birbirine hasar veremez', pt: 'Aliados não podem se ferir' },
  a3Rule4:      { ru: 'Побеждает команда, у которой остался живой', en: 'The team with anyone left standing wins', uk: 'Перемагає команда, у якої лишився живий', es: 'Gana el equipo que aún tenga a alguien en pie', tr: 'Ayakta kalanı olan takım kazanır', pt: 'Vence o time que ainda tiver alguém de pé' },
  a3RuleBoss:   { ru: 'У каждой команды свой страж (30 000 HP): его нельзя атаковать или взять в ассист, но уничтожив вражеского — вы побеждаете мгновенно', en: 'Each team has its own guard (30,000 HP): you can\'t attack or assist-target your own, but destroying the enemy\'s wins instantly', uk: 'У кожної команди свій страж (30 000 HP): його не можна атакувати чи взяти в асист, але знищивши ворожого — ви перемагаєте миттєво', es: 'Cada equipo tiene su propio guardián (30.000 HP): no puedes atacar ni asistir al tuyo, pero destruir el del rival gana al instante', tr: 'Her takımın kendi muhafızı var (30.000 CAN): kendinize saldıramaz veya asist hedefi alamazsınız, ama düşmanınkini yok etmek anında kazandırır', pt: 'Cada time tem seu próprio guardião (30.000 HP): você não pode atacar nem assistir o seu, mas destruir o do inimigo vence na hora' },
  a3RuleDuration: { ru: 'Бой длится 3 минуты — если к этому времени никто не победил, матч завершается без результата', en: 'The match lasts 3 minutes — if nobody has won by then, it ends with no result', uk: 'Бій триває 3 хвилини — якщо на той час ніхто не переміг, матч завершується без результату', es: 'La partida dura 3 minutos; si nadie ha ganado para entonces, termina sin resultado', tr: 'Maç 3 dakika sürer — o zamana kadar kimse kazanmadıysa sonuçsuz biter', pt: 'A partida dura 3 minutos — se ninguém venceu até lá, ela termina sem resultado' },
  a3Rule5:      { ru: 'Только с {n} уровня', en: 'Level {n} and above only', uk: 'Тільки з {n} рівня', es: 'Solo desde el nivel {n}', tr: 'Sadece {n}. seviyeden itibaren', pt: 'Somente a partir do nível {n}' },
  a3Rule6:      { ru: '{n} попытки в день, тратится при старте матча', en: '{n} attempts a day, spent when the match starts', uk: '{n} спроби на день, витрачається на старті матчу', es: '{n} intentos al día, se gasta al empezar la partida', tr: 'Günde {n} hak, maç başlayınca harcanır', pt: '{n} tentativas por dia, gasta ao começar a partida' },
  a3AttemptsFmt:{ ru: 'Попыток сегодня: {n}/{max}', en: 'Attempts today: {n}/{max}', uk: 'Спроб сьогодні: {n}/{max}', es: 'Intentos hoy: {n}/{max}', tr: 'Bugünkü hak: {n}/{max}', pt: 'Tentativas hoje: {n}/{max}' },
  a3NoAttempts: { ru: 'Попытки на сегодня кончились', en: 'No attempts left today', uk: 'Спроби на сьогодні скінчились', es: 'No quedan intentos hoy', tr: 'Bugünlük hak kalmadı', pt: 'Sem tentativas hoje' },
  a3RewardHdr:  { ru: 'Награда каждому победителю:', en: 'Each winner takes:', uk: 'Нагорода кожному переможцю:', es: 'Cada ganador se lleva:', tr: 'Her kazananın ödülü:', pt: 'Cada vencedor leva:' },
  a3Victory:    { ru: 'ПОБЕДА', en: 'VICTORY', uk: 'ПЕРЕМОГА', es: 'VICTORIA', tr: 'ZAFER', pt: 'VITÓRIA' },
  a3VictorySub: { ru: 'Ваша команда выстояла', en: 'Your team held the arena', uk: 'Ваша команда вистояла', es: 'Tu equipo aguantó', tr: 'Takımın dayandı', pt: 'Seu time resistiu' },
  a3Defeat:     { ru: 'ПОРАЖЕНИЕ', en: 'DEFEAT', uk: 'ПОРАЗКА', es: 'DERROTA', tr: 'YENİLGİ', pt: 'DERROTA' },
  a3DefeatSub:  { ru: 'Команда пала', en: 'Your team fell', uk: 'Команда полягла', es: 'Tu equipo cayó', tr: 'Takımın düştü', pt: 'Seu time caiu' },
  a3NoResult:   { ru: 'БЕЗ РЕЗУЛЬТАТА', en: 'NO RESULT', uk: 'БЕЗ РЕЗУЛЬТАТУ', es: 'SIN RESULTADO', tr: 'SONUÇ YOK', pt: 'SEM RESULTADO' },
  a3NoResultSub:{ ru: 'Матч закрыт: никто не добил соперника', en: 'Match closed: nobody finished the other side', uk: 'Матч закрито: ніхто не добив суперника', es: 'Partida cerrada: nadie acabó con el rival', tr: 'Maç kapandı: kimse rakibi bitiremedi', pt: 'Partida encerrada: ninguém finalizou o adversário' },
  a3ResultClose:{ ru: 'В мир', en: 'To the world', uk: 'У світ', es: 'Al mundo', tr: 'Dünyaya', pt: 'Para o mundo' },

  // ── 10-player corridor race: "Кровавая Башня" (Bloody Tower) ─────────────
  race10Tab:      { ru: 'Кровавая Башня', en: 'Bloody Tower', uk: 'Кривава Вежа', es: 'Torre Sangrienta', tr: 'Kanlı Kule', pt: 'Torre Sangrenta' },
  race10ArenaLbl: { ru: 'Кровавая Башня', en: 'Bloody Tower', uk: 'Кривава Вежа', es: 'Torre Sangrienta', tr: 'Kanlı Kule', pt: 'Torre Sangrenta' },
  race10StartedMsg: { ru: '⚔️ Кровавая Башня открыта! Бегите к боссу', en: '⚔️ The Bloody Tower is open! Race to the boss', uk: '⚔️ Криваву Вежу відкрито! Біжіть до боса', es: '⚔️ ¡La Torre Sangrienta está abierta! Corre hacia el jefe', tr: '⚔️ Kanlı Kule açıldı! Patrona koş', pt: '⚔️ A Torre Sangrenta está aberta! Corra até o chefe' },
  race10PhaseFighting: { ru: 'Забег идёт', en: 'Race in progress', uk: 'Забіг триває', es: 'Carrera en curso', tr: 'Yarış sürüyor', pt: 'Corrida em andamento' },
  race10PhaseIdle: { ru: 'До открытия Кровавой Башни', en: 'Bloody Tower opens in', uk: 'До відкриття Кривавої Вежі', es: 'La Torre Sangrienta abre en', tr: 'Kanlı Kule açılışına', pt: 'A Torre Sangrenta abre em' },
  race10Rule6:    { ru: 'Открыта каждый день в 20:30 по Москве, всего на 5 минут', en: 'Open every day at 20:30 Moscow time, for 5 minutes only', uk: 'Відкрита щодня о 20:30 за Москвою, лише на 5 хвилин', es: 'Abierta todos los días a las 20:30 (hora de Moscú), solo 5 minutos', tr: 'Her gün 20:30 Moskova saatiyle, sadece 5 dakika açık', pt: 'Aberta todos os dias às 20h30 (horário de Moscou), por apenas 5 minutos' },
  race10Eliminated: { ru: 'Вы выбыли — возврат в мир', en: 'You are out — back to the world', uk: 'Ви вибули — повернення у світ', es: 'Estás fuera: de vuelta al mundo', tr: 'Elendin — dünyaya dönüş', pt: 'Você saiu — de volta ao mundo' },
  race10ScoreFmt: { ru: 'Урон боссу: {dmg} (место {rank}/{total})', en: 'Boss damage: {dmg} (rank {rank}/{total})', uk: 'Шкода босу: {dmg} (місце {rank}/{total})', es: 'Daño al jefe: {dmg} (puesto {rank}/{total})', tr: 'Patron hasarı: {dmg} (sıra {rank}/{total})', pt: 'Dano ao chefe: {dmg} (posição {rank}/{total})' },
  race10Rule1:    { ru: 'Регистрация 5 минут после открытия, затем один общий старт — бегут все, кто записался', en: 'Registration is open for 5 minutes, then everyone who signed up starts together', uk: 'Реєстрація 5 хвилин після відкриття, потім спільний старт — біжать усі, хто записався', es: 'La inscripción dura 5 minutos y luego todos los inscritos salen a la vez', tr: 'Kayıt 5 dakika açık kalır, sonra kaydolan herkes birlikte başlar', pt: 'A inscrição fica aberta 5 minutos e depois todos os inscritos começam juntos' },
  race10Rule8:    { ru: 'Одна попытка в день', en: 'One attempt per day', uk: 'Одна спроба на день', es: 'Un intento por día', tr: 'Günde bir hak', pt: 'Uma tentativa por dia' },
  race10Rule2:    { ru: 'У каждого своя дорога: 60 монстров 5 уровня, затем 60 монстров 10 уровня, впритык друг к другу', en: 'Everyone gets their own lane: 60 level-5 monsters, then 60 level-10 monsters, packed shoulder to shoulder', uk: 'У кожного своя дорога: 60 монстрів 5 рівня, потім 60 монстрів 10 рівня, впритул одне до одного', es: 'Cada uno tiene su propio carril: 60 monstruos nivel 5, luego 60 nivel 10, uno junto a otro', tr: 'Herkesin kendi koridoru var: önce 60 seviye 5, sonra 60 seviye 10 canavar, omuz omuza', pt: 'Cada um tem seu próprio corredor: 60 monstros nível 5, depois 60 nível 10, lado a lado' },
  race10Rule3:    { ru: 'Все дороги ведут к одному общему боссу — мировому боссу, без дропа', en: 'Every lane leads to the same shared boss — the world boss, no loot', uk: 'Усі дороги ведуть до одного спільного боса — світового боса, без дропу', es: 'Todos los carriles llevan al mismo jefe compartido — el jefe mundial, sin botín', tr: 'Tüm koridorlar aynı ortak patrona çıkar — dünya patronu, ganimetsiz', pt: 'Todos os corredores levam ao mesmo chefe compartilhado — o chefe mundial, sem loot' },
  race10Rule4:    { ru: 'Побеждает тот, кто нанёс боссу больше всего урона — не обязательно добивший', en: 'Whoever dealt the boss the most total damage wins — not necessarily the one who finishes it', uk: 'Перемагає той, хто завдав босу найбільше шкоди — не обов\'язково той, хто добив', es: 'Gana quien haya hecho más daño total al jefe, no necesariamente quien lo remate', tr: 'Patrona en çok toplam hasarı veren kazanır — bitiren kişi olması gerekmez', pt: 'Vence quem causou mais dano total ao chefe — não necessariamente quem o derruba' },
  race10Waiting:  { ru: 'Записалось: {n}', en: 'Signed up: {n}', uk: 'Записалося: {n}', es: 'Inscritos: {n}', tr: 'Kaydolan: {n}', pt: 'Inscritos: {n}' },
  race10Rule5:    { ru: 'Смерть в коридоре — выбывание из забега', en: 'Dying anywhere in a lane eliminates you from the race', uk: 'Смерть у коридорі — вибування із забігу', es: 'Morir en el pasillo te elimina de la carrera', tr: 'Koridorda ölmek yarıştan eler', pt: 'Morrer no corredor elimina você da corrida' },
  race10Rule7:    { ru: 'В конце каждой линии монстров — барьер: не пройти, пока не убиты все', en: 'A barrier sits at the end of each monster line — impassable until every last one is dead', uk: 'У кінці кожної лінії монстрів — бар\'єр: не пройти, поки не вбиті всі', es: 'Al final de cada línea de monstruos hay una barrera: no se puede pasar hasta matarlos a todos', tr: 'Her canavar hattının sonunda bir bariyer var — hepsi ölene kadar geçilmez', pt: 'No fim de cada linha de monstros há uma barreira: intransponível até que todos morram' },
  raceBarrierLockedMsg: { ru: '🔒 Убейте всех монстров, чтобы пройти', en: '🔒 Kill every monster to pass', uk: '🔒 Вбийте всіх монстрів, щоб пройти', es: '🔒 Mata a todos los monstruos para pasar', tr: '🔒 Geçmek için tüm canavarları öldür', pt: '🔒 Mate todos os monstros para passar' },
  coopBarrierLockedMsg: { ru: '🔒 Дождитесь, пока напарник зачистит этаж', en: '🔒 Wait for your partner to clear the floor', uk: '🔒 Зачекайте, поки напарник зачистить поверх', es: '🔒 Espera a que tu compañero limpie el piso', tr: '🔒 Ortağının katı temizlemesini bekle', pt: '🔒 Espere seu parceiro limpar o andar' },
  race10RewardAll:{ ru: 'Liberty — всем, кто ударил босса', en: 'Liberty — everyone who hit the boss', uk: 'Liberty — усім, хто вдарив боса', es: 'Liberty — a todos los que golpearon al jefe', tr: 'Liberty — patrona vuran herkese', pt: 'Liberty — todos que acertaram o chefe' },
  race10RewardWin:{ ru: 'Liberty — победителю', en: 'Liberty — to the winner', uk: 'Liberty — переможцю', es: 'Liberty — al ganador', tr: 'Liberty — kazanana', pt: 'Liberty — ao vencedor' },
  race10RewardPotions:{ ru: 'Банки бафов, все виды', en: 'Buff potions, every kind', uk: 'Банки бафів, усі види', es: 'Pociones de mejora, de cada tipo', tr: 'Her türden güçlendirme iksiri', pt: 'Poções de bônus, de cada tipo' },
  race10RewardHdr:{ ru: 'Награды:', en: 'Rewards:', uk: 'Нагороди:', es: 'Recompensas:', tr: 'Ödüller:', pt: 'Recompensas:' },
  race10XpRewardName: { ru: 'Опыт с монстров в Башне', en: 'XP from monsters in the Tower', uk: 'Досвід з монстрів у Вежі', es: 'XP de los monstruos en la Torre', tr: 'Kuledeki canavarlardan tecrübe', pt: 'XP dos monstros na Torre' },
  race10Victory:  { ru: 'ПОБЕДА', en: 'VICTORY', uk: 'ПЕРЕМОГА', es: 'VICTORIA', tr: 'ZAFER', pt: 'VITÓRIA' },
  race10VictorySub:{ ru: 'Вы нанесли боссу больше всего урона', en: 'You dealt the boss the most damage', uk: 'Ви завдали босу найбільше шкоди', es: 'Le hiciste más daño al jefe que nadie', tr: 'Patrona en çok hasarı sen verdin', pt: 'Você causou mais dano ao chefe' },
  race10Defeat:   { ru: 'ЗАБЕГ ЗАВЕРШЁН', en: 'RACE OVER', uk: 'ЗАБІГ ЗАВЕРШЕНО', es: 'CARRERA TERMINADA', tr: 'YARIŞ BİTTİ', pt: 'CORRIDA ENCERRADA' },
  race10DefeatSub:{ ru: 'Победил {name} — ваш урон боссу: {dmg}', en: '{name} won — your damage to the boss: {dmg}', uk: 'Переміг {name} — ваша шкода босу: {dmg}', es: '{name} ganó — tu daño al jefe: {dmg}', tr: '{name} kazandı — patrona verdiğin hasar: {dmg}', pt: '{name} venceu — seu dano ao chefe: {dmg}' },
  race10NoResultSub:{ ru: 'Забег закрыт: никто не одолел босса вовремя', en: 'Race closed: nobody brought the boss down in time', uk: 'Забіг закрито: ніхто не здолав боса вчасно', es: 'Carrera cerrada: nadie derrotó al jefe a tiempo', tr: 'Yarış kapandı: kimse patronu zamanında yenemedi', pt: 'Corrida encerrada: ninguém derrotou o chefe a tempo' },


  // ── Сезон ─────────────────────────────────────────────────────────────────
  seasonBtn:      { ru: 'Сезон', en: 'Season', uk: 'Сезон', es: 'Temporada', tr: 'Sezon', pt: 'Temporada' },
  seasonHdr:      { ru: 'Сезон', en: 'Season', uk: 'Сезон', es: 'Temporada', tr: 'Sezon', pt: 'Temporada' },
  seasonTabSeason:{ ru: 'Сезон', en: 'Season', uk: 'Сезон', es: 'Temporada', tr: 'Sezon', pt: 'Temporada' },
  seasonTabTasks: { ru: 'Задания', en: 'Tasks', uk: 'Завдання', es: 'Tareas', tr: 'Görevler', pt: 'Tarefas' },
  seasonTabRating:{ ru: 'Рейтинг', en: 'Rating', uk: 'Рейтинг', es: 'Clasificación', tr: 'Sıralama', pt: 'Classificação' },
  season2Title: { ru: 'Сезон 2', en: 'Season 2', uk: 'Сезон 2', es: 'Temporada 2', tr: 'Sezon 2', pt: 'Temporada 2' },
  season2Desc: {
    ru: 'Гонка очков сезона: точи снаряжение, крафти книги профессий, сжигай лишнее, зови друзей, перерождайся и покупай на рынке — лучшие получат призы.',
    en: 'The season points race: enhance your gear, craft profession books, burn junk, invite friends, rebirth, and buy on the market — the best players win prizes.',
    uk: 'Гонка очок сезону: точи спорядження, крафти книги професій, спалюй зайве, клич друзів, переродись і купуй на ринку — найкращі отримають призи.',
    es: 'La carrera de puntos de temporada: mejora tu equipo, crea libros de profesión, quema lo que no sirve, invita amigos, renace y compra en el mercado — los mejores ganan premios.',
    tr: 'Sezon puan yarışı: eşyanı geliştir, meslek kitapları hazırla, gereksizleri yak, arkadaş davet et, yeniden doğ ve pazardan alışveriş yap — en iyiler ödül kazanır.',
    pt: 'A corrida de pontos da temporada: aprimore seu equipamento, crie livros de profissão, queime o que não serve, convide amigos, renasça e compre no mercado — os melhores ganham prêmios.',
  },
  season2EnhSpecialHdr: {
    ru: 'Заточка питомца / артефакта / плаща:', en: 'Enhancing a pet / artifact / cloak:',
    uk: 'Заточка пітомця / артефакта / плаща:', es: 'Mejorar mascota / artefacto / capa:',
    tr: 'Evcil hayvan / artefakt / pelerin geliştirme:', pt: 'Aprimorar pet / artefato / manto:',
  },
  season2EnhSpecialFmt: {
    ru: '{r}: обычная +{norm} · безопасная +{safe}', en: '{r}: normal +{norm} · safe +{safe}',
    uk: '{r}: звичайна +{norm} · безпечна +{safe}', es: '{r}: normal +{norm} · segura +{safe}',
    tr: '{r}: normal +{norm} · güvenli +{safe}', pt: '{r}: normal +{norm} · segura +{safe}',
  },
  season2EnhGearHdr: {
    ru: 'Заточка предметов:', en: 'Enhancing gear:', uk: 'Заточка предметів:',
    es: 'Mejorar objetos:', tr: 'Eşya geliştirme:', pt: 'Aprimorar itens:',
  },
  season2EnhGearFmt: {
    ru: '{r}: обычная +{n} очков', en: '{r}: normal +{n} points', uk: '{r}: звичайна +{n} очок',
    es: '{r}: normal +{n} puntos', tr: '{r}: normal +{n} puan', pt: '{r}: normal +{n} pontos',
  },
  season2AdvBookFmt: {
    ru: 'Скрафтить книгу второй профессии — +{n} очков', en: 'Craft an advanced (2nd profession) skill book — +{n} points',
    uk: 'Скрафтити книгу другої професії — +{n} очок', es: 'Crear un libro de segunda profesión — +{n} puntos',
    tr: 'İkinci meslek kitabı hazırla — +{n} puan', pt: 'Criar um livro de segunda profissão — +{n} pontos',
  },
  season2RebirthFmt: {
    ru: 'Перерождение — +{n} очков', en: 'Rebirth — +{n} points', uk: 'Переродження — +{n} очок',
    es: 'Renacer — +{n} puntos', tr: 'Yeniden doğuş — +{n} puan', pt: 'Renascimento — +{n} pontos',
  },
  season2ShopFmt: {
    ru: 'Покупка в магазине GRAM — +{n} очков за каждый потраченный GRAM (от 1 GRAM)',
    en: 'Buying in the GRAM shop — +{n} points per GRAM spent (from 1 GRAM)',
    uk: 'Купівля в магазині GRAM — +{n} очок за кожен витрачений GRAM (від 1 GRAM)',
    es: 'Comprar en la tienda de GRAM — +{n} puntos por cada GRAM gastado (desde 1 GRAM)',
    tr: 'GRAM mağazasından alışveriş — harcanan her GRAM için +{n} puan (1 GRAM\'dan itibaren)',
    pt: 'Comprar na loja de GRAM — +{n} pontos por GRAM gasto (a partir de 1 GRAM)',
  },
  season2BurnBookFmt: {
    ru: 'Книга (любая) — +{n} очков за штуку', en: 'A book (any) — +{n} points each',
    uk: 'Книга (будь-яка) — +{n} очок за штуку', es: 'Un libro (cualquiera) — +{n} puntos cada uno',
    tr: 'Kitap (herhangi biri) — parça başına +{n} puan', pt: 'Um livro (qualquer) — +{n} pontos cada',
  },
  season2BurnBookConfirm: {
    ru: 'Сжечь «{name}» ×{n} и получить {p} очков? Отменить будет нельзя.',
    en: 'Burn "{name}" ×{n} for {p} points? This cannot be undone.',
    uk: 'Спалити «{name}» ×{n} і отримати {p} очок? Скасувати не вийде.',
    es: '¿Quemar «{name}» ×{n} por {p} puntos? No se puede deshacer.',
    tr: '"{name}" ×{n} yakılsın ve {p} puan kazanılsın mı? Geri alınamaz.',
    pt: 'Queimar «{name}» ×{n} por {p} pontos? Não dá para desfazer.',
  },
  seasonPlaceRangeFmt: {
    ru: '{a}–{b} место', en: 'Places {a}-{b}', uk: '{a}–{b} місце',
    es: 'Puestos {a}-{b}', tr: '{a}-{b}. sıra', pt: '{a}º-{b}º lugar',
  },
  season2RatingMinFmt: {
    ru: 'В рейтинге показаны игроки, набравшие от {n} очков',
    en: 'The leaderboard only shows players with {n}+ points',
    uk: 'У рейтингу показані гравці, які набрали від {n} очок',
    es: 'La clasificación solo muestra jugadores con {n}+ puntos',
    tr: 'Sıralamada yalnızca {n}+ puana sahip oyuncular gösterilir',
    pt: 'A classificação só mostra jogadores com {n}+ pontos',
  },
  seasonTicketShopLbl: { ru: 'Сезонный билет', en: 'Season ticket', uk: 'Сезонний квиток', es: 'Boleto de temporada', tr: 'Sezon bileti', pt: 'Bilhete de temporada' },
  seasonTicketXpRowFmt: {
    ru: 'x2 к опыту', en: 'x2 experience', uk: 'x2 до досвіду',
    es: 'x2 de experiencia', tr: 'Deneyimde x2', pt: 'x2 de experiência',
  },
  seasonTicketDropRowFmt: {
    ru: '+{n}% к выпадению предметов', en: '+{n}% item drop chance', uk: '+{n}% до випадіння предметів',
    es: '+{n}% de probabilidad de objetos', tr: 'Eşya düşme şansına +%{n}', pt: '+{n}% de chance de itens',
  },
  seasonTicketLibertyRowFmt: {
    ru: '+{n}% к выпадению LIBERTY', en: '+{n}% Liberty drop chance', uk: '+{n}% до випадіння LIBERTY',
    es: '+{n}% de probabilidad de Liberty', tr: 'Liberty düşme şansına +%{n}', pt: '+{n}% de chance de Liberty',
  },
  seasonPointsLbl:{ ru: 'Очки сезона', en: 'Season points', uk: 'Очки сезону', es: 'Puntos de temporada', tr: 'Sezon puanı', pt: 'Pontos da temporada' },
  seasonEndsIn:   { ru: 'До конца сезона: {t}', en: 'Season ends in {t}', uk: 'До кінця сезону: {t}', es: 'La temporada acaba en {t}', tr: 'Sezon bitişine {t}', pt: 'A temporada acaba em {t}' },
  seasonEnded:    { ru: 'Сезон завершён', en: 'Season is over', uk: 'Сезон завершено', es: 'La temporada terminó', tr: 'Sezon bitti', pt: 'A temporada acabou' },
  seasonLoading:  { ru: 'Загрузка...', en: 'Loading...', uk: 'Завантаження...', es: 'Cargando...', tr: 'Yükleniyor...', pt: 'Carregando...' },
  seasonEventDoneMsg: { ru: '+{n} очков сезона', en: '+{n} season points', uk: '+{n} очок сезону', es: '+{n} puntos de temporada', tr: '+{n} sezon puanı', pt: '+{n} pontos da temporada' },
  normStoneLbl:    { ru: 'обычных заточек', en: 'normal stones', uk: 'звичайних заточок', es: 'piedras normales', tr: 'normal taş', pt: 'pedras normais' },
  blessStoneLbl:   { ru: 'безопасных заточек', en: 'safe stones', uk: 'безпечних заточок', es: 'piedras seguras', tr: 'güvenli taş', pt: 'pedras seguras' },

  seasonRefTask:     { ru: 'Пригласи друга, который достигнет {lv} уровня — +{n} очков', en: 'Invite a friend who reaches level {lv} — +{n} points', uk: 'Запроси друга, який досягне {lv} рівня — +{n} очок', es: 'Invita a un amigo que llegue al nivel {lv}: +{n} puntos', tr: '{lv}. seviyeye ulaşan bir arkadaş davet et — +{n} puan', pt: 'Convide um amigo que alcance o nível {lv} — +{n} pontos' },
  seasonRefNote:     { ru: 'Начисляется один раз за каждого приглашённого друга. Ссылка — в профиле.', en: 'Paid once per invited friend. The link is in your profile.', uk: 'Нараховується один раз за кожного запрошеного друга. Посилання — у профілі.', es: 'Se paga una vez por cada amigo invitado. El enlace está en tu perfil.', tr: 'Davet edilen her arkadaş için bir kez ödenir. Bağlantı profilinizde.', pt: 'Pago uma vez por amigo convidado. O link está no seu perfil.' },
  seasonRefBonusMsg: { ru: '+{n} очков сезона за друга {name}', en: '+{n} season points for {name}', uk: '+{n} очок сезону за друга {name}', es: '+{n} puntos de temporada por {name}', tr: '{name} için +{n} sezon puanı', pt: '+{n} pontos da temporada por {name}' },
  seasonBurnHdr:  { ru: 'Сжигание снаряжения:', en: 'Burning gear:', uk: 'Спалювання спорядження:', es: 'Quemar equipo:', tr: 'Ekipman yakma:', pt: 'Queimar equipamento:' },
  seasonBurnCommon:   { ru: 'Обычное — {n} очко за предмет', en: 'Common — {n} point per item', uk: 'Звичайне — {n} очко за предмет', es: 'Común — {n} punto por objeto', tr: 'Sıradan — parça başına {n} puan', pt: 'Comum — {n} ponto por item' },
  seasonBurnUncommon: { ru: 'Необычное — {n} очков за предмет', en: 'Uncommon — {n} points per item', uk: 'Незвичайне — {n} очок за предмет', es: 'Poco común — {n} puntos por objeto', tr: 'Nadir — parça başına {n} puan', pt: 'Incomum — {n} pontos por item' },
  seasonBurnNote: { ru: 'Предмет будет уничтожен', en: 'The item will be destroyed', uk: 'Предмет буде знищено', es: 'El objeto será destruido', tr: 'Eşya yok edilecek', pt: 'O item será destruído' },
  seasonBurnBtn:  { ru: 'Сжечь (+{n})', en: 'Burn (+{n})', uk: 'Спалити (+{n})', es: 'Quemar (+{n})', tr: 'Yak (+{n})', pt: 'Queimar (+{n})' },
  seasonBurnAllCommon:   { ru: 'Сжечь все обычные', en: 'Burn all common', uk: 'Спалити всі звичайні', es: 'Quemar todos los comunes', tr: 'Tüm sıradanları yak', pt: 'Queimar todos comuns' },
  seasonBurnAllUncommon: { ru: 'Сжечь все необычные', en: 'Burn all uncommon', uk: 'Спалити всі незвичайні', es: 'Quemar todos los poco comunes', tr: 'Tüm nadirleri yak', pt: 'Queimar todos incomuns' },
  seasonBurnAllConfirm:  { ru: 'Сжечь {n} предметов и получить {p} очков? Отменить будет нельзя.', en: 'Burn {n} items for {p} points? This cannot be undone.', uk: 'Спалити {n} предметів і отримати {p} очок? Скасувати не вийде.', es: '¿Quemar {n} objetos por {p} puntos? No se puede deshacer.', tr: '{n} eşyayı {p} puan için yak? Geri alınamaz.', pt: 'Queimar {n} itens por {p} pontos? Não dá para desfazer.' },
  seasonBurnedToast: { ru: 'Сожжено: {n} · +{p} очков', en: 'Burned: {n} · +{p} points', uk: 'Спалено: {n} · +{p} очок', es: 'Quemados: {n} · +{p} puntos', tr: 'Yakıldı: {n} · +{p} puan', pt: 'Queimados: {n} · +{p} pontos' },
  seasonNothingToBurn: { ru: 'Нечего сжигать', en: 'Nothing to burn', uk: 'Нема чого спалювати', es: 'Nada que quemar', tr: 'Yakacak bir şey yok', pt: 'Nada para queimar' },
  seasonNoPlayers: { ru: 'Пока никто не набрал очков', en: 'Nobody has scored yet', uk: 'Поки ніхто не набрав очок', es: 'Nadie ha puntuado aún', tr: 'Henüz kimse puan almadı', pt: 'Ninguém pontuou ainda' },
  seasonPrizesHdr: { ru: 'Награды сезона:', en: 'Season prizes:', uk: 'Нагороди сезону:', es: 'Premios de temporada:', tr: 'Sezon ödülleri:', pt: 'Prêmios da temporada:' },
  seasonPlaceFmt: { ru: '{n} место', en: 'Place {n}', uk: '{n} місце', es: 'Puesto {n}', tr: '{n}. sıra', pt: '{n}º lugar' },

  // ── Страх (Fear): private wave-survival instance ──────────────────────────
  fearTab:      { ru: 'Страх', en: 'Fear', uk: 'Страх', es: 'Miedo', tr: 'Korku', pt: 'Medo' },
  fearLbl:      { ru: 'Страх', en: 'Fear', uk: 'Страх', es: 'Miedo', tr: 'Korku', pt: 'Medo' },
  fearPhaseIdle:{ ru: 'Войдите, чтобы начать', en: 'Enter to begin', uk: 'Увійдіть, щоб почати', es: 'Entra para empezar', tr: 'Başlamak için gir', pt: 'Entre para começar' },
  fearPhaseFighting: { ru: 'Волна {wave}/{max}', en: 'Wave {wave}/{max}', uk: 'Хвиля {wave}/{max}', es: 'Oleada {wave}/{max}', tr: 'Dalga {wave}/{max}', pt: 'Onda {wave}/{max}' },
  fearPhaseReady: { ru: 'Приготовьтесь...', en: 'Get ready...', uk: 'Приготуйтеся...', es: 'Prepárate...', tr: 'Hazır ol...', pt: 'Prepare-se...' },
  fearFreezeLbl: { ru: 'Монстры появятся через', en: 'Monsters arrive in', uk: 'Монстри з\'являться через', es: 'Los monstruos llegan en', tr: 'Canavarlar geliyor', pt: 'Monstros chegam em' },
  fearInRunBtn: { ru: 'В бою', en: 'Fighting', uk: 'У бою', es: 'En combate', tr: 'Savaşta', pt: 'Em combate' },
  fearEnterBtn: { ru: 'Войти', en: 'Enter', uk: 'Увійти', es: 'Entrar', tr: 'Gir', pt: 'Entrar' },
  fearWaveMsg:  { ru: 'Волна {wave} из {max}', en: 'Wave {wave} of {max}', uk: 'Хвиля {wave} з {max}', es: 'Oleada {wave} de {max}', tr: 'Dalga {wave}/{max}', pt: 'Onda {wave} de {max}' },
  fearClearedMsg: { ru: 'Все волны пройдены!', en: 'All waves cleared!', uk: 'Усі хвилі пройдено!', es: '¡Todas las oleadas superadas!', tr: 'Tüm dalgalar tamamlandı!', pt: 'Todas as ondas superadas!' },
  fearDiedMsg:  { ru: 'Вы погибли на волне {wave} из {max}', en: 'You died on wave {wave} of {max}', uk: 'Ви загинули на хвилі {wave} з {max}', es: 'Moriste en la oleada {wave} de {max}', tr: '{wave}/{max}. dalgada öldün', pt: 'Você morreu na onda {wave} de {max}' },
  fearRule1:    { ru: '{n} попытки в день, тратится при входе', en: '{n} attempts a day, spent on entry', uk: '{n} спроби на день, витрачається при вході', es: '{n} intentos al día, se gasta al entrar', tr: 'Günde {n} hak, girişte harcanır', pt: '{n} tentativas por dia, gasta ao entrar' },
  fearRule2:    { ru: 'Монстры приходят волнами по 20, уровень волны растёт с каждой', en: 'Monsters arrive in waves of 20, the level rising with every wave', uk: 'Монстри приходять хвилями по 20, рівень хвилі зростає з кожною', es: 'Los monstruos llegan en oleadas de 20, subiendo de nivel en cada una', tr: 'Canavarlar her dalgada seviyesi artan 20\'şer kişilik gruplar halinde gelir', pt: 'Monstros chegam em ondas de 20, com o nível subindo a cada onda' },
  fearRule3:    { ru: 'Дойдите до волны {n}, чтобы пройти испытание целиком', en: 'Reach wave {n} to clear the whole gauntlet', uk: 'Дійдіть до хвилі {n}, щоб пройти випробування повністю', es: 'Llega a la oleada {n} para superar todo el desafío', tr: 'Tüm bu zorlu sınavı tamamlamak için {n}. dalgaya ulaş', pt: 'Chegue à onda {n} para vencer o desafio inteiro' },
  fearRule4:    { ru: 'Смерть выбрасывает из подземелья в центральный зал', en: 'Dying kicks you out of the dungeon, back to the central hall', uk: 'Смерть викидає з підземелля до центрального залу', es: 'Morir te expulsa de la mazmorra, de vuelta al salón central', tr: 'Ölmek seni zindandan atıp merkez salona geri gönderir', pt: 'Morrer te expulsa da masmorra, de volta ao salão central' },
  fearRule5:    { ru: 'Опыт с монстров увеличен в 10 раз', en: 'XP from monsters is multiplied by 10', uk: 'Досвід з монстрів збільшено у 10 разів', es: 'La XP de los monstruos se multiplica por 10', tr: 'Canavarlardan gelen tecrübe 10 kat artırıldı', pt: 'XP dos monstros multiplicada por 10' },

  // ── Сотрудничество (Coop): 2-player-only synchronized instance ───────────
  coopTab: { ru: 'Сотрудничество', en: 'Coop' },
  coopLbl: { ru: 'Сотрудничество', en: 'Coop' },
  coopPhaseFighting: { ru: 'Этап {stage}/{max}', en: 'Stage {stage}/{max}' },
  coopPhaseReady: { ru: 'Приготовьтесь...', en: 'Get ready...' },
  coopPhaseLeaderLbl: { ru: 'Ваша группа', en: 'Your group' },
  coopPhaseMemberLbl: { ru: 'Вы в группе', en: 'In a group' },
  coopFreezeLbl: { ru: 'Монстры появятся через', en: 'Monsters arrive in' },
  coopStageMsg: { ru: 'Этап {stage} из {max}', en: 'Stage {stage} of {max}' },
  coopWaitingPartnerMsg: { ru: 'Ваш коридор зачищен — ждём напарника', en: 'Your corridor is clear — waiting for your partner' },
  coopBossSpawnedMsg: { ru: 'Оба зачистили! Появился босс', en: 'Both cleared! The boss has appeared' },
  coopBossWonMsg: { ru: 'Босс повержен! Вам достались награда', en: 'Boss defeated! You got the reward' },
  coopBossLostMsg: { ru: 'Босс повержен! Награда досталась напарнику', en: 'Boss defeated! Your partner got the reward' },
  coopClearedMsg: { ru: 'Подземелье пройдено!', en: 'Dungeon cleared!' },
  coopDiedMsg: { ru: 'Забег прерван — кто-то из вас погиб', en: 'Run ended — one of you died' },
  coopRule1: { ru: 'Создайте группу или войдите в чужую — начать забег может только лидер группы', en: 'Create a group or join someone else’s — only the group leader can start the run' },
  coopCreateGroupBtn: { ru: 'Создать группу', en: 'Create group' },
  coopJoinBtn: { ru: 'Войти', en: 'Join' },
  coopStartBtn: { ru: 'Начать', en: 'Start' },
  coopKickBtn: { ru: 'Изгнать', en: 'Kick' },
  coopDisbandBtn: { ru: 'Расформировать группу', en: 'Disband group' },
  coopLeaveGroupBtn: { ru: 'Покинуть группу', en: 'Leave group' },
  coopYouTag: { ru: 'вы', en: 'you' },
  coopLeaderTag: { ru: 'лидер', en: 'leader' },
  coopSlotOpenLbl: { ru: 'место свободно', en: 'slot open' },
  coopWaitingMemberLbl: { ru: 'Ждём участника...', en: 'Waiting for a member...' },
  coopWaitingLeaderLbl: { ru: 'Ждём, когда лидер начнёт', en: 'Waiting for the leader to start' },
  coopNoGroupsLbl: { ru: 'Открытых групп пока нет', en: 'No open groups yet' },
  coopGroupKickedMsg: { ru: 'Лидер исключил вас из группы', en: 'The leader kicked you from the group' },
  coopGroupDissolvedMsg: { ru: 'Группа распущена', en: 'The group was disbanded' },
  coopRule2: { ru: '8 этапов по 40 монстров, уровень растёт: 10, 15, 20, 25, 30, 40, 50, 60', en: '8 stages of 40 monsters, level rising: 10, 15, 20, 25, 30, 40, 50, 60' },
  coopRule3: { ru: 'Следующий этап открывается, только когда оба игрока зачистят текущий', en: 'The next stage opens only once both players clear the current one' },
  coopRule4: { ru: 'В конце — общий босс 40 уровня: 1 безопасный камень заточки и 100 Liberty одному случайному игроку', en: 'At the end — a shared level-40 boss: 1 safe enchant stone and 100 Liberty to one random player' },
  coopRule5: { ru: 'Смерть любого из двоих завершает забег для обоих', en: "Either player's death ends the run for both" },

  farm2Tab: { ru: 'Элитная фарм-зона', en: 'Elite Farm Zone' },
  eventSubFarm2: { ru: 'Группа из 3', en: 'Party of 3' },
  eventSchedFarm2: { ru: '120 мин/день', en: '120 min/day' },
  farm2Lbl: { ru: 'Элитная фарм-зона', en: 'Elite Farm Zone' },
  farm2NoTimeLbl: { ru: 'Время на сегодня закончилось', en: 'Out of time for today' },
  farm2MinutesFmt: { ru: '{n}/{max} мин', en: '{n}/{max} min' },
  farm2GroupKickedMsg: { ru: 'Лидер исключил вас из группы', en: 'The leader kicked you from the group' },
  farm2GroupDissolvedMsg: { ru: 'Группа распущена', en: 'The group was disbanded' },
  farm2TimeCapMsg: { ru: 'Дневной лимит времени в зоне исчерпан', en: "You've hit today's time limit in the zone" },
  farm2PartyBrokenMsg: { ru: 'В зоне осталось меньше 3 человек из группы — все выведены', en: 'Fewer than 3 of the party are still in the zone — everyone was pulled out' },
  farm2Rule1: { ru: 'Вход с {n} уровня, только полной группой из 3 человек', en: 'Entry from level {n}, only as a full party of 3' },
  farm2Rule2: { ru: 'Войти в зону может только лидер группы — он затягивает за собой остальных участников (группа из {n} человек)', en: 'Only the group leader can start the run — everyone else is pulled in with them (a party of {n})' },
  farm2Rule3: { ru: 'Если в зоне останется меньше 3 человек группы, всех выводит из зоны', en: 'If fewer than 3 of the party are still in the zone, everyone is pulled out' },
  farm2Rule4: { ru: '2 комнаты по 50 монстров, сильнее обычных и вдвое быстрее — стоят пачками по 4, сами не нападают, но удар по одному будит всю пачку', en: '2 rooms of 50 monsters each, stronger than ordinary ones and twice as fast — standing in packs of 4, they never attack first, but hitting one wakes the whole pack' },
  farm2Rule5: { ru: 'Не более {n} минут в зоне на игрока в день', en: 'Up to {n} minutes in the zone per player per day' },
  farm2DropHdr: { ru: 'Дроп с монстров', en: 'Monster drops' },
  libertyLbl: { ru: 'Liberty', en: 'Liberty' },

  wbPhaseAlive: { ru: 'Босс на карте', en: 'Boss is on the map', uk: 'Бос на карті', es: 'El jefe está en el mapa', tr: 'Patron haritada', pt: 'O chefe está no mapa' },
  wbPhaseSummon:{ ru: 'До появления босса', en: 'Boss appears in', uk: 'До появи боса', es: 'El jefe aparece en', tr: 'Patron geliyor', pt: 'O chefe aparece em' },
  wbPhaseIdle:  { ru: 'До следующего босса', en: 'Next boss in', uk: 'До наступного боса', es: 'Próximo jefe en', tr: 'Sonraki patrona', pt: 'Próximo chefe em' },
  wbNoteAlive:  { ru: 'Он в безопасной зоне — добычу заберут без тебя', en: 'He is in the safe zone — the loot will go without you', uk: 'Він у безпечній зоні — здобич заберуть без тебе', es: 'Está en la zona segura: el botín se irá sin ti', tr: 'Güvenli bölgede — ganimeti sensiz alırlar', pt: 'Ele está na zona segura — o loot vai sem você' },
  wbNoteSummon: { ru: 'Босс уже вызван — идёт отсчёт', en: 'Already summoned — counting down', uk: 'Боса вже викликано — триває відлік', es: 'Ya invocado: cuenta atrás', tr: 'Çağrıldı — geri sayım sürüyor', pt: 'Já invocado — contagem regressiva' },
  wbScheduleHdr:{ ru: 'Расписание:', en: 'Schedule:', uk: 'Розклад:', es: 'Horario:', tr: 'Program:', pt: 'Programação:' },
  wbRule1:      { ru: 'Понедельник, среда, пятница, воскресенье — в 20:00 по Москве', en: 'Monday, Wednesday, Friday, Sunday at 20:00 Moscow time', uk: 'Понеділок, середа, п’ятниця, неділя — о 20:00 за Москвою', es: 'Lunes, miércoles, viernes y domingo a las 20:00 hora de Moscú', tr: 'Pazartesi, çarşamba, cuma, pazar 20:00 Moskova saati', pt: 'Segunda, quarta, sexta e domingo às 20:00 horário de Moscou' },
  wbRule2:      { ru: 'Появляется в безопасной зоне — драться может каждый', en: 'Spawns in the safe zone — anyone can fight him', uk: 'З’являється в безпечній зоні — битися може кожен', es: 'Aparece en la zona segura: cualquiera puede luchar', tr: 'Güvenli bölgede doğar — herkes dövüşebilir', pt: 'Aparece na zona segura — qualquer um pode lutar' },
  wbRule3:      { ru: 'Добыча падает на пол для всех: кто успел, тот забрал', en: 'Loot drops on the floor for everyone — first come, first served', uk: 'Здобич падає на підлогу для всіх: хто встиг, той забрав', es: 'El botín cae al suelo para todos: quien llega primero se lo lleva', tr: 'Ganimet herkes için yere düşer: kapan alır', pt: 'O loot cai no chão para todos: quem chegar primeiro leva' },
  wbRewardsHdr: { ru: 'Полный дроп с одного убийства:', en: 'Full drop from one kill:', uk: 'Повний дроп з одного вбивства:', es: 'Botín completo de una muerte:', tr: 'Tek öldürmeden tam ganimet:', pt: 'Loot completo de uma morte:' },
  wbDropUncommonArmor: { ru: 'Случайная uncommon броня', en: 'Random uncommon armor piece', uk: 'Випадкова uncommon броня', es: 'Pieza de armadura uncommon aleatoria', tr: 'Rastgele uncommon zırh parçası', pt: 'Peça de armadura uncommon aleatória' },
  wbDropUncommonWeapon: { ru: 'Случайное uncommon оружие', en: 'Random uncommon weapon', uk: 'Випадкова uncommon зброя', es: 'Arma uncommon aleatoria', tr: 'Rastgele uncommon silah', pt: 'Arma uncommon aleatória' },
  wbDropCommonItems: { ru: 'Случайные common предметы', en: 'Random common items', uk: 'Випадкові common предмети', es: 'Objetos common aleatorios', tr: 'Rastgele common eşyalar', pt: 'Itens common aleatórios' },

  dbBtn:        { ru: 'Битва', en: 'Battle', uk: 'Битва', es: 'Batalla', tr: 'Savaş', pt: 'Batalha' },
  dbBtnOpen:    { ru: 'Битва · набор!', en: 'Battle · open!', uk: 'Битва · набір!', es: '¡Batalla · abierta!', tr: 'Savaş · kayıt!', pt: 'Batalha · aberta!' },
  dbPhaseReg:   { ru: 'До начала битвы', en: 'Battle starts in', uk: 'До початку битви', es: 'La batalla empieza en', tr: 'Savaşa kalan', pt: 'A batalha começa em' },
  dbPhaseIdle:  { ru: 'До следующей битвы', en: 'Next battle in', uk: 'До наступної битви', es: 'Próxima batalla en', tr: 'Sonraki savaşa', pt: 'Próxima batalha em' },
  dbPhaseLive:  { ru: 'Битва идёт', en: 'Battle in progress', uk: 'Битва триває', es: 'Batalla en curso', tr: 'Savaş sürüyor', pt: 'Batalha em andamento' },
  dbJoinBtn:    { ru: 'Записаться', en: 'Sign up', uk: 'Записатися', es: 'Inscribirse', tr: 'Kaydol', pt: 'Inscrever-se' },
  dbLeaveBtn:   { ru: 'Отменить запись', en: 'Cancel sign-up', uk: 'Скасувати запис', es: 'Cancelar inscripción', tr: 'Kaydı iptal et', pt: 'Cancelar inscrição' },
  dbClosedBtn:  { ru: 'Регистрация закрыта', en: 'Registration closed', uk: 'Реєстрацію закрито', es: 'Inscripción cerrada', tr: 'Kayıt kapalı', pt: 'Inscrição encerrada' },
  dbSignedUpFmt:{ ru: 'Записалось: {n}', en: 'Signed up: {n}', uk: 'Записалось: {n}', es: 'Inscritos: {n}', tr: 'Kayıtlı: {n}', pt: 'Inscritos: {n}' },
  dbAliveFmt:   { ru: 'В живых: {n}', en: 'Alive: {n}', uk: 'Живих: {n}', es: 'Vivos: {n}', tr: 'Hayatta: {n}', pt: 'Vivos: {n}' },
  dbRulesHdr:   { ru: 'Правила:', en: 'Rules:', uk: 'Правила:', es: 'Reglas:', tr: 'Kurallar:', pt: 'Regras:' },
  dbRule1:      { ru: 'Вторник, четверг, суббота — в 10:00 по Москве', en: 'Tuesday, Thursday, Saturday at 10:00 Moscow time', uk: 'Вівторок, четвер, субота — о 10:00 за Москвою', es: 'Martes, jueves y sábado a las 10:00 hora de Moscú', tr: 'Salı, perşembe, cumartesi 10:00 Moskova saati', pt: 'Terça, quinta e sábado às 10:00 horário de Moscou' },
  dbRule2:      { ru: 'Регистрация открыта за 5 минут до начала', en: 'Registration opens 5 minutes before the start', uk: 'Реєстрація відкрита за 5 хвилин до початку', es: 'La inscripción abre 5 minutos antes', tr: 'Kayıt başlamadan 5 dakika önce açılır', pt: 'A inscrição abre 5 minutos antes' },
  dbRule3:      { ru: 'Всех переносит на арену с включённым ПК', en: 'Everyone is moved to the arena with PvP on', uk: 'Усіх переносить на арену з увімкненим ПК', es: 'Todos van a la arena con PvP activado', tr: 'Herkes PvP açık şekilde arenaya taşınır', pt: 'Todos vão para a arena com PvP ligado' },
  dbRule5:      { ru: 'Первые 30 секунд никто не может двигаться', en: 'Nobody can move for the first 30 seconds', uk: 'Перші 30 секунд ніхто не може рухатися', es: 'Nadie puede moverse durante los primeros 30 segundos', tr: 'İlk 30 saniye kimse hareket edemez', pt: 'Ninguém pode se mover nos primeiros 30 segundos' },
  dbRule4:      { ru: 'Последний выживший забирает награду', en: 'The last survivor takes the prize', uk: 'Останній вцілілий забирає нагороду', es: 'El último superviviente se lleva el premio', tr: 'Son hayatta kalan ödülü alır', pt: 'O último sobrevivente leva o prêmio' },
  dbRewardsHdr: { ru: 'Награда победителю:', en: 'Winner takes:', uk: 'Нагорода переможцю:', es: 'El ganador se lleva:', tr: 'Kazananın ödülü:', pt: 'O vencedor leva:' },
  dbFreezeLbl:  { ru: 'Приготовьтесь', en: 'Get ready', uk: 'Приготуйтеся', es: 'Prepárate', tr: 'Hazır ol', pt: 'Prepare-se' },
  dbFightMsg:   { ru: '⚔️ БОЙ!', en: '⚔️ FIGHT!', uk: '⚔️ БІЙ!', es: '⚔️ ¡LUCHA!', tr: '⚔️ SAVAŞ!', pt: '⚔️ LUTEM!' },
  dbArenaLbl:   { ru: 'Арена битвы', en: 'Battle arena', uk: 'Арена битви', es: 'Arena de batalla', tr: 'Savaş arenası', pt: 'Arena de batalha' },
  dbStartedFmt: { ru: '⚔️ Битва началась! Бойцов: {n}', en: '⚔️ The battle has begun! Fighters: {n}', uk: '⚔️ Битва почалася! Бійців: {n}', es: '⚔️ ¡La batalla ha comenzado! Luchadores: {n}', tr: '⚔️ Savaş başladı! Dövüşçüler: {n}', pt: '⚔️ A batalha começou! Lutadores: {n}' },
  dbEliminatedFmt: { ru: '💀 Вы выбыли. Осталось: {n}', en: '💀 You are out. Remaining: {n}', uk: '💀 Ви вибули. Залишилось: {n}', es: '💀 Estás fuera. Quedan: {n}', tr: '💀 Elendiniz. Kalan: {n}', pt: '💀 Você está fora. Restam: {n}' },
  dbCancelledMsg: { ru: 'Битва отменена — мало участников', en: 'Battle cancelled — not enough players', uk: 'Битву скасовано — мало учасників', es: 'Batalla cancelada: pocos jugadores', tr: 'Savaş iptal edildi — yeterli oyuncu yok', pt: 'Batalha cancelada — poucos jogadores' },
  dbSignedUpToast: { ru: '⚔️ Вы записаны на битву', en: '⚔️ You are signed up', uk: '⚔️ Вас записано на битву', es: '⚔️ Estás inscrito', tr: '⚔️ Kaydoldunuz', pt: '⚔️ Você está inscrito' },
  dbLeftToast:  { ru: 'Запись на битву отменена', en: 'Sign-up cancelled', uk: 'Запис на битву скасовано', es: 'Inscripción cancelada', tr: 'Kayıt iptal edildi', pt: 'Inscrição cancelada' },
  dbPvpLockedToast: { ru: 'В битве ПК отключить нельзя', en: 'PvP cannot be turned off in a battle', uk: 'У битві ПК вимкнути не можна', es: 'No puedes desactivar PvP en la batalla', tr: 'Savaşta PvP kapatılamaz', pt: 'Não é possível desligar o PvP na batalha' },
  dbWinTitle:   { ru: 'ПОБЕДА', en: 'VICTORY', uk: 'ПЕРЕМОГА', es: 'VICTORIA', tr: 'ZAFER', pt: 'VITÓRIA' },
  dbWinSub:     { ru: 'Вы последний выживший', en: 'You are the last survivor', uk: 'Ви останній вцілілий', es: 'Eres el último superviviente', tr: 'Son hayatta kalansın', pt: 'Você é o último sobrevivente' },
  dbWinClose:   { ru: 'Забрать награду', en: 'Claim reward', uk: 'Забрати нагороду', es: 'Reclamar recompensa', tr: 'Ödülü al', pt: 'Receber recompensa' },
  dbReturnPrevLbl: { ru: 'Прежнее место', en: 'Previous spot', uk: 'Попереднє місце', es: 'Lugar anterior', tr: 'Önceki konum', pt: 'Local anterior' },
  langPickerHint:    { ru: 'Изменения применяются сразу', en: 'Changes apply immediately', uk: 'Зміни застосовуються одразу', es: 'Los cambios se aplican de inmediato', tr: 'Değişiklikler hemen uygulanır', pt: 'As alterações se aplicam imediatamente' },

  // ── Character select ──
  csBadgeMelee:  { ru: 'Ближний бой', en: 'Melee', uk: 'Ближній бій', es: 'Cuerpo a Cuerpo', tr: 'Yakın Dövüş', pt: 'Corpo a Corpo' },
  csBadgeRanged: { ru: 'Дальний бой', en: 'Ranged', uk: 'Дальній бій', es: 'A Distancia', tr: 'Menzilli', pt: 'À Distância' },
  csBadgeSupport:{ ru: 'Поддержка', en: 'Support', uk: 'Підтримка', es: 'Soporte', tr: 'Destek', pt: 'Suporte' },
  csCooldown:    { ru: 'Кулдаун', en: 'Cooldown', uk: 'Перезарядка', es: 'Reutilización', tr: 'Bekleme Süresi', pt: 'Recarga' },
  csCooldownSec: { ru: 'сек', en: 's', uk: 'сек', es: 's', tr: 'sn', pt: 's' },
  csContinue:    { ru: 'Продолжить', en: 'Continue', uk: 'Продовжити', es: 'Continuar', tr: 'Devam Et', pt: 'Continuar' },
  csCreateChar:  { ru: 'Создать персонажа', en: 'Create Character', uk: 'Створити персонажа', es: 'Crear Personaje', tr: 'Karakter Oluştur', pt: 'Criar Personagem' },
  csLoadingSprites: { ru: 'Загрузка спрайтов...', en: 'Loading sprites...', uk: 'Завантаження спрайтів...', es: 'Cargando sprites...', tr: 'Sprite\'lar yükleniyor...', pt: 'Carregando sprites...' },
  csWaitingServer:  { ru: 'Ожидание сервера...', en: 'Waiting for server...', uk: 'Очікування сервера...', es: 'Esperando al servidor...', tr: 'Sunucu bekleniyor...', pt: 'Aguardando o servidor...' },
  csStarting:       { ru: 'Запуск!', en: 'Starting!', uk: 'Запуск!', es: '¡Iniciando!', tr: 'Başlatılıyor!', pt: 'Iniciando!' },

  // ── Quests ──
  questCompleteToast: { ru: 'Квест выполнен!', en: 'Quest complete!', uk: 'Квест виконано!', es: '¡Misión completada!', tr: 'Görev tamamlandı!', pt: 'Missão concluída!' },
  questSpecialCompleteToast: { ru: 'Специальный квест выполнен!', en: 'Special quest complete!', uk: 'Спеціальний квест виконано!', es: '¡Misión especial completada!', tr: 'Özel görev tamamlandı!', pt: 'Missão especial concluída!' },
  questLevelLbl: { ru: 'Уровень', en: 'Level', uk: 'Рівень', es: 'Nivel', tr: 'Seviye', pt: 'Nível' },
  questLoading: { ru: 'Загрузка...', en: 'Loading...', uk: 'Завантаження...', es: 'Cargando...', tr: 'Yükleniyor...', pt: 'Carregando...' },
  questNoSpecial: { ru: 'Специальных квестов пока нет', en: 'No special quests yet', uk: 'Спеціальних квестів поки немає', es: 'Aún no hay misiones especiales', tr: 'Henüz özel görev yok', pt: 'Ainda não há missões especiais' },
  questDoneCheck: { ru: 'Выполнено', en: 'Done', uk: 'Виконано', es: 'Completado', tr: 'Tamamlandı', pt: 'Concluído' },
  questSending: { ru: 'Отправка...', en: 'Sending...', uk: 'Надсилання...', es: 'Enviando...', tr: 'Gönderiliyor...', pt: 'Enviando...' },
  questTypeSubscribe: { ru: 'Подписаться', en: 'Subscribe', uk: 'Підписатися', es: 'Suscribirse', tr: 'Abone Ol', pt: 'Inscrever-se' },
  questTypeLink: { ru: 'Перейти', en: 'Go', uk: 'Перейти', es: 'Ir', tr: 'Git', pt: 'Ir' },
  questTypeDo: { ru: 'Выполнить', en: 'Complete', uk: 'Виконати', es: 'Completar', tr: 'Tamamla', pt: 'Completar' },
  questClaimReward: { ru: 'Забрать награду', en: 'Claim Reward', uk: 'Забрати нагороду', es: 'Reclamar Recompensa', tr: 'Ödülü Al', pt: 'Resgatar Recompensa' },
  questBoughtSuffix: { ru: 'куплено', en: 'bought', uk: 'куплено', es: 'comprado', tr: 'satın alındı', pt: 'comprado' },
  questTimesSuffix: { ru: 'раз', en: 'times', uk: 'разів', es: 'veces', tr: 'kez', pt: 'vezes' },
  questJoinGuildBtn: { ru: 'Вступить в гильдию', en: 'Join the Clan', uk: 'Вступити до клану', es: 'Únete al Clan', tr: 'Klana Katıl', pt: 'Entrar no Clã' },
  questReachCorridor: { ru: 'Дойди до монстров уровня {lvl}+ в коридоре', en: 'Reach level {lvl}+ monsters in the corridor', uk: 'Дійди до монстрів рівня {lvl}+ у коридорі', es: 'Llega a monstruos de nivel {lvl}+ en el corredor', tr: 'Koridorda seviye {lvl}+ canavarlara ulaş', pt: 'Chegue a monstros de nível {lvl}+ no corredor' },
  questVisitBlacksmith: { ru: 'Зайди к кузнецу', en: 'Visit the blacksmith', uk: 'Завітай до коваля', es: 'Visita al herrero', tr: 'Demirciye git', pt: 'Visite o ferreiro' },
  questEnterFarmZone: { ru: 'Зайди в Фарм-зону через портал в Зале', en: 'Enter the Farm Zone through the hub portal', uk: 'Зайди у Ферм-зону через портал у Залі', es: 'Entra en la Zona de Farmeo a través del portal del vestíbulo', tr: 'Lobi portalından Çiftlik Bölgesi\'ne gir', pt: 'Entre na Zona de Farm pelo portal do hub' },
  questFloorLbl: { ru: 'Этаж', en: 'Floor', uk: 'Поверх', es: 'Piso', tr: 'Kat', pt: 'Andar' },
  questCompletedSuffix: { ru: 'выполнено', en: 'done', uk: 'виконано', es: 'completado', tr: 'tamamlandı', pt: 'concluído' },
  tabSkillsActive:  { ru: 'Активные',   en: 'Active',   uk: 'Активні',      es: 'Activas',     tr: 'Aktif',       pt: 'Ativas' },
  tabSkillsPassive: { ru: 'Пассивные',  en: 'Passive',  uk: 'Пасивні',      es: 'Pasivas',     tr: 'Pasif',       pt: 'Passivas' },
  tabQuestStory:    { ru: 'Сюжетный',   en: 'Story',    uk: 'Сюжетний',     es: 'Historia',    tr: 'Hikaye',      pt: 'História' },
  tabQuestSpecial:  { ru: 'Специальный',en: 'Special',  uk: 'Спеціальний',  es: 'Especial',    tr: 'Özel',        pt: 'Especial' },

  // ── NPC dialogs (merchant/blacksmith/storage) ──
  npcGoldLbl:      { ru: 'Золото', en: 'Gold', uk: 'Золото', es: 'Oro', tr: 'Altın', pt: 'Ouro' },
  npcHpPotionsLbl: { ru: 'Зелий HP', en: 'HP Potions', uk: 'Зіль HP', es: 'Pociones HP', tr: 'HP İksirleri', pt: 'Poções de HP' },
  npcHealPotionsHdr: { ru: 'Зелья лечения', en: 'Healing Potions', uk: 'Зілля лікування', es: 'Pociones Curativas', tr: 'İyileştirme İksirleri', pt: 'Poções de Cura' },
  npcQtyHdr:   { ru: 'Сколько покупать', en: 'How many to buy', uk: 'Скільки купувати', es: 'Cuántas comprar', tr: 'Kaç tane alınacak', pt: 'Quantas comprar' },
  npcQtyMax:   { ru: 'Макс', en: 'Max', uk: 'Макс', es: 'Máx', tr: 'Maks', pt: 'Máx' },
  npcNotEnoughGold: { ru: 'Мало золота!', en: 'Not enough gold!', uk: 'Мало золота!', es: '¡Oro insuficiente!', tr: 'Yeterli altın yok!', pt: 'Ouro insuficiente!' },
  npcMaxPotions:    { ru: 'Максимум 999 зелий!', en: 'Maximum 999 potions!', uk: 'Максимум 999 зіль!', es: '¡Máximo 999 pociones!', tr: 'En fazla 999 iksir!', pt: 'Máximo de 999 poções!' },
  npcBoughtPrefix:  { ru: '✓ Куплено: ', en: '✓ Bought: ', uk: '✓ Куплено: ', es: '✓ Comprado: ', tr: '✓ Satın alındı: ', pt: '✓ Comprado: ' },
  npcNone:          { ru: 'нет', en: 'none', uk: 'немає', es: 'ninguno', tr: 'yok', pt: 'nenhum' },
  craftTabItems:    { ru: 'Предметы', en: 'Items', uk: 'Предмети', es: 'Objetos', tr: 'Eşyalar', pt: 'Itens' },
  craftTabMats:     { ru: 'Материалы', en: 'Materials', uk: 'Матеріали', es: 'Materiales', tr: 'Malzemeler', pt: 'Materiais' },
  craftRecipesPrefix: { ru: 'Рецепты: ', en: 'Recipes: ', uk: 'Рецепти: ', es: 'Recetas: ', tr: 'Tarifler: ', pt: 'Receitas: ' },
  craftRecipesHdr:  { ru: 'Рецепты', en: 'Recipes', uk: 'Рецепти', es: 'Recetas', tr: 'Tarifler', pt: 'Receitas' },
  craftBoxesHdr:    { ru: 'Боксы', en: 'Boxes', uk: 'Бокси', es: 'Cajas', tr: 'Kutular', pt: 'Caixas' },
  craftAdvBooksHdr: { ru: 'Книги 2 профессии', en: 'Advanced skill books', uk: 'Книги 2 професії', es: 'Libros de 2ª profesión', tr: '2. Meslek Kitapları', pt: 'Livros da 2ª profissão' },
  craftAdvBookRandom: { ru: 'Случайная книга', en: 'Random book', uk: 'Випадкова книга', es: 'Libro aleatorio', tr: 'Rastgele kitap', pt: 'Livro aleatório' },
  craftAnySkillBook: { ru: 'Любые книги навыков', en: 'Any skill books', uk: 'Будь-які книги навичок', es: 'Cualquier libro de habilidad', tr: 'Herhangi bir yetenek kitabı', pt: 'Quaisquer livros de habilidade' },
  craftPetsHdr:     { ru: 'Питомцы', en: 'Pets', uk: 'Улюбленці', es: 'Mascotas', tr: 'Evcil Hayvanlar', pt: 'Mascotes' },
  craftClassGearHdr: { ru: 'Плащи и артефакты классов', en: 'Class Cloaks & Artifacts', uk: 'Плащі та артефакти класів', es: 'Capas y Artefactos de Clase', tr: 'Sınıf Pelerinleri ve Eserleri', pt: 'Capas e Artefatos de Classe' },
  craftPetPickOneOf: { ru: 'Один случайный из 3', en: 'One random of 3', uk: 'Один випадковий з 3', es: 'Uno al azar de 3', tr: '3 üzerinden rastgele biri', pt: 'Um aleatório entre 3' },
  craftPickOneOfN: { ru: 'Один случайный из {n}', en: 'One random of {n}', uk: 'Один випадковий з {n}', es: 'Uno al azar de {n}', tr: '{n} üzerinden rastgele biri', pt: 'Um aleatório entre {n}' },
  craftCommonItemLbl:   { ru: 'Обычный предмет',   en: 'Common item',   uk: 'Звичайний предмет',   es: 'Objeto común',     tr: 'Sıradan eşya',    pt: 'Item comum' },
  craftUncommonItemLbl: { ru: 'Необычный предмет', en: 'Uncommon item', uk: 'Незвичайний предмет', es: 'Objeto poco común', tr: 'Nadir olmayan eşya', pt: 'Item incomum' },
  craftPetTapHint: { ru: 'Нажмите на питомца — увидите характеристики', en: 'Tap a pet to see its stats', uk: 'Натисніть на улюбленця — побачите характеристики', es: 'Toca una mascota para ver sus estadísticas', tr: 'Özelliklerini görmek için bir evcil hayvana dokun', pt: 'Toque em um mascote para ver seus atributos' },
  rarityGroupUncommon:  { ru: 'Необычные',   en: 'Uncommon',   uk: 'Незвичайні',   es: 'Poco Comunes', tr: 'Nadir Olmayanlar', pt: 'Incomuns' },
  rarityGroupRare:      { ru: 'Редкие',      en: 'Rare',       uk: 'Рідкісні',     es: 'Raros',        tr: 'Nadirler',          pt: 'Raros' },
  rarityGroupEpic:      { ru: 'Эпические',   en: 'Epic',       uk: 'Епічні',       es: 'Épicos',       tr: 'Efsanevi Öncesi',   pt: 'Épicos' },
  rarityGroupLegendary: { ru: 'Легендарные', en: 'Legendary',  uk: 'Легендарні',   es: 'Legendarios',  tr: 'Efsaneler',         pt: 'Lendários' },
  craftBackBtn:     { ru: '← Назад', en: '← Back', uk: '← Назад', es: '← Atrás', tr: '← Geri', pt: '← Voltar' },
  craftRequiredLbl: { ru: 'Требуется:', en: 'Required:', uk: 'Потрібно:', es: 'Se requiere:', tr: 'Gerekli:', pt: 'Necessário:' },
  craftChanceLbl:   { ru: 'Шанс успеха: ', en: 'Success chance: ', uk: 'Шанс успіху: ', es: 'Probabilidad de éxito: ', tr: 'Başarı şansı: ', pt: 'Chance de sucesso: ' },
  craftDoBtn:       { ru: 'Крафтить', en: 'Craft', uk: 'Крафтити', es: 'Fabricar', tr: 'Üret', pt: 'Fabricar' },
  craftNotEnoughMats: { ru: 'Недостаточно материалов!', en: 'Not enough materials!', uk: 'Недостатньо матеріалів!', es: '¡Materiales insuficientes!', tr: 'Yeterli malzeme yok!', pt: 'Materiais insuficientes!' },
  craftFailMsg:     { ru: 'Провал! Материалы потеряны.', en: 'Failed! Materials lost.', uk: 'Провал! Матеріали втрачено.', es: '¡Fallo! Materiales perdidos.', tr: 'Başarısız! Malzemeler kayboldu.', pt: 'Falhou! Materiais perdidos.' },
  craftCreatedPrefix: { ru: '✓ Создано: ', en: '✓ Created: ', uk: '✓ Створено: ', es: '✓ Creado: ', tr: '✓ Oluşturuldu: ', pt: '✓ Criado: ' },
  craftReceivedPrefix: { ru: '✓ Получено: ', en: '✓ Received: ', uk: '✓ Отримано: ', es: '✓ Recibido: ', tr: '✓ Alındı: ', pt: '✓ Recebido: ' },
  craftBoxContentsLbl: { ru: 'Содержимое (1 предмет из бокса):', en: 'Contents (1 item from box):', uk: 'Вміст (1 предмет з боксу):', es: 'Contenido (1 objeto de la caja):', tr: 'İçindekiler (kutudan 1 eşya):', pt: 'Conteúdo (1 item da caixa):' },
  craftNotEnoughKeys: { ru: 'Недостаточно ключей!', en: 'Not enough keys!', uk: 'Недостатньо ключів!', es: '¡Llaves insuficientes!', tr: 'Yeterli anahtar yok!', pt: 'Chaves insuficientes!' },
  storageInvTab:    { ru: 'Инвентарь', en: 'Inventory', uk: 'Інвентар', es: 'Inventario', tr: 'Envanter', pt: 'Inventário' },
  storageStorageTab:{ ru: 'Хранилище', en: 'Storage', uk: 'Сховище', es: 'Almacén', tr: 'Depo', pt: 'Armazém' },
  storageInvEmpty:  { ru: 'Инвентарь пуст', en: 'Inventory is empty', uk: 'Інвентар порожній', es: 'El inventario está vacío', tr: 'Envanter boş', pt: 'O inventário está vazio' },
  storageEmpty:     { ru: 'Хранилище пусто', en: 'Storage is empty', uk: 'Сховище порожнє', es: 'El almacén está vacío', tr: 'Depo boş', pt: 'O armazém está vazio' },
  storageTapToStore:{ ru: 'Нажмите на предмет, чтобы положить в хранилище', en: 'Tap an item to store it', uk: 'Натисніть на предмет, щоб покласти у сховище', es: 'Toca un objeto para guardarlo', tr: 'Depolamak için bir eşyaya dokun', pt: 'Toque em um item para guardá-lo' },
  storageTapToTake: { ru: 'Нажмите на предмет, чтобы забрать', en: 'Tap an item to take it', uk: 'Натисніть на предмет, щоб забрати', es: 'Toca un objeto para recuperarlo', tr: 'Almak için bir eşyaya dokun', pt: 'Toque em um item para retirá-lo' },
  storageFull:      { ru: 'Хранилище полно!', en: 'Storage is full!', uk: 'Сховище повне!', es: '¡Almacén lleno!', tr: 'Depo dolu!', pt: 'Armazém cheio!' },
  invFull:          { ru: 'Инвентарь полон!', en: 'Inventory is full!', uk: 'Інвентар повний!', es: '¡Inventario lleno!', tr: 'Envanter dolu!', pt: 'Inventário cheio!' },

  // ── Clans ──
  clanNoClanTitle: { ru: 'У вас нет клана', en: "You don't have a clan", uk: 'У вас немає клану', es: 'No tienes clan', tr: 'Bir klanınız yok', pt: 'Você não tem um clã' },
  clanNoClanSub:   { ru: 'Создайте свой клан или найдите существующий', en: 'Create your own clan or find an existing one', uk: 'Створіть свій клан або знайдіть наявний', es: 'Crea tu propio clan o busca uno existente', tr: 'Kendi klanını kur ya da mevcut birine katıl', pt: 'Crie seu próprio clã ou encontre um existente' },
  clanCreateBtn:   { ru: '+ Создать клан', en: '+ Create Clan', uk: '+ Створити клан', es: '+ Crear Clan', tr: '+ Klan Oluştur', pt: '+ Criar Clã' },
  clanFindBtn:     { ru: 'Найти клан', en: 'Find Clan', uk: 'Знайти клан', es: 'Buscar Clan', tr: 'Klan Bul', pt: 'Buscar Clã' },
  clanBackBtn:     { ru: '← Назад', en: '← Back', uk: '← Назад', es: '← Atrás', tr: '← Geri', pt: '← Voltar' },
  clanCreateTitle: { ru: 'Создать клан', en: 'Create Clan', uk: 'Створити клан', es: 'Crear Clan', tr: 'Klan Oluştur', pt: 'Criar Clã' },
  clanCostLbl:     { ru: 'Стоимость', en: 'Cost', uk: 'Вартість', es: 'Costo', tr: 'Maliyet', pt: 'Custo' },
  clanNotEnough:   { ru: '(не хватает)', en: '(not enough)', uk: '(не вистачає)', es: '(insuficiente)', tr: '(yetersiz)', pt: '(insuficiente)' },
  clanNameLbl:     { ru: 'Название (до 10 символов)', en: 'Name (up to 10 characters)', uk: "Назва (до 10 символів)", es: 'Nombre (hasta 10 caracteres)', tr: 'İsim (en fazla 10 karakter)', pt: 'Nome (até 10 caracteres)' },
  clanNamePlaceholder: { ru: 'Название...', en: 'Name...', uk: 'Назва...', es: 'Nombre...', tr: 'İsim...', pt: 'Nome...' },
  clanIconLbl:     { ru: 'Иконка клана', en: 'Clan Icon', uk: 'Іконка клану', es: 'Ícono del Clan', tr: 'Klan Simgesi', pt: 'Ícone do Clã' },
  clanChangeBtn:   { ru: 'Изменить', en: 'Change', uk: 'Змінити', es: 'Cambiar', tr: 'Değiştir', pt: 'Alterar' },
  clanCreateSubmit:{ ru: 'Создать', en: 'Create', uk: 'Створити', es: 'Crear', tr: 'Oluştur', pt: 'Criar' },
  clanPickIconTitle:{ ru: 'Выбери иконку', en: 'Choose an Icon', uk: 'Обери іконку', es: 'Elige un Ícono', tr: 'Bir Simge Seç', pt: 'Escolha um Ícone' },
  clanEnterName:   { ru: 'Введите название', en: 'Enter a name', uk: 'Введіть назву', es: 'Ingresa un nombre', tr: 'Bir isim gir', pt: 'Digite um nome' },
  clanNeedGold:    { ru: 'Нужно {n} золота', en: 'Need {n} gold', uk: 'Потрібно {n} золота', es: 'Se necesitan {n} de oro', tr: '{n} altın gerekiyor', pt: 'Necessário {n} de ouro' },
  clanNotFound:    { ru: 'Кланы не найдены', en: 'No clans found', uk: 'Клани не знайдено', es: 'No se encontraron clanes', tr: 'Klan bulunamadı', pt: 'Nenhum clã encontrado' },
  clanLevelMembersFmt: { ru: 'Ур. {lvl} · {n} участников', en: 'Lvl. {lvl} · {n} members', uk: 'Рів. {lvl} · {n} учасників', es: 'Niv. {lvl} · {n} miembros', tr: 'Sv. {lvl} · {n} üye', pt: 'Nív. {lvl} · {n} membros' },
  clanJoinBtn:     { ru: 'Вступить', en: 'Join', uk: 'Вступити', es: 'Unirse', tr: 'Katıl', pt: 'Entrar' },
  clanApplySending:{ ru: 'Отправка...', en: 'Sending...', uk: 'Надсилання...', es: 'Enviando...', tr: 'Gönderiliyor...', pt: 'Enviando...' },
  clanApplySentBtn:{ ru: 'Отправлено', en: 'Sent', uk: 'Надіслано', es: 'Enviado', tr: 'Gönderildi', pt: 'Enviado' },
  clanDescPlaceholder: { ru: 'Расскажите о клане...', en: 'Tell everyone about your clan...', uk: 'Розкажіть про клан...', es: 'Cuéntanos sobre tu clan...', tr: 'Klanınızı anlatın...', pt: 'Conte sobre o clã...' },
  clanDescEmpty:   { ru: 'Описание клана пока не добавлено', en: 'No clan description yet', uk: 'Опис клану ще не додано', es: 'Aún no hay descripción del clan', tr: 'Henüz klan açıklaması yok', pt: 'Ainda sem descrição do clã' },
  clanDescEditTitle: { ru: 'Изменить описание', en: 'Edit description', uk: 'Змінити опис', es: 'Editar descripción', tr: 'Açıklamayı düzenle', pt: 'Editar descrição' },
  clanSaveBtn:     { ru: 'Сохранить', en: 'Save', uk: 'Зберегти', es: 'Guardar', tr: 'Kaydet', pt: 'Salvar' },
  clanCancelBtn:   { ru: 'Отмена', en: 'Cancel', uk: 'Скасувати', es: 'Cancelar', tr: 'İptal', pt: 'Cancelar' },
  clanSearchTitle: { ru: 'Найти клан', en: 'Find Clan', uk: 'Знайти клан', es: 'Buscar Clan', tr: 'Klan Bul', pt: 'Buscar Clã' },
  clanNamePlaceholder2: { ru: 'Название клана...', en: 'Clan name...', uk: 'Назва клану...', es: 'Nombre del clan...', tr: 'Klan adı...', pt: 'Nome do clã...' },
  clanSearchBtn:   { ru: 'Найти', en: 'Search', uk: 'Знайти', es: 'Buscar', tr: 'Ara', pt: 'Buscar' },
  clanTabHome:     { ru: 'Клан', en: 'Clan', uk: 'Клан', es: 'Clan', tr: 'Klan', pt: 'Clã' },
  clanTabMembers:  { ru: 'Участники', en: 'Members', uk: 'Учасники', es: 'Miembros', tr: 'Üyeler', pt: 'Membros' },
  clanTabPerks:    { ru: 'Навыки', en: 'Perks', uk: 'Навички', es: 'Habilidades', tr: 'Yetenekler', pt: 'Habilidades' },
  clanTabStorage:  { ru: 'Хранилище', en: 'Storage', uk: 'Сховище', es: 'Almacén', tr: 'Depo', pt: 'Depósito' },
  clanStorageLockedFmt: { ru: 'Хранилище клана закрыто. Лидер может открыть его за {n} золота — один раз, на весь клан.', en: 'Clan storage is locked. The leader can open it for {n} gold — once, for the whole clan.', uk: 'Сховище клану закрите. Лідер може відкрити його за {n} золота — один раз, на весь клан.', es: 'El almacén del clan está bloqueado. El líder puede abrirlo por {n} de oro, una vez para todo el clan.', tr: 'Klan deposu kilitli. Lider {n} altına açabilir — tüm klan için bir kez.', pt: 'O depósito do clã está bloqueado. O líder pode abri-lo por {n} de ouro — uma vez, para todo o clã.' },
  clanStorageLockedMember: { ru: 'Открыть хранилище может только лидер клана', en: 'Only the clan leader can open the storage', uk: 'Відкрити сховище може лише лідер клану', es: 'Solo el líder del clan puede abrir el almacén', tr: 'Depoyu yalnızca klan lideri açabilir', pt: 'Apenas o líder do clã pode abrir o depósito' },
  clanStorageUnlockBtn: { ru: 'Открыть за {n} золота', en: 'Open for {n} gold', uk: 'Відкрити за {n} золота', es: 'Abrir por {n} de oro', tr: '{n} altına aç', pt: 'Abrir por {n} de ouro' },
  clanStorageUnlockAsk: { ru: 'Открыть хранилище клана за {n} золота? Вернуть их будет нельзя.', en: 'Open clan storage for {n} gold? This cannot be refunded.', uk: 'Відкрити сховище клану за {n} золота? Повернути їх не можна.', es: '¿Abrir el almacén del clan por {n} de oro? No hay reembolso.', tr: 'Klan deposunu {n} altına aç? Geri ödeme yok.', pt: 'Abrir o depósito do clã por {n} de ouro? Sem reembolso.' },
  clanStorageYourGold: { ru: 'У вас золота', en: 'Your gold', uk: 'У вас золота', es: 'Tu oro', tr: 'Altınınız', pt: 'Seu ouro' },
  clanStorageUnlockedToast: { ru: 'Хранилище клана открыто!', en: 'Clan storage opened!', uk: 'Сховище клану відкрито!', es: '¡Almacén del clan abierto!', tr: 'Klan deposu açıldı!', pt: 'Depósito do clã aberto!' },
  clanStorageHdr:  { ru: 'Осколки клана', en: 'Clan shards', uk: 'Осколки клану', es: 'Fragmentos del clan', tr: 'Klan parçaları', pt: 'Fragmentos do clã' },
  clanStorageLoading: { ru: 'Загрузка...', en: 'Loading...', uk: 'Завантаження...', es: 'Cargando...', tr: 'Yükleniyor...', pt: 'Carregando...' },
  clanStorageEmpty:{ ru: 'Хранилище пусто', en: 'Storage is empty', uk: 'Сховище порожнє', es: 'El almacén está vacío', tr: 'Depo boş', pt: 'O depósito está vazio' },
  clanStorageGateFmt: { ru: 'Хранилище доступно после {d} дней в клане. Вы в клане {cur} дн.', en: 'Storage unlocks after {d} days in the clan. You have been here {cur} days.', uk: 'Сховище доступне після {d} днів у клані. Ви в клані {cur} дн.', es: 'El almacén se desbloquea tras {d} días en el clan. Llevas {cur} días.', tr: 'Depo klanda {d} gün sonra açılır. {cur} gündür buradasınız.', pt: 'O depósito abre após {d} dias no clã. Você está há {cur} dias.' },
  clanStorageAllocHdr:{ ru: 'Выдано вам', en: 'Allocated to you', uk: 'Видано вам', es: 'Asignado a ti', tr: 'Size ayrılan', pt: 'Alocado para você' },
  clanStorageAllocHdrLeader:{ ru: 'Выдачи (ожидают получения)', en: 'Allocations (awaiting collection)', uk: 'Видачі (очікують отримання)', es: 'Asignaciones (por recoger)', tr: 'Ayrılanlar (alınmayı bekliyor)', pt: 'Alocações (aguardando coleta)' },
  clanStorageNoAlloc:{ ru: 'Выдач нет', en: 'Nothing allocated', uk: 'Видач немає', es: 'Nada asignado', tr: 'Ayrılan yok', pt: 'Nada alocado' },
  clanStorageDepositHdr:{ ru: 'Положить в хранилище', en: 'Deposit', uk: 'Покласти в сховище', es: 'Depositar', tr: 'Yatır', pt: 'Depositar' },
  clanStorageNoShards:{ ru: 'У вас нет Осколков', en: 'You have no Shards', uk: 'У вас немає Осколків', es: 'No tienes Fragmentos', tr: 'Parçanız yok', pt: 'Você não tem Fragmentos' },
  clanStorageDepositBtn:{ ru: 'Положить', en: 'Deposit', uk: 'Покласти', es: 'Depositar', tr: 'Yatır', pt: 'Depositar' },
  clanStorageGiveBtn:{ ru: 'Выдать', en: 'Give', uk: 'Видати', es: 'Dar', tr: 'Ver', pt: 'Dar' },
  clanStorageCancelBtn:{ ru: 'Вернуть', en: 'Return', uk: 'Повернути', es: 'Devolver', tr: 'Geri al', pt: 'Devolver' },
  clanStorageClaimBtn:{ ru: 'Забрать всё', en: 'Collect all', uk: 'Забрати все', es: 'Recoger todo', tr: 'Hepsini al', pt: 'Coletar tudo' },
  clanStorageDepositAsk:{ ru: 'Сколько «{name}» положить? (максимум {max})', en: 'How many "{name}" to deposit? (max {max})', uk: 'Скільки «{name}» покласти? (максимум {max})', es: '¿Cuántos "{name}" depositar? (máx {max})', tr: 'Kaç "{name}" yatırılsın? (en fazla {max})', pt: 'Quantos "{name}" depositar? (máx {max})' },
  clanStorageGiveWho:{ ru: 'Кому выдать «{name}»? Введите номер:\n{list}', en: 'Who gets "{name}"? Enter a number:\n{list}', uk: 'Кому видати «{name}»? Введіть номер:\n{list}', es: '¿Quién recibe "{name}"? Escribe un número:\n{list}', tr: '"{name}" kime verilsin? Bir numara girin:\n{list}', pt: 'Quem recebe "{name}"? Digite um número:\n{list}' },
  clanStorageGiveHowMany:{ ru: 'Сколько «{name}» выдать игроку {who}? (максимум {max})', en: 'How many "{name}" for {who}? (max {max})', uk: 'Скільки «{name}» видати гравцю {who}? (максимум {max})', es: '¿Cuántos "{name}" para {who}? (máx {max})', tr: '{who} için kaç "{name}"? (en fazla {max})', pt: 'Quantos "{name}" para {who}? (máx {max})' },
  clanStorageCancelAsk:{ ru: 'Вернуть выдачу в хранилище?', en: 'Return this allocation to storage?', uk: 'Повернути видачу до сховища?', es: '¿Devolver esta asignación al almacén?', tr: 'Bu ayrılanı depoya geri al?', pt: 'Devolver esta alocação ao depósito?' },
  clanStorageTooMany:{ ru: 'Максимум {max}', en: 'Maximum {max}', uk: 'Максимум {max}', es: 'Máximo {max}', tr: 'En fazla {max}', pt: 'Máximo {max}' },
  clanStorageBadPick:{ ru: 'Неверный номер', en: 'Invalid number', uk: 'Невірний номер', es: 'Número inválido', tr: 'Geçersiz numara', pt: 'Número inválido' },
  clanStorageNoEligible:{ ru: 'Нет участников, которые в клане достаточно давно', en: 'No members have been in the clan long enough', uk: 'Немає учасників, які в клані достатньо давно', es: 'Ningún miembro lleva suficiente tiempo en el clan', tr: 'Klanda yeterince uzun süredir olan üye yok', pt: 'Nenhum membro está no clã há tempo suficiente' },
  clanStorageClaimedToast:{ ru: 'Получено Осколков: {n}', en: 'Shards collected: {n}', uk: 'Отримано Осколків: {n}', es: 'Fragmentos recogidos: {n}', tr: 'Alınan parça: {n}', pt: 'Fragmentos coletados: {n}' },
  clanPointsLbl:   { ru: 'Очки клана', en: 'Clan Points', uk: 'Очки клану', es: 'Puntos del Clan', tr: 'Klan Puanı', pt: 'Pontos do Clã' },
  clanUntilLevel:  { ru: 'до ур.{lvl}', en: 'to lvl.{lvl}', uk: 'до рів.{lvl}', es: 'al niv.{lvl}', tr: 'sv.{lvl}\'e', pt: 'ao nív.{lvl}' },
  clanMaxLevel:    { ru: 'Макс. уровень', en: 'Max Level', uk: 'Макс. рівень', es: 'Nivel Máx.', tr: 'Maks. Seviye', pt: 'Nível Máx.' },
  clanNoBonusYet:  { ru: 'бонусов пока нет', en: 'no bonuses yet', uk: 'бонусів поки немає', es: 'aún sin bonos', tr: 'henüz bonus yok', pt: 'ainda sem bônus' },
  clanYourBmLbl:   { ru: 'Ваша БМ', en: 'Your BM', uk: 'Ваш БМ', es: 'Tu PC', tr: 'Senin SG', pt: 'Seu PC' },
  clanDisbandBtn:  { ru: 'Расформировать', en: 'Disband', uk: 'Розпустити', es: 'Disolver', tr: 'Feshet', pt: 'Dissolver' },
  clanLeaveBtn:    { ru: 'Покинуть клан', en: 'Leave Clan', uk: 'Покинути клан', es: 'Abandonar Clan', tr: 'Klandan Ayrıl', pt: 'Sair do Clã' },
  clanKickBtn:     { ru: 'Исключить', en: 'Kick', uk: 'Виключити', es: 'Expulsar', tr: 'At', pt: 'Expulsar' },
  clanApplicationsFmt: { ru: 'Заявки ({n})', en: 'Applications ({n})', uk: 'Заявки ({n})', es: 'Solicitudes ({n})', tr: 'Başvurular ({n})', pt: 'Solicitações ({n})' },
  clanApproveBtn:  { ru: 'Принять', en: 'Accept', uk: 'Прийняти', es: 'Aceptar', tr: 'Kabul Et', pt: 'Aceitar' },
  clanDeclineBtn:  { ru: 'Отказать', en: 'Decline', uk: 'Відхилити', es: 'Rechazar', tr: 'Reddet', pt: 'Recusar' },
  clanMembersByBmFmt: { ru: 'Участники ({n}) · по БМ', en: 'Members ({n}) · by BM', uk: 'Учасники ({n}) · за БМ', es: 'Miembros ({n}) · por PC', tr: 'Üyeler ({n}) · SG\'ye göre', pt: 'Membros ({n}) · por PC' },
  clanPerkGold:    { ru: 'Золото', en: 'Gold', uk: 'Золото', es: 'Oro', tr: 'Altın', pt: 'Ouro' },
  clanPerkXp:      { ru: 'Опыт', en: 'XP', uk: 'Досвід', es: 'XP', tr: 'Tecrübe', pt: 'XP' },
  clanPerkAtk:     { ru: 'Атака', en: 'Attack', uk: 'Атака', es: 'Ataque', tr: 'Saldırı', pt: 'Ataque' },
  clanPerksHdr:    { ru: 'Бонусы клана по уровням', en: 'Clan Bonuses by Level', uk: 'Бонуси клану за рівнями', es: 'Bonos del Clan por Nivel', tr: 'Seviyeye Göre Klan Bonusları', pt: 'Bônus do Clã por Nível' },
  clanConfirmLeave:{ ru: 'Покинуть клан?', en: 'Leave the clan?', uk: 'Покинути клан?', es: '¿Abandonar el clan?', tr: 'Klandan ayrılınsın mı?', pt: 'Sair do clã?' },
  clanConfirmDisband: { ru: 'Расформировать клан? Это нельзя отменить.', en: 'Disband the clan? This cannot be undone.', uk: 'Розпустити клан? Це неможливо скасувати.', es: '¿Disolver el clan? Esto no se puede deshacer.', tr: 'Klan feshedilsin mi? Bu geri alınamaz.', pt: 'Dissolver o clã? Isso não pode ser desfeito.' },
  clanLevelUpToast:{ ru: 'Клан уровень {lvl}!', en: 'Clan level {lvl}!', uk: 'Рівень клану {lvl}!', es: '¡Nivel de clan {lvl}!', tr: 'Klan seviyesi {lvl}!', pt: 'Nível do clã {lvl}!' },
};

// Clan perk-tree descriptions (js/clans.js's PERKS_RU array) — index-aligned,
// since two entries share lvl:10 and can't be keyed by level alone.
// ── In-world HUD/canvas text ──
Object.assign(I18N_UI, {
  pvpOffToast:     { ru: 'ПК режим выключен', en: 'PvP mode off', uk: 'PvP режим вимкнено', es: 'Modo PvP desactivado', tr: 'PvP modu kapalı', pt: 'Modo PvP desativado' },
  safeZoneLbl:     { ru: '🛡 Безопасная зона · реген HP', en: '🛡 Safe Zone · HP regen', uk: '🛡 Безпечна зона · реген HP', es: '🛡 Zona Segura · regen. HP', tr: '🛡 Güvenli Bölge · HP yenilenme', pt: '🛡 Zona Segura · regen. HP' },
  armLeft:  { ru: 'левый',   en: 'left',   uk: 'лівий',    es: 'izquierdo', tr: 'sol',   pt: 'esquerdo' },
  armTop:   { ru: 'верхний', en: 'top',    uk: 'верхній',  es: 'superior',  tr: 'üst',    pt: 'superior' },
  armBottom:{ ru: 'нижний',  en: 'bottom', uk: 'нижній',   es: 'inferior',  tr: 'alt',    pt: 'inferior' },
  armRight: { ru: 'правый',  en: 'right',  uk: 'правий',   es: 'derecho',   tr: 'sağ',    pt: 'direito' },
  corridorSuffix: { ru: 'коридор', en: 'corridor', uk: 'коридор', es: 'corredor', tr: 'koridor', pt: 'corredor' },
  updateReloading: { ru: 'Обновление — перезаходим…', en: 'Update — reconnecting…', uk: 'Оновлення — перезаходимо…', es: 'Actualización — reconectando…', tr: 'Güncelleme — yeniden bağlanılıyor…', pt: 'Atualização — reconectando…' },
  levelAbbrev: { ru: 'Ур.', en: 'Lv.', uk: 'Рів.', es: 'Niv.', tr: 'Sv.', pt: 'Nív.' },
  lockedNeedLevel: { ru: '🔒 Нужен {n} уровень', en: '🔒 Level {n} required', uk: '🔒 Потрібен {n} рівень', es: '🔒 Se requiere nivel {n}', tr: '🔒 Seviye {n} gerekli', pt: '🔒 Necessário nível {n}' },
  centralHall:   { ru: 'Центральный зал', en: 'Central Hall', uk: 'Центральний зал', es: 'Sala Central', tr: 'Merkez Salon', pt: 'Salão Central' },
  hallShort:     { ru: 'Зал', en: 'Hall', uk: 'Зал', es: 'Sala', tr: 'Salon', pt: 'Salão' },
  enteredCorridorToast: { ru: 'Вы вошли в {arm} коридор', en: 'You entered the {arm} corridor', uk: 'Ви увійшли в {arm} коридор', es: 'Entraste al corredor {arm}', tr: '{arm} koridora girdin', pt: 'Você entrou no corredor {arm}' },
  deathGoldLbl:  { ru: 'золота', en: 'gold', uk: 'золота', es: 'de oro', tr: 'altın', pt: 'de ouro' },
  deathKillsLbl: { ru: 'убийств', en: 'kills', uk: 'вбивств', es: 'muertes', tr: 'öldürme', pt: 'mortes' },
  deathXpPenalty:{ ru: '−50% XP (5 мин)', en: '−50% XP (5 min)', uk: '−50% XP (5 хв)', es: '−50% XP (5 min)', tr: '−%50 XP (5 dk)', pt: '−50% XP (5 min)' },

  // ── Network toasts ──
  noServerConn:  { ru: 'Нет соединения с сервером', en: 'No connection to the server', uk: "Немає з'єднання з сервером", es: 'Sin conexión con el servidor', tr: 'Sunucuya bağlantı yok', pt: 'Sem conexão com o servidor' },
  loggedInElsewhere: { ru: 'Вы вошли с другого устройства', en: 'You logged in from another device', uk: 'Ви увійшли з іншого пристрою', es: 'Iniciaste sesión desde otro dispositivo', tr: 'Başka bir cihazdan giriş yaptın', pt: 'Você entrou de outro dispositivo' },
  faithShieldToast: { ru: '🛡 Щит веры!', en: '🛡 Shield of Faith!', uk: '🛡 Щит віри!', es: '🛡 ¡Escudo de Fe!', tr: '🛡 İnanç Kalkanı!', pt: '🛡 Escudo da Fé!' },
  stunToast:     { ru: 'СТАН!', en: 'STUN!', uk: 'ОГЛУШЕННЯ!', es: '¡ATURDIDO!', tr: 'SERSEMLETME!', pt: 'ATORDOADO!' },
  slowToast:     { ru: 'ЗАМЕДЛЕНИЕ!', en: 'SLOW!', uk: 'УПОВІЛЬНЕННЯ!', es: '¡RALENTIZADO!', tr: 'YAVAŞLATMA!', pt: 'LENTIDÃO!' },
  safeStoneLbl:  { ru: 'Безоп. камень', en: 'Safe Stone', uk: 'Безпечний камінь', es: 'Piedra Segura', tr: 'Güvenli Taş', pt: 'Pedra Segura' },
  enchantStoneLbl: { ru: 'Камень заточки', en: 'Enchant Stone', uk: 'Камінь гартування', es: 'Piedra de Encantamiento', tr: 'Büyü Taşı', pt: 'Pedra de Encantamento' },
  partyCountToast: { ru: 'Пати: {n} чел.', en: 'Party: {n}', uk: 'Паті: {n}', es: 'Grupo: {n}', tr: 'Grup: {n}', pt: 'Grupo: {n}' },
  leftPartyToast: { ru: '{name} покинул пати', en: '{name} left the party', uk: '{name} покинув паті', es: '{name} abandonó el grupo', tr: '{name} gruptan ayrıldı', pt: '{name} saiu do grupo' },
  partyDeclinedToast: { ru: '{name} отклонил(а) приглашение', en: '{name} declined the invite', uk: '{name} відхилив(ла) запрошення', es: '{name} rechazó la invitación', tr: '{name} daveti reddetti', pt: '{name} recusou o convite' },
  allyPrayerToast: { ru: 'Молитва союзника!', en: "Ally's Prayer!", uk: 'Молитва союзника!', es: '¡Oración del Aliado!', tr: 'Müttefik Duası!', pt: 'Oração do Aliado!' },
  adminGiftToast: { ru: '🎁 Подарок от админа!', en: '🎁 Gift from admin!', uk: '🎁 Подарунок від адміна!', es: '🎁 ¡Regalo del admin!', tr: '🎁 Yöneticiden hediye!', pt: '🎁 Presente do admin!' },
  lvlNTeleport: { ru: '{n} уровень', en: 'Level {n}', uk: '{n} рівень', es: 'Nivel {n}', tr: 'Seviye {n}', pt: 'Nível {n}' },
});

// ── Inventory / profile / skills / map panels (js/ui.js dynamic HTML) ──
Object.assign(I18N_UI, {
  charLevelFmt: { ru: 'Уровень {lvl}', en: 'Level {lvl}', uk: 'Рівень {lvl}', es: 'Nivel {lvl}', tr: 'Seviye {lvl}', pt: 'Nível {lvl}' },
  bmAbbrev:     { ru: 'БМ', en: 'BM', uk: 'БМ', es: 'PC', tr: 'SG', pt: 'PC' },
  buffCountSuffix: { ru: 'бафф', en: 'buff', uk: 'бафф', es: 'buff', tr: 'buff', pt: 'buff' },
  offLbl: { ru: 'ВЫКЛ', en: 'OFF', uk: 'ВИМК', es: 'APAG', tr: 'KAPALI', pt: 'DESL' },
  onLbl: { ru: 'ВКЛ', en: 'ON', uk: 'УВІМК', es: 'ENC', tr: 'AÇIK', pt: 'LIG' },
  autoLbl: { ru: 'Авто', en: 'Auto', uk: 'Авто', es: 'Auto', tr: 'Oto', pt: 'Auto' },
  autoBuffHint: { ru: 'Авто-повтор: зелье пьётся заново само, как только действие закончится (если оно есть в сумке)', en: 'Auto-repeat: the potion is re-drunk automatically the moment it wears off (if you still have one)', uk: 'Авто-повтор: зілля випивається знову само, щойно дія закінчиться (якщо воно є в сумці)', es: 'Auto-repetición: la poción se vuelve a beber sola en cuanto se agota (si aún tienes una)', tr: 'Oto-tekrar: iksir etkisi bitince (envanterinde varsa) kendiliğinden yeniden içilir', pt: 'Auto-repetição: a poção é bebida de novo sozinha assim que o efeito acaba (se você ainda tiver uma)' },
  potCooldownFmt: { ru: 'HP+{hp} · откат {s}с', en: 'HP+{hp} · {s}s cooldown', uk: 'HP+{hp} · відкат {s}с', es: 'HP+{hp} · reutil. {s}s', tr: 'HP+{hp} · {s}sn bekleme', pt: 'HP+{hp} · recarga {s}s' },
  inHudBadge: { ru: '✓ В HUD', en: '✓ In HUD', uk: '✓ У HUD', es: '✓ En HUD', tr: '✓ HUD\'da', pt: '✓ No HUD' },
  autoUseHint: { ru: 'Авто-использование при HP &lt;', en: 'Auto-use when HP &lt;', uk: 'Авто-використання при HP &lt;', es: 'Uso automático cuando HP &lt;', tr: 'HP &lt; olduğunda otomatik kullan', pt: 'Uso automático quando HP &lt;' },
  useBtn: { ru: 'Использовать', en: 'Use', uk: 'Використати', es: 'Usar', tr: 'Kullan', pt: 'Usar' },
  xpFmt: { ru: 'Опыт: {xp} / {xpNext}', en: 'XP: {xp} / {xpNext}', uk: 'Досвід: {xp} / {xpNext}', es: 'XP: {xp} / {xpNext}', tr: 'Tecrübe: {xp} / {xpNext}', pt: 'XP: {xp} / {xpNext}' },
  statDef: { ru: 'Защита', en: 'Defense', uk: 'Захист', es: 'Defensa', tr: 'Savunma', pt: 'Defesa' },
  statAtkSpeedAbbrev: { ru: 'Скор. ат.', en: 'Atk. spd.', uk: 'Швид. ат.', es: 'Vel. atq.', tr: 'Sld. hızı', pt: 'Vel. atq.' },
  statCritChance: { ru: 'Крит шанс', en: 'Crit chance', uk: 'Шанс криту', es: 'Prob. crítico', tr: 'Kritik şansı', pt: 'Chance crítico' },
  statCritPower: { ru: 'Крит сила', en: 'Crit power', uk: 'Сила криту', es: 'Poder crítico', tr: 'Kritik gücü', pt: 'Poder crítico' },
  statHpRegen: { ru: 'HP реген', en: 'HP regen', uk: 'HP реген', es: 'Regen HP', tr: 'HP yenilenme', pt: 'Regen HP' },
  peerEquipHdr: { ru: 'Экипировка', en: 'Equipment', uk: 'Екіпіровка', es: 'Equipo', tr: 'Ekipman', pt: 'Equipamento' },
  skillPointsFmt: { ru: 'Очки навыка: {n}', en: 'Skill points: {n}', uk: 'Очки навички: {n}', es: 'Puntos de habilidad: {n}', tr: 'Yetenek puanı: {n}', pt: 'Pontos de habilidade: {n}' },
  notEnoughSkillPoints: { ru: 'Мало очков навыка!', en: 'Not enough skill points!', uk: 'Мало очок навички!', es: '¡Puntos de habilidad insuficientes!', tr: 'Yeterli yetenek puanı yok!', pt: 'Pontos de habilidade insuficientes!' },
  cancelBtn: { ru: 'Отмена', en: 'Cancel', uk: 'Скасувати', es: 'Cancelar', tr: 'İptal', pt: 'Cancelar' },
  craftNeedLiberty: { ru: 'Нужно {n} Liberty', en: 'Need {n} Liberty', uk: 'Потрібно {n} Liberty', es: 'Se necesitan {n} Liberty', tr: '{n} Liberty gerekli', pt: 'Precisa de {n} Liberty' },
  upgResetBtn: { ru: 'Сбросить улучшения', en: 'Reset upgrades', uk: 'Скинути покращення', es: 'Restablecer mejoras', tr: 'Geliştirmeleri sıfırla', pt: 'Redefinir melhorias' },
  upgResetHint: { ru: 'Вернётся очков навыка: {n}', en: 'Skill points returned: {n}', uk: 'Повернеться очок навички: {n}', es: 'Puntos de habilidad devueltos: {n}', tr: 'İade edilecek yetenek puanı: {n}', pt: 'Pontos de habilidade devolvidos: {n}' },
  upgResetNothing: { ru: 'Улучшений пока нет', en: 'No upgrades yet', uk: 'Покращень поки немає', es: 'Aún no hay mejoras', tr: 'Henüz geliştirme yok', pt: 'Ainda sem melhorias' },
  upgResetTitle: { ru: 'Сброс улучшений', en: 'Reset upgrades', uk: 'Скидання покращень', es: 'Restablecer mejoras', tr: 'Geliştirmeleri sıfırla', pt: 'Redefinir melhorias' },
  upgResetConfirm: { ru: 'Все улучшения обнулятся, а {n} очк. навыка вернутся. Спишется {cost} Liberty. Потраченное золото не возвращается.', en: 'All upgrades go to zero and {n} skill points come back. {cost} Liberty will be charged. Gold spent on them is not refunded.', uk: 'Усі покращення обнуляться, а {n} очок навички повернуться. Спишеться {cost} Liberty. Витрачене золото не повертається.', es: 'Todas las mejoras se ponen a cero y se devuelven {n} puntos de habilidad. Se cobrarán {cost} Liberty. El oro gastado no se reembolsa.', tr: 'Tüm geliştirmeler sıfırlanır ve {n} yetenek puanı geri gelir. {cost} Liberty düşülecek. Harcanan altın iade edilmez.', pt: 'Todas as melhorias vão a zero e {n} pontos de habilidade voltam. Serão cobrados {cost} Liberty. O ouro gasto não é reembolsado.' },
  upgResetGo: { ru: 'Сбросить', en: 'Reset', uk: 'Скинути', es: 'Restablecer', tr: 'Sıfırla', pt: 'Redefinir' },
  upgResetDone: { ru: 'Возвращено очков: {n}', en: '{n} points returned', uk: 'Повернуто очок: {n}', es: '{n} puntos devueltos', tr: '{n} puan iade edildi', pt: '{n} pontos devolvidos' },
  upgResetNeedFmt: { ru: 'Нужно {n} Liberty', en: 'Need {n} Liberty', uk: 'Потрібно {n} Liberty', es: 'Se necesitan {n} Liberty', tr: '{n} Liberty gerekli', pt: 'Precisa de {n} Liberty' },
  rebirthDesc: { ru: 'Сбрасывает уровень до 1 и даёт +15 очков навыка навсегда — уже вложенные улучшения не сбрасываются. До 30 уровня новые очки навыка за левелап начисляться не будут — они снова начнут капать только с 30 уровня и дальше, как раньше.', en: 'Resets your level to 1 and grants +15 skill points forever — upgrades you already invested are not reset. Levelling up gives no new skill points until level 30 — they start accruing again from level 30 onward, same as before.', uk: 'Скидає рівень до 1 і дає +15 очок навички назавжди — вже вкладені покращення не скидаються. До 30 рівня нові очки навички за левелап не нараховуватимуться — вони знову почнуть капати лише з 30 рівня і далі, як раніше.', es: 'Reinicia tu nivel a 1 y otorga +15 puntos de habilidad para siempre — las mejoras que ya invertiste no se reinician. Subir de nivel no da nuevos puntos de habilidad hasta el nivel 30 — vuelven a acumularse desde el nivel 30 en adelante, igual que antes.', tr: 'Seviyeni 1\'e sıfırlar ve kalıcı olarak +15 yetenek puanı verir — zaten yatırdığın geliştirmeler sıfırlanmaz. Seviye 30\'a kadar seviye atlamak yeni yetenek puanı vermez — 30. seviyeden itibaren eskisi gibi yeniden birikmeye başlar.', pt: 'Reinicia seu nível para 1 e concede +15 pontos de habilidade para sempre — as melhorias que você já investiu não são reiniciadas. Subir de nível não dá novos pontos de habilidade até o nível 30 — eles voltam a acumular a partir do nível 30, como antes.' },
  rebirthLevelReqFmt: { ru: 'Уровень {cur} / {lvl} для перерождения', en: 'Level {cur} / {lvl} for rebirth', uk: 'Рівень {cur} / {lvl} для переродження', es: 'Nivel {cur} / {lvl} para renacer', tr: 'Yeniden doğuş için seviye {cur} / {lvl}', pt: 'Nível {cur} / {lvl} para renascer' },
  rebirthNeedHubLbl: { ru: 'Перерождение доступно только в Зале', en: 'Rebirth is only available in the Hall', uk: 'Переродження доступне лише в Залі', es: 'El renacimiento solo está disponible en la Sala', tr: 'Yeniden doğuş sadece Salonda kullanılabilir', pt: 'O renascimento só está disponível no Salão' },
  rebirthBtn: { ru: 'Переродиться', en: 'Rebirth', uk: 'Переродитися', es: 'Renacer', tr: 'Yeniden doğ', pt: 'Renascer' },
  rebirthCountFmt: { ru: 'Перерождений пройдено: {n}', en: 'Rebirths completed: {n}', uk: 'Перероджень пройдено: {n}', es: 'Renacimientos completados: {n}', tr: 'Tamamlanan yeniden doğuş: {n}', pt: 'Renascimentos concluídos: {n}' },
  rebirthDoubleCostFmt: { ru: 'Перерождение №{n} — стоимость ×2!', en: 'Rebirth #{n} — cost ×2!', uk: 'Переродження №{n} — вартість ×2!', es: 'Renacimiento n.º {n} — ¡coste ×2!', tr: 'Yeniden doğuş #{n} — maliyet ×2!', pt: 'Renascimento nº {n} — custo ×2!' },
  rebirthMatPkgLabel_rmat1: { ru: 'Набор I', en: 'Set I', uk: 'Набір I', es: 'Set I', tr: 'Set I', pt: 'Conjunto I' },
  rebirthMatPkgLabel_rmat2: { ru: 'Набор II', en: 'Set II', uk: 'Набір II', es: 'Set II', tr: 'Set II', pt: 'Conjunto II' },
  rebirthMatPkgLabel_rmat3: { ru: 'Набор III', en: 'Set III', uk: 'Набір III', es: 'Set III', tr: 'Set III', pt: 'Conjunto III' },
  rebirthConfirmTitle: { ru: 'Перерождение', en: 'Rebirth', uk: 'Переродження', es: 'Renacimiento', tr: 'Yeniden Doğuş', pt: 'Renascimento' },
  rebirthConfirmBody: { ru: 'Уровень сбросится до 1, а взамен вы получите +15 очков навыка навсегда. Улучшения останутся как есть. Указанные предметы будут потрачены. Действие необратимо.', en: 'Your level resets to 1, in exchange for +15 skill points forever. Your upgrades stay as they are. The listed items will be consumed. This cannot be undone.', uk: 'Рівень скинеться до 1, натомість ви отримаєте +15 очок навички назавжди. Покращення залишаться як є. Вказані предмети буде витрачено. Дію не можна скасувати.', es: 'Tu nivel se reinicia a 1, a cambio de +15 puntos de habilidad para siempre. Tus mejoras se mantienen igual. Los objetos indicados se consumirán. Esto no se puede deshacer.', tr: 'Seviyen 1\'e sıfırlanır, karşılığında kalıcı olarak +15 yetenek puanı alırsın. Geliştirmelerin olduğu gibi kalır. Listelenen eşyalar harcanacak. Bu işlem geri alınamaz.', pt: 'Seu nível volta a 1, em troca de +15 pontos de habilidade para sempre. Suas melhorias permanecem como estão. Os itens listados serão consumidos. Isso não pode ser desfeito.' },
  rebirthGo: { ru: 'Переродиться', en: 'Rebirth', uk: 'Переродитися', es: 'Renacer', tr: 'Yeniden doğ', pt: 'Renascer' },
  rebirthDoneToast: { ru: '✓ Вы переродились!', en: '✓ You have been reborn!', uk: '✓ Ви переродилися!', es: '✓ ¡Has renacido!', tr: '✓ Yeniden doğdunuz!', pt: '✓ Você renasceu!' },
  spAbbrev: { ru: 'ОН', en: 'SP', uk: 'ОН', es: 'PH', tr: 'YP', pt: 'PH' },
  selectCharacterHint: { ru: 'Выберите персонажа', en: 'Select a character', uk: 'Оберіть персонажа', es: 'Selecciona un personaje', tr: 'Bir karakter seç', pt: 'Selecione um personagem' },
  skillBooksHdr: { ru: 'Книги навыков', en: 'Skill Books', uk: 'Книги навичок', es: 'Libros de Habilidad', tr: 'Yetenek Kitapları', pt: 'Livros de Habilidade' },
  passiveBooksHdr: { ru: 'Книги пассивок', en: 'Passive Books', uk: 'Книги пасивок', es: 'Libros Pasivos', tr: 'Pasif Kitaplar', pt: 'Livros Passivos' },
  studyUpgradeHintFmt: { ru: 'Изучение: {a} кн. · Улучшение: {b} кн. · {c}% шанс', en: 'Study: {a} bk. · Upgrade: {b} bk. · {c}% chance', uk: 'Вивчення: {a} кн. · Покращення: {b} кн. · {c}% шанс', es: 'Estudiar: {a} lib. · Mejorar: {b} lib. · {c}% prob.', tr: 'Öğren: {a} kitap · Geliştir: {b} kitap · %{c} şans', pt: 'Estudar: {a} liv. · Melhorar: {b} liv. · {c}% chance' },
  skillBookFallback: { ru: 'Книга навыков', en: 'Skill Book', uk: 'Книга навичок', es: 'Libro de Habilidad', tr: 'Yetenek Kitabı', pt: 'Livro de Habilidade' },
  maxLbl: { ru: 'Максимум', en: 'Maximum', uk: 'Максимум', es: 'Máximo', tr: 'Maksimum', pt: 'Máximo' },
  maxAbbrev: { ru: 'МАКС', en: 'MAX', uk: 'МАКС', es: 'MÁX', tr: 'MAKS', pt: 'MÁX' },
  notStudiedLbl: { ru: 'Не изучен', en: 'Not studied', uk: 'Не вивчено', es: 'No estudiado', tr: 'Öğrenilmedi', pt: 'Não estudado' },
  studyBtnFmt: { ru: 'Изучить ({n})', en: 'Study ({n})', uk: 'Вивчити ({n})', es: 'Estudiar ({n})', tr: 'Öğren ({n})', pt: 'Estudar ({n})' },
  upgradeBtnFmt: { ru: 'Улучшить ({pct}%) — {n}', en: 'Upgrade ({pct}%) — {n}', uk: 'Покращити ({pct}%) — {n}', es: 'Mejorar ({pct}%) — {n}', tr: 'Geliştir (%{pct}) — {n}', pt: 'Melhorar ({pct}%) — {n}' },
  needSkillBookToast: { ru: 'Нужна книга этого навыка!', en: 'You need this skill\'s book!', uk: 'Потрібна книга цього навику!', es: '¡Necesitas el libro de esta habilidad!', tr: 'Bu yeteneğin kitabına ihtiyacın var!', pt: 'Você precisa do livro desta habilidade!' },
  needPassiveBookToast: { ru: 'Нужна книга этой пассивки!', en: 'You need this passive\'s book!', uk: 'Потрібна книга цієї пасивки!', es: '¡Necesitas el libro de esta pasiva!', tr: 'Bu pasifin kitabına ihtiyacın var!', pt: 'Você precisa do livro desta passiva!' },
  studySkillFirstToast: { ru: 'Сначала изучите навык!', en: 'Study the skill first!', uk: 'Спочатку вивчіть навик!', es: '¡Primero estudia la habilidad!', tr: 'Önce yeteneği öğren!', pt: 'Estude a habilidade primeiro!' },
  studyPassiveFirstToast: { ru: 'Сначала изучите пассивку!', en: 'Study the passive first!', uk: 'Спочатку вивчіть пасивку!', es: '¡Primero estudia la pasiva!', tr: 'Önce pasifi öğren!', pt: 'Estude a passiva primeiro!' },
  needNSkillBooksFmt: { ru: 'Нужно {n} книги этого навыка!', en: 'Need {n} of this skill\'s books!', uk: 'Потрібно {n} книги цього навику!', es: '¡Necesitas {n} libros de esta habilidad!', tr: 'Bu yetenekten {n} kitap gerekli!', pt: 'Necessário {n} livros desta habilidade!' },
  needNPassiveBooksFmt: { ru: 'Нужно {n} книги этой пассивки!', en: 'Need {n} of this passive\'s books!', uk: 'Потрібно {n} книги цієї пасивки!', es: '¡Necesitas {n} libros de esta pasiva!', tr: 'Bu pasiften {n} kitap gerekli!', pt: 'Necessário {n} livros desta passiva!' },
  failToast: { ru: 'Неудача...', en: 'Failed...', uk: 'Невдача...', es: 'Fallo...', tr: 'Başarısız...', pt: 'Falhou...' },

  // ── Advanced skills ("вторая профессия") — js/ui.js's learnAdvSkill/
  // toggleAdvSkill, unlocked once a slot's own level hits 10. Book drops
  // only in the Фарм-зона (FARM_ADV_SKILL_BOOK_CHANCE, shared/definitions.js).
  advSkillHdr: { ru: 'Продвинутый навык', en: 'Advanced skill', uk: 'Просунута навичка', es: 'Habilidad avanzada', tr: 'Gelişmiş yetenek', pt: 'Habilidade avançada' },
  advActiveLbl: { ru: 'Активен', en: 'Active', uk: 'Активна', es: 'Activa', tr: 'Aktif', pt: 'Ativa' },
  advStudyBtnFmt: { ru: 'Изучить ({n})', en: 'Learn ({n})', uk: 'Вивчити ({n})', es: 'Aprender ({n})', tr: 'Öğren ({n})', pt: 'Aprender ({n})' },
  advSwitchToAdvBtn: { ru: 'Переключить на продвинутый', en: 'Switch to advanced', uk: 'Перемкнути на просунутий', es: 'Cambiar a avanzada', tr: 'Gelişmişe geç', pt: 'Mudar para avançada' },
  advSwitchToBaseBtn: { ru: '✓ Активен — переключить на базовый', en: '✓ Active — switch to base', uk: '✓ Активна — перемкнути на базову', es: '✓ Activa — cambiar a base', tr: '✓ Aktif — temele geç', pt: '✓ Ativa — mudar para base' },
  needAdvSkillBookToast: { ru: 'Нужна книга продвинутого навыка! Падает только в Фарм зоне', en: 'You need the advanced-skill book! Only drops in the Farm Zone', uk: 'Потрібна книга просунутого навику! Випадає лише у Ферм-зоні', es: '¡Necesitas el libro de habilidad avanzada! Solo cae en la Zona de Farmeo', tr: 'Gelişmiş yetenek kitabına ihtiyacın var! Sadece Farm Bölgesi\'nde düşer', pt: 'Você precisa do livro de habilidade avançada! Só cai na Zona de Farm' },
  classPassivesFmt: { ru: 'Классовые ({cls})', en: 'Class ({cls})', uk: 'Класові ({cls})', es: 'De Clase ({cls})', tr: 'Sınıf ({cls})', pt: 'De Classe ({cls})' },
  commonPassivesHdr: { ru: 'Общие', en: 'Common', uk: 'Загальні', es: 'Comunes', tr: 'Ortak', pt: 'Comuns' },
  bonusToDamage: { ru: 'к урону', en: 'to damage', uk: 'до шкоди', es: 'al daño', tr: 'hasara', pt: 'ao dano' },
  bonusToDuration: { ru: 'с. действия', en: 's. duration', uk: 'с. дії', es: 's. duración', tr: 'sn. süre', pt: 's. duração' },
  bonusToHeal: { ru: 'к лечению', en: 'to healing', uk: 'до лікування', es: 'a la curación', tr: 'iyileşmeye', pt: 'à cura' },
  bonusToRange: { ru: 'px дальность', en: 'px range', uk: 'px дальність', es: 'px alcance', tr: 'px menzil', pt: 'px alcance' },
  bonusTypeDamage: { ru: '+1%/ур. урон', en: '+1%/lvl dmg', uk: '+1%/рів. шкода', es: '+1%/niv. daño', tr: '+%1/sv. hasar', pt: '+1%/nív. dano' },
  bonusTypeBuff: { ru: '+1с/ур. действие', en: '+1s/lvl duration', uk: '+1с/рів. дія', es: '+1s/niv. duración', tr: '+1sn/sv. süre', pt: '+1s/nív. duração' },
  bonusTypeHeal: { ru: '+1%/ур. лечение', en: '+1%/lvl heal', uk: '+1%/рів. лікування', es: '+1%/niv. curación', tr: '+%1/sv. iyileşme', pt: '+1%/nív. cura' },
  bonusTypeMobility: { ru: '+10px/ур. дальность', en: '+10px/lvl range', uk: '+10px/рів. дальність', es: '+10px/niv. alcance', tr: '+10px/sv. menzil', pt: '+10px/nív. alcance' },
  passiveStatAtk: { ru: 'к атаке', en: 'to attack', uk: 'до атаки', es: 'al ataque', tr: 'saldırıya', pt: 'ao ataque' },
  passiveStatDef: { ru: 'к защите', en: 'to defense', uk: 'до захисту', es: 'a la defensa', tr: 'savunmaya', pt: 'à defesa' },
  passiveStatHp: { ru: 'к макс. HP', en: 'to max HP', uk: 'до макс. HP', es: 'al HP máx.', tr: 'maks. HP\'ye', pt: 'ao HP máx.' },
  passiveStatAtkSpeed: { ru: 'к скор. атаки', en: 'to atk. speed', uk: 'до швид. атаки', es: 'a la vel. de atq.', tr: 'saldırı hızına', pt: 'à vel. de atq.' },
  passiveStatMoveSpeed: { ru: 'к скорости', en: 'to speed', uk: 'до швидкості', es: 'a la velocidad', tr: 'hıza', pt: 'à velocidade' },
  passiveStatCritPower: { ru: 'к силе крита', en: 'to crit power', uk: 'до сили криту', es: 'al poder crítico', tr: 'kritik gücüne', pt: 'ao poder crítico' },
  hpPerSecSuffix: { ru: 'HP/сек', en: 'HP/sec', uk: 'HP/сек', es: 'HP/seg', tr: 'HP/sn', pt: 'HP/seg' },
  skillCdrSuffix: { ru: 'КД навыков', en: 'skill CD', uk: 'КД навичок', es: 'CD de habilidades', tr: 'yetenek bekleme', pt: 'CD de habilidades' },
  enemiesCountFmt: { ru: 'Враги: {n}', en: 'Enemies: {n}', uk: 'Вороги: {n}', es: 'Enemigos: {n}', tr: 'Düşmanlar: {n}', pt: 'Inimigos: {n}' },
  bossTag: { ru: 'БОСС', en: 'BOSS', uk: 'БОС', es: 'JEFE', tr: 'PATRON', pt: 'CHEFE' },
  dropHdr: { ru: 'Дроп', en: 'Drops', uk: 'Дроп', es: 'Botín', tr: 'Düşenler', pt: 'Itens' },
  keysStonesHdr: { ru: 'Ключи и камни', en: 'Keys & Stones', uk: 'Ключі та камені', es: 'Llaves y Piedras', tr: 'Anahtarlar ve Taşlar', pt: 'Chaves e Pedras' },
  gearRarityFmt: { ru: 'Экипировка ({rn})', en: 'Gear ({rn})', uk: 'Спорядження ({rn})', es: 'Equipo ({rn})', tr: 'Ekipman ({rn})', pt: 'Equipamento ({rn})' },
  skillBooksAllClassesHdr: { ru: 'Книги навыков (все классы)', en: 'Skill Books (all classes)', uk: 'Книги навичок (всі класи)', es: 'Libros de Habilidad (todas las clases)', tr: 'Yetenek Kitapları (tüm sınıflar)', pt: 'Livros de Habilidade (todas as classes)' },
  advSkillBooksAllClassesHdr: { ru: 'Книги 2 профессии (все классы)', en: 'Advanced skill books (all classes)', uk: 'Книги 2 професії (всі класи)', es: 'Libros de 2ª profesión (todas las clases)', tr: '2. Meslek Kitapları (tüm sınıflar)', pt: 'Livros da 2ª profissão (todas as classes)' },
  passiveBooksAllClassesHdr: { ru: 'Книги пассивок (все классы)', en: 'Passive Books (all classes)', uk: 'Книги пасивок (всі класи)', es: 'Libros Pasivos (todas las clases)', tr: 'Pasif Kitaplar (tüm sınıflar)', pt: 'Livros Passivos (todas as classes)' },
  commonTag: { ru: 'общая', en: 'common', uk: 'загальна', es: 'común', tr: 'ortak', pt: 'comum' },
  spdAbbrev: { ru: 'СПД', en: 'SPD', uk: 'ШВД', es: 'VEL', tr: 'HIZ', pt: 'VEL' },
  secAbbrev: { ru: 'с', en: 's', uk: 'с', es: 's', tr: 'sn', pt: 's' },
  minAbbrev: { ru: 'м', en: 'm', uk: 'хв', es: 'm', tr: 'dk', pt: 'm' },
  pvpOnLabel: { ru: 'ПК', en: 'PK', uk: 'ПК', es: 'JcJ', tr: 'PK', pt: 'JcJ' },
  pvpOffLabel: { ru: 'Мир', en: 'Peace', uk: 'Мир', es: 'Paz', tr: 'Barış', pt: 'Paz' },
  professionBtnLbl: { ru: 'Проф', en: 'Prof', uk: 'Проф', es: 'Prof', tr: 'Mslk', pt: 'Prof' },
  partyInviteBtnLbl: { ru: 'Пати+', en: 'Party+', uk: 'Паті+', es: 'Grupo+', tr: 'Grup+', pt: 'Grupo+' },
  partyInfoBtnLbl: { ru: 'Инфо', en: 'Info', uk: 'Інфо', es: 'Info', tr: 'Bilgi', pt: 'Info' },
  partyLeaveBtnLbl: { ru: 'Выйти', en: 'Leave', uk: 'Вийти', es: 'Salir', tr: 'Ayrıl', pt: 'Sair' },
  partyInviteTitle: { ru: 'Приглашение в пати', en: 'Party invitation', uk: 'Запрошення в паті', es: 'Invitación de grupo', tr: 'Grup daveti', pt: 'Convite de grupo' },
  acceptBtn: { ru: 'Принять', en: 'Accept', uk: 'Прийняти', es: 'Aceptar', tr: 'Kabul Et', pt: 'Aceitar' },
  declineBtn: { ru: 'Отказ', en: 'Decline', uk: 'Відмова', es: 'Rechazar', tr: 'Reddet', pt: 'Recusar' },
  enhFailBurnHint: { ru: 'При неудаче вещь сгорит', en: 'The item burns on failure', uk: 'При невдачі річ згорить', es: 'El objeto se destruye si falla', tr: 'Başarısızlıkta eşya yanar', pt: 'O item queima em caso de falha' },
  uniqueShardsHdr: { ru: 'Осколки уникального оружия', en: 'Unique weapon shards', uk: 'Осколки унікальної зброї', es: 'Fragmentos de arma única', tr: 'Eşsiz silah parçaları', pt: 'Fragmentos de arma única' },
  craftUniqueHdr:  { ru: 'Уникальное оружие', en: 'Unique weapons', uk: 'Унікальна зброя', es: 'Armas únicas', tr: 'Eşsiz silahlar', pt: 'Armas únicas' },
  craftUniqueNote: { ru: 'Собирается только из Осколков. Осколки падают с монстров от {lv} уровня.', en: 'Built from Shards only. Shards drop from monsters level {lv} and up.', uk: 'Збирається лише з Осколків. Осколки падають з монстрів від {lv} рівня.', es: 'Se fabrica solo con Fragmentos. Caen de monstruos de nivel {lv} o superior.', tr: 'Yalnızca Parçalardan yapılır. Parçalar {lv}. seviyeden itibaren canavarlardan düşer.', pt: 'Feita apenas de Fragmentos. Caem de monstros a partir do nível {lv}.' },
  enhBurnWarn:     { ru: '⚠ Обычная заточка: при неудаче предмет сломается и исчезнет. Безопасная — предмет останется.', en: '⚠ Normal stone: on failure the item breaks and is lost. Safe stone: the item is kept.', uk: '⚠ Звичайна заточка: при невдачі предмет зламається і зникне. Безпечна — предмет залишиться.', es: '⚠ Piedra normal: si falla, el objeto se rompe y se pierde. Piedra segura: el objeto se conserva.', tr: '⚠ Normal taş: başarısız olursa eşya kırılır ve kaybolur. Güvenli taş: eşya kalır.', pt: '⚠ Pedra normal: em caso de falha o item quebra e é perdido. Pedra segura: o item permanece.' },
  enhFailKeepHint: { ru: 'При неудаче вещь останется', en: 'The item is kept on failure', uk: 'При невдачі річ залишиться', es: 'El objeto se conserva si falla', tr: 'Başarısızlıkta eşya kalır', pt: 'O item permanece em caso de falha' },
  normalStoneBtnFmt: { ru: 'Обычный ({n})', en: 'Normal ({n})', uk: 'Звичайний ({n})', es: 'Normal ({n})', tr: 'Normal ({n})', pt: 'Normal ({n})' },
  safeStoneBtnFmt: { ru: 'Безопасный ({n})', en: 'Safe ({n})', uk: 'Безпечний ({n})', es: 'Seguro ({n})', tr: 'Güvenli ({n})', pt: 'Seguro ({n})' },
  buffPotionSlotName: { ru: 'Зелье усиления', en: 'Buff Potion', uk: 'Зілля посилення', es: 'Poción de Refuerzo', tr: 'Güçlendirme İksiri', pt: 'Poção de Reforço' },
  boxSlotName: { ru: 'Бокс', en: 'Box', uk: 'Бокс', es: 'Caja', tr: 'Kutu', pt: 'Caixa' },
  activeRemainingFmt: { ru: '✓ Активно · осталось ~{n} мин', en: '✓ Active · ~{n} min left', uk: '✓ Активно · залишилось ~{n} хв', es: '✓ Activo · quedan ~{n} min', tr: '✓ Aktif · ~{n} dk kaldı', pt: '✓ Ativo · restam ~{n} min' },
  alreadyActiveLbl: { ru: 'Уже активно', en: 'Already active', uk: 'Вже активно', es: 'Ya activo', tr: 'Zaten aktif', pt: 'Já ativo' },
  statCritInline: { ru: 'Крит', en: 'Crit', uk: 'Крит', es: 'Crít', tr: 'Kritik', pt: 'Crít' },
  statSkillPowerInline: { ru: 'Сила навыков', en: 'Skill power', uk: 'Сила навичок', es: 'Poder de habilidad', tr: 'Beceri gücü', pt: 'Poder de habilidade' },
  statSpeedInline: { ru: 'Скор', en: 'Spd', uk: 'Швид', es: 'Vel', tr: 'Hız', pt: 'Vel' },
  enhanceTitleFmt: { ru: 'Заточка: {cur} → {next}', en: 'Enchant: {cur} → {next}', uk: 'Гартування: {cur} → {next}', es: 'Encantamiento: {cur} → {next}', tr: 'Büyü: {cur} → {next}', pt: 'Encantamento: {cur} → {next}' },
  enhChanceFmt: { ru: 'Шанс: {rate}%', en: 'Chance: {rate}%', uk: 'Шанс: {rate}%', es: 'Probabilidad: {rate}%', tr: 'Şans: %{rate}', pt: 'Chance: {rate}%' },
  maxEnhanceLbl: { ru: '✦ Максимальная заточка', en: '✦ Max enchant', uk: '✦ Максимальне гартування', es: '✦ Encantamiento máximo', tr: '✦ Maks. büyü', pt: '✦ Encantamento máximo' },
  equippedLbl: { ru: 'Надето', en: 'Equipped', uk: 'Одягнено', es: 'Equipado', tr: 'Kuşanıldı', pt: 'Equipado' },
  autoModeAbbrev: { ru: 'АВТО', en: 'AUTO', uk: 'АВТО', es: 'AUTO', tr: 'OTO', pt: 'AUTO' },
  autoSkillsHdr: { ru: 'Умения в АВТО', en: 'Skills in AUTO', uk: 'Уміння в АВТО', es: 'Habilidades en AUTO', tr: 'OTO’da yetenekler', pt: 'Habilidades no AUTO' },
  autoSkillsMasterLbl: { ru: 'Кастовать умения автоматически', en: 'Cast skills automatically', uk: 'Кастувати уміння автоматично', es: 'Lanzar habilidades automáticamente', tr: 'Yetenekleri otomatik kullan', pt: 'Usar habilidades automaticamente' },
  autoSkillsHint: { ru: 'В режиме АВТО персонаж сам применяет отмеченные умения — по одному раз в 1,2 с и только в бою. Лечащие — лишь ниже 70% HP.', en: 'In AUTO the character casts the ticked skills itself — one every 1.2s, and only in a fight. Healing ones only below 70% HP.', uk: 'У режимі АВТО персонаж сам застосовує позначені уміння — по одному раз на 1,2 с і лише в бою. Лікувальні — тільки нижче 70% HP.', es: 'En AUTO el personaje lanza solo las habilidades marcadas: una cada 1,2 s y solo en combate. Las de curación, solo por debajo del 70% de HP.', tr: 'OTO modunda karakter işaretli yetenekleri kendisi kullanır — 1,2 saniyede bir ve yalnızca savaşta. İyileştirme yetenekleri yalnızca %70 HP altında.', pt: 'No AUTO o personagem usa sozinho as habilidades marcadas — uma a cada 1,2 s e só em combate. As de cura, apenas abaixo de 70% de HP.' },
  autoSkillsVipHintFmt: { ru: 'Авто-умения работают с VIP {n}', en: 'Auto-cast requires VIP {n}', uk: 'Авто-уміння працюють з VIP {n}', es: 'El lanzamiento automático requiere VIP {n}', tr: 'Otomatik kullanım VIP {n} gerektirir', pt: 'O uso automático requer VIP {n}' },
  autoSkillNotForAuto: { ru: 'Не для авто', en: 'Not auto-cast', uk: 'Не для авто', es: 'No automática', tr: 'Otomatik değil', pt: 'Não automática' },
  autoSkillsOpenBtn: { ru: 'Настроить умения в АВТО', en: 'Configure skills in AUTO', uk: 'Налаштувати уміння в АВТО', es: 'Configurar habilidades en AUTO', tr: 'OTO yeteneklerini ayarla', pt: 'Configurar habilidades no AUTO' },
  autoSkillsHoldHint: { ru: 'Также открывается долгим нажатием на кнопку АВТО', en: 'Also opens by holding the AUTO button', uk: 'Також відкривається довгим натисканням на кнопку АВТО', es: 'También se abre manteniendo pulsado el botón AUTO', tr: 'OTO düğmesini basılı tutarak da açılır', pt: 'Também abre segurando o botão AUTO' },
  manualModeAbbrev: { ru: 'РУЧ', en: 'MAN', uk: 'РУЧ', es: 'MAN', tr: 'MAN', pt: 'MAN' },
  boxOpensRandomHint: { ru: 'Открытие даёт 1 случайный предмет:', en: 'Opening gives 1 random item:', uk: 'Відкриття дає 1 випадковий предмет:', es: 'Al abrir se obtiene 1 objeto aleatorio:', tr: 'Açmak 1 rastgele eşya verir:', pt: 'Abrir dá 1 item aleatório:' },
  openBtn: { ru: 'Открыть', en: 'Open', uk: 'Відкрити', es: 'Abrir', tr: 'Aç', pt: 'Abrir' },
  noStoneToast: { ru: 'Нет камня!', en: 'No stone!', uk: 'Немає каменя!', es: '¡Sin piedra!', tr: 'Taş yok!', pt: 'Sem pedra!' },
  enhSuccessToast: { ru: '+{n} Успех!', en: '+{n} Success!', uk: '+{n} Успіх!', es: '+{n} ¡Éxito!', tr: '+{n} Başarılı!', pt: '+{n} Sucesso!' },
  itemBurnedToast: { ru: 'Вещь сгорела!', en: 'The item burned!', uk: 'Річ згоріла!', es: '¡El objeto se destruyó!', tr: 'Eşya yandı!', pt: 'O item queimou!' },
  enhFailedToast: { ru: 'Заточка не удалась', en: 'Enchant failed', uk: 'Гартування не вдалося', es: 'El encantamiento falló', tr: 'Büyü başarısız oldu', pt: 'O encantamento falhou' },
  unequipBtn: { ru: 'Снять', en: 'Unequip', uk: 'Зняти', es: 'Desequipar', tr: 'Çıkar', pt: 'Desequipar' },
  youMarker: { ru: '(вы)', en: '(you)', uk: '(ви)', es: '(tú)', tr: '(sen)', pt: '(você)' },
  noDataLbl: { ru: 'Нет данных', en: 'No data', uk: 'Немає даних', es: 'Sin datos', tr: 'Veri yok', pt: 'Sem dados' },
  membersAbbrevFmt: { ru: '{n} участн.', en: '{n} members', uk: '{n} учасн.', es: '{n} miembros', tr: '{n} üye', pt: '{n} membros' },
  ratingUnlockToast: { ru: '🔒 Рейтинг с {n} уровня', en: '🔒 Rating from level {n}', uk: '🔒 Рейтинг з {n} рівня', es: '🔒 Clasificación desde nivel {n}', tr: '🔒 Sıralama seviye {n}\'den itibaren', pt: '🔒 Classificação a partir do nível {n}' },
  marketUnlockToast: { ru: '🔒 Маркет с {n} уровня', en: '🔒 Market from level {n}', uk: '🔒 Маркет з {n} рівня', es: '🔒 Mercado desde nivel {n}', tr: '🔒 Pazar seviye {n}\'den itibaren', pt: '🔒 Mercado a partir do nível {n}' },
  vipNextFmt: { ru: 'До VIP {lvl} · всего нужно {total} GRAM', en: 'To VIP {lvl} · {total} GRAM total needed', uk: 'До VIP {lvl} · всього потрібно {total} GRAM', es: 'Hasta VIP {lvl} · se necesitan {total} GRAM en total', tr: 'VIP {lvl}\'e · toplam {total} GRAM gerekli', pt: 'Até VIP {lvl} · necessário {total} GRAM no total' },
  vipMaxBadge: { ru: '👑 Максимальный VIP достигнут!', en: '👑 Max VIP reached!', uk: '👑 Максимальний VIP досягнуто!', es: '👑 ¡VIP máximo alcanzado!', tr: '👑 Maks. VIP\'e ulaşıldı!', pt: '👑 VIP máximo alcançado!' },
  vipGoldLbl: { ru: 'Золото', en: 'Gold', uk: 'Золото', es: 'Oro', tr: 'Altın', pt: 'Ouro' },
  vipDropLbl: { ru: 'Дроп', en: 'Drop', uk: 'Дроп', es: 'Botín', tr: 'Düşen', pt: 'Itens' },
  vipLevelsHdr: { ru: 'Уровни VIP', en: 'VIP Levels', uk: 'Рівні VIP', es: 'Niveles VIP', tr: 'VIP Seviyeleri', pt: 'Níveis VIP' },
  vipClaimBtn: { ru: 'Забрать награду', en: 'Claim Reward', uk: 'Забрати нагороду', es: 'Reclamar Recompensa', tr: 'Ödülü Al', pt: 'Resgatar Recompensa' },
  vipGoldShortSuffix: { ru: 'k зол.', en: 'k gold', uk: 'k зол.', es: 'k oro', tr: 'bin altın', pt: 'k ouro' },
  buyBtn: { ru: 'Купить', en: 'Buy', uk: 'Купити', es: 'Comprar', tr: 'Satın Al', pt: 'Comprar' },
  cancelListingBtn: { ru: 'Снять', en: 'Cancel', uk: 'Зняти', es: 'Cancelar', tr: 'Kaldır', pt: 'Cancelar' },
  catWeapon: { ru: 'Оружие', en: 'Weapons', uk: 'Зброя', es: 'Armas', tr: 'Silahlar', pt: 'Armas' },
  catHelmet: { ru: 'Шлемы', en: 'Helmets', uk: 'Шоломи', es: 'Cascos', tr: 'Kasklar', pt: 'Elmos' },
  catBody: { ru: 'Броня', en: 'Armor', uk: 'Броня', es: 'Armadura', tr: 'Zırh', pt: 'Armadura' },
  catGloves: { ru: 'Перчатки', en: 'Gloves', uk: 'Рукавиці', es: 'Guantes', tr: 'Eldivenler', pt: 'Luvas' },
  catBoots: { ru: 'Ботинки', en: 'Boots', uk: 'Черевики', es: 'Botas', tr: 'Botlar', pt: 'Botas' },
  catRing: { ru: 'Кольца', en: 'Rings', uk: 'Кільця', es: 'Anillos', tr: 'Yüzükler', pt: 'Anéis' },
  catBelt: { ru: 'Пояса', en: 'Belts', uk: 'Пояси', es: 'Cinturones', tr: 'Kemerler', pt: 'Cintos' },
  catCloak: { ru: 'Плащи', en: 'Cloaks', uk: 'Плащі', es: 'Capas', tr: 'Pelerinler', pt: 'Capas' },
  catArtifact: { ru: 'Артефакты', en: 'Artifacts', uk: 'Артефакти', es: 'Artefactos', tr: 'Eserler', pt: 'Artefatos' },
  catBooks: { ru: 'Книги', en: 'Books', uk: 'Книги', es: 'Libros', tr: 'Kitaplar', pt: 'Livros' },
  catPotions: { ru: 'Расходники', en: 'Consumables', uk: 'Витратні', es: 'Consumibles', tr: 'Tüketilenler', pt: 'Consumíveis' },
  catMaterials: { ru: 'Материалы', en: 'Materials', uk: 'Матеріали', es: 'Materiales', tr: 'Malzemeler', pt: 'Materiais' },
  catOther: { ru: 'Прочее', en: 'Other', uk: 'Інше', es: 'Otro', tr: 'Diğer', pt: 'Outro' },
  allCatLbl: { ru: 'Все', en: 'All', uk: 'Всі', es: 'Todos', tr: 'Tümü', pt: 'Todos' },
  marketSearchPlaceholder: { ru: 'Поиск предмета…', en: 'Search items…', uk: 'Пошук предмета…', es: 'Buscar objetos…', tr: 'Eşya ara…', pt: 'Buscar itens…' },
  allRaritiesLbl: { ru: 'Все редкости', en: 'All rarities', uk: 'Всі рідкості', es: 'Todas las rarezas', tr: 'Tüm nadirlikler', pt: 'Todas as raridades' },
  marketSortNew: { ru: 'Сначала новые', en: 'Newest first', uk: 'Спочатку нові', es: 'Más recientes', tr: 'Önce yeniler', pt: 'Mais recentes' },
  marketSortRarity: { ru: 'По редкости', en: 'By rarity', uk: 'За рідкістю', es: 'Por rareza', tr: 'Nadirliğe göre', pt: 'Por raridade' },
  marketSortPriceAsc: { ru: 'Цена ↑', en: 'Price ↑', uk: 'Ціна ↑', es: 'Precio ↑', tr: 'Fiyat ↑', pt: 'Preço ↑' },
  marketSortPriceDsc: { ru: 'Цена ↓', en: 'Price ↓', uk: 'Ціна ↓', es: 'Precio ↓', tr: 'Fiyat ↓', pt: 'Preço ↓' },
  marketNothingFoundHint: { ru: 'Ничего не найдено', en: 'Nothing found', uk: 'Нічого не знайдено', es: 'No se encontró nada', tr: 'Bir şey bulunamadı', pt: 'Nada encontrado' },
  noItemsInCategoryHint: { ru: 'Нет предметов в этой категории', en: 'No items in this category', uk: 'Немає предметів у цій категорії', es: 'No hay objetos en esta categoría', tr: 'Bu kategoride eşya yok', pt: 'Nenhum item nesta categoria' },
  nobodySellingHint: { ru: 'Пока никто ничего не продаёт', en: 'Nobody is selling anything yet', uk: 'Поки ніхто нічого не продає', es: 'Nadie está vendiendo nada todavía', tr: 'Henüz kimse bir şey satmıyor', pt: 'Ninguém está vendendo nada ainda' },
  addListingBtn: { ru: '+ Выставить лот', en: '+ List Item', uk: '+ Виставити лот', es: '+ Publicar Artículo', tr: '+ İlan Ver', pt: '+ Anunciar Item' },
  marketListVipRequiredToast: { ru: 'Продажа на маркете доступна с VIP 1', en: 'Selling on the market requires VIP 1', uk: 'Продаж на маркеті доступний з VIP 1', es: 'Vender en el mercado requiere VIP 1', tr: 'Pazarda satış VIP 1 gerektirir', pt: 'Vender no mercado requer VIP 1' },
  noActiveLotsHint: { ru: 'У вас нет активных лотов', en: "You don't have active listings", uk: 'У вас немає активних лотів', es: 'No tienes publicaciones activas', tr: 'Aktif ilanın yok', pt: 'Você não tem anúncios ativos' },
  historyEmptyHint: { ru: 'История пуста', en: 'History is empty', uk: 'Історія порожня', es: 'El historial está vacío', tr: 'Geçmiş boş', pt: 'O histórico está vazio' },
  cancelledLbl: { ru: 'Снято', en: 'Cancelled', uk: 'Знято', es: 'Cancelado', tr: 'Kaldırıldı', pt: 'Cancelado' },
  soldLbl: { ru: 'Продано', en: 'Sold', uk: 'Продано', es: 'Vendido', tr: 'Satıldı', pt: 'Vendido' },
  boughtLbl: { ru: 'Куплено', en: 'Bought', uk: 'Куплено', es: 'Comprado', tr: 'Satın alındı', pt: 'Comprado' },
  invFullFreeSpaceToast: { ru: 'Инвентарь полон — освободите место', en: 'Inventory full — free up space', uk: 'Інвентар повний — звільніть місце', es: 'Inventario lleno — libera espacio', tr: 'Envanter dolu — yer aç', pt: 'Inventário cheio — libere espaço' },
  confirmPurchaseTitle: { ru: 'Подтверждение покупки', en: 'Confirm Purchase', uk: 'Підтвердження покупки', es: 'Confirmar Compra', tr: 'Satın Almayı Onayla', pt: 'Confirmar Compra' },
  sellerLbl: { ru: 'Продавец: @{u}', en: 'Seller: @{u}', uk: 'Продавець: @{u}', es: 'Vendedor: @{u}', tr: 'Satıcı: @{u}', pt: 'Vendedor: @{u}' },
  priceLbl: { ru: 'Цена', en: 'Price', uk: 'Ціна', es: 'Precio', tr: 'Fiyat', pt: 'Preço' },
  yourBalanceLbl: { ru: 'Ваш баланс', en: 'Your balance', uk: 'Ваш баланс', es: 'Tu saldo', tr: 'Bakiyeniz', pt: 'Seu saldo' },
  buyForFmt: { ru: 'Купить за {price} GRAM', en: 'Buy for {price} GRAM', uk: 'Купити за {price} GRAM', es: 'Comprar por {price} GRAM', tr: '{price} GRAM\'a satın al', pt: 'Comprar por {price} GRAM' },
  notEnoughGramLbl: { ru: 'Недостаточно GRAM', en: 'Not enough GRAM', uk: 'Недостатньо GRAM', es: 'GRAM insuficiente', tr: 'Yeterli GRAM yok', pt: 'GRAM insuficiente' },
  listItemTitle: { ru: 'Выставить предмет', en: 'List Item', uk: 'Виставити предмет', es: 'Publicar Objeto', tr: 'Eşya İlanı Ver', pt: 'Anunciar Item' },
  selectFromInvHint: { ru: 'Выберите предмет из инвентаря', en: 'Select an item from your inventory', uk: 'Оберіть предмет з інвентаря', es: 'Selecciona un objeto de tu inventario', tr: 'Envanterinden bir eşya seç', pt: 'Selecione um item do seu inventário' },
  quantityLbl: { ru: 'Количество', en: 'Quantity', uk: 'Кількість', es: 'Cantidad', tr: 'Miktar', pt: 'Quantidade' },
  priceForAllFmt: { ru: 'Цена за всё количество ({min}–{max} GRAM)', en: 'Price for the whole stack ({min}–{max} GRAM)', uk: 'Ціна за всю кількість ({min}–{max} GRAM)', es: 'Precio por todo el lote ({min}–{max} GRAM)', tr: 'Tüm miktar için fiyat ({min}–{max} GRAM)', pt: 'Preço pelo lote todo ({min}–{max} GRAM)' },
  listForSaleBtn: { ru: 'Выставить на продажу', en: 'List for Sale', uk: 'Виставити на продаж', es: 'Publicar para la Venta', tr: 'Satışa Çıkar', pt: 'Anunciar para Venda' },
  youHaveFmt: { ru: 'У вас: ×{n}', en: 'You have: ×{n}', uk: 'У вас: ×{n}', es: 'Tienes: ×{n}', tr: 'Sende: ×{n}', pt: 'Você tem: ×{n}' },
  priceRangeFmt: { ru: 'Цена должна быть от {min} до {max} GRAM', en: 'Price must be between {min} and {max} GRAM', uk: 'Ціна має бути від {min} до {max} GRAM', es: 'El precio debe estar entre {min} y {max} GRAM', tr: 'Fiyat {min} ile {max} GRAM arasında olmalı', pt: 'O preço deve estar entre {min} e {max} GRAM' },
  feePreviewFmt: { ru: 'Комиссия 10% сгорает — вы получите {n} GRAM', en: '10% fee is burned — you will receive {n} GRAM', uk: 'Комісія 10% згорає — ви отримаєте {n} GRAM', es: 'La comisión del 10% se quema — recibirás {n} GRAM', tr: '%10 komisyon yanar — {n} GRAM alacaksın', pt: 'A taxa de 10% é queimada — você receberá {n} GRAM' },
  listingBusyLbl: { ru: 'Выставляем…', en: 'Listing…', uk: 'Виставляємо…', es: 'Publicando…', tr: 'İlan veriliyor…', pt: 'Publicando…' },
  listedForFmt: { ru: 'Лот «{name}» выставлен за {price} GRAM', en: 'Listing "{name}" posted for {price} GRAM', uk: 'Лот «{name}» виставлено за {price} GRAM', es: 'Artículo «{name}» publicado por {price} GRAM', tr: '"{name}" ilanı {price} GRAM\'a verildi', pt: 'Anúncio «{name}» publicado por {price} GRAM' },
  listingCancelledToast: { ru: 'Лот снят, предмет возвращён в инвентарь', en: 'Listing cancelled, item returned to inventory', uk: 'Лот знято, предмет повернуто в інвентар', es: 'Anuncio cancelado, objeto devuelto al inventario', tr: 'İlan kaldırıldı, eşya envantere döndü', pt: 'Anúncio cancelado, item devolvido ao inventário' },
  invFullItemLostToast: { ru: 'Инвентарь полон — предмет не поместился!', en: "Inventory full — the item didn't fit!", uk: 'Інвентар повний — предмет не помістився!', es: '¡Inventario lleno — el objeto no cupo!', tr: 'Envanter dolu — eşya sığmadı!', pt: 'Inventário cheio — o item não coube!' },
  boughtItemToast: { ru: 'Куплено: {name}', en: 'Bought: {name}', uk: 'Куплено: {name}', es: 'Comprado: {name}', tr: 'Satın alındı: {name}', pt: 'Comprado: {name}' },
  soldItemToast: { ru: 'Продано: {name} за {price} GRAM (+{payout} вам)', en: 'Sold: {name} for {price} GRAM (+{payout} to you)', uk: 'Продано: {name} за {price} GRAM (+{payout} вам)', es: 'Vendido: {name} por {price} GRAM (+{payout} para ti)', tr: 'Satıldı: {name}, {price} GRAM\'a (+{payout} sana)', pt: 'Vendido: {name} por {price} GRAM (+{payout} para você)' },
  genericErrorLbl: { ru: 'Ошибка', en: 'Error', uk: 'Помилка', es: 'Error', tr: 'Hata', pt: 'Erro' },
  locationDeniedToast: { ru: 'Не удалось перейти — попробуйте ещё раз', en: 'Could not travel — try again', uk: 'Не вдалося перейти — спробуйте ще раз', es: 'No se pudo viajar — inténtalo de nuevo', tr: 'Geçiş yapılamadı — tekrar dene', pt: 'Não foi possível viajar — tente de novo' },
  locationClosedToast: { ru: 'Локация сейчас закрыта', en: 'This location is closed right now', uk: 'Локація зараз зачинена', es: 'Esta ubicación está cerrada ahora', tr: 'Bu bölge şu an kapalı', pt: 'Este local está fechado agora' },
  locationLevelToast: { ru: 'Недостаточный уровень для этой локации', en: 'Your level is too low for this location', uk: 'Недостатній рівень для цієї локації', es: 'Tu nivel es demasiado bajo para esta ubicación', tr: 'Bu bölge için seviyen yetersiz', pt: 'Seu nível é baixo demais para este local' },
  ratingErrorToast: { ru: 'Не удалось загрузить рейтинг', en: 'Could not load the rating', uk: 'Не вдалося завантажити рейтинг', es: 'No se pudo cargar la clasificación', tr: 'Sıralama yüklenemedi', pt: 'Não foi possível carregar o ranking' },
  profileErrorToast: { ru: 'Не удалось загрузить профиль', en: 'Could not load the profile', uk: 'Не вдалося завантажити профіль', es: 'No se pudo cargar el perfil', tr: 'Profil yüklenemedi', pt: 'Não foi possível carregar o perfil' },
  prefsErrorToast: { ru: 'Настройки не сохранились — проверьте связь', en: 'Settings were not saved — check your connection', uk: 'Налаштування не збереглися — перевірте зв\'язок', es: 'Los ajustes no se guardaron — revisa tu conexión', tr: 'Ayarlar kaydedilmedi — bağlantını kontrol et', pt: 'As configurações não foram salvas — verifique a conexão' },
  gramShopBalanceFmt: { ru: 'Баланс: {bal} GRAM', en: 'Balance: {bal} GRAM', uk: 'Баланс: {bal} GRAM', es: 'Saldo: {bal} GRAM', tr: 'Bakiye: {bal} GRAM', pt: 'Saldo: {bal} GRAM' },
  affordableBuyBtn: { ru: 'Купить', en: 'Buy', uk: 'Купити', es: 'Comprar', tr: 'Satın Al', pt: 'Comprar' },
  notEnoughBtn: { ru: 'Мало', en: "Can't afford", uk: 'Мало', es: 'Insuficiente', tr: 'Yetersiz', pt: 'Insuficiente' },
  seasonTicketOwnedBtn: { ru: 'Куплено', en: 'Owned', uk: 'Куплено', es: 'Adquirido', tr: 'Alındı', pt: 'Adquirido' },
  gramShopGoldSuffix: { ru: 'зол.', en: 'gold', uk: 'зол.', es: 'oro', tr: 'altın', pt: 'ouro' },
  bonusSpSuffixShort: { ru: 'ОН', en: 'SP', uk: 'ОН', es: 'PH', tr: 'YP', pt: 'PH' },
  skillBooksTotalLbl: { ru: '{n} книг', en: '{n} books', uk: '{n} книг', es: '{n} libros', tr: '{n} kitap', pt: '{n} livros' },
  fullArmorSetFmt: { ru: '• Полный {rarity} сет', en: '• Full {rarity} set', uk: '• Повний {rarity} сет', es: '• Set {rarity} completo', tr: '• Tam {rarity} set', pt: '• Set {rarity} completo' },
  classWeaponFmt: { ru: '• Оружие {rarity} (по классу)', en: '• {rarity} weapon (class-specific)', uk: '• Зброя {rarity} (за класом)', es: '• Arma {rarity} (según clase)', tr: '• {rarity} silah (sınıfa göre)', pt: '• Arma {rarity} (por classe)' },
  bonusSkillPointsFmt: { ru: '• +{n} очков навыка', en: '• +{n} skill points', uk: '• +{n} очок навички', es: '• +{n} puntos de habilidad', tr: '• +{n} yetenek puanı', pt: '• +{n} pontos de habilidade' },
  classBooksSuffix: { ru: '(по классу)', en: '(class-specific)', uk: '(за класом)', es: '(según clase)', tr: '(sınıfa göre)', pt: '(por classe)' },
  rareBoxesLbl: { ru: 'редких бокса', en: 'rare boxes', uk: 'рідкісних бокси', es: 'cajas raras', tr: 'nadir kutu', pt: 'caixas raras' },
  uncommonBoxesLbl: { ru: 'необычных бокса', en: 'uncommon boxes', uk: 'незвичайних бокси', es: 'cajas poco comunes', tr: 'nadir olmayan kutu', pt: 'caixas incomuns' },
  gramPkgLabel_pkg1: { ru: 'Стартовый', en: 'Starter', uk: 'Стартовий', es: 'Inicial', tr: 'Başlangıç', pt: 'Inicial' },
  gramPkgLabel_pkg5: { ru: 'Базовый', en: 'Basic', uk: 'Базовий', es: 'Básico', tr: 'Temel', pt: 'Básico' },
  gramPkgLabel_pkg10: { ru: 'Стандарт', en: 'Standard', uk: 'Стандарт', es: 'Estándar', tr: 'Standart', pt: 'Padrão' },
  gramPkgLabel_pkg50: { ru: 'Элитный', en: 'Elite', uk: 'Елітний', es: 'Élite', tr: 'Elit', pt: 'Elite' },
  gramPkgLabel_pkg100: { ru: 'Легендарный', en: 'Legendary', uk: 'Легендарний', es: 'Legendario', tr: 'Efsanevi', pt: 'Lendário' },
  gramPkgLabel_pkg300: { ru: 'Эпический', en: 'Epic', uk: 'Епічний', es: 'Épico', tr: 'Epik', pt: 'Épico' },
  starterBonusBtn: { ru: 'Бонус', en: 'Bonus', uk: 'Бонус', es: 'Bono', tr: 'Bonus', pt: 'Bônus' },
  starterBonusTitle: { ru: 'Набор новичка', en: 'Starter kit', uk: 'Набір новачка', es: 'Kit de inicio', tr: 'Başlangıç seti', pt: 'Kit inicial' },
  starterBonusDesc: { ru: 'Бесплатный набор — выдаётся один раз на аккаунт. Оружие подбирается под ваш класс.', en: 'A free kit — one per account. The weapon matches your class.', uk: 'Безкоштовний набір — видається один раз на акаунт. Зброя добирається під ваш клас.', es: 'Un kit gratuito, uno por cuenta. El arma corresponde a tu clase.', tr: 'Ücretsiz set — hesap başına bir kez. Silah sınıfınıza göre seçilir.', pt: 'Um kit gratuito — um por conta. A arma corresponde à sua classe.' },
  starterBonusClaimBtn: { ru: 'Забрать', en: 'Claim', uk: 'Забрати', es: 'Reclamar', tr: 'Al', pt: 'Resgatar' },
  starterBonusDoneToast: { ru: '✓ Набор новичка получен!', en: '✓ Starter kit claimed!', uk: '✓ Набір новачка отримано!', es: '✓ ¡Kit de inicio reclamado!', tr: '✓ Başlangıç seti alındı!', pt: '✓ Kit inicial resgatado!' },
  epicPackIncludesHdr: { ru: 'В пак входит:', en: 'The pack includes:', uk: 'До паку входить:', es: 'El pack incluye:', tr: 'Pakete dahil:', pt: 'O pack inclui:' },
  epicPackPerk1: { ru: 'Видеоинструкция как сделать с нуля свою игру/майнер/тапалку', en: 'A video guide on building your own game/miner/clicker from scratch', uk: 'Відеоінструкція, як створити свою гру/майнер/тапалку з нуля', es: 'Videoguía para crear tu propio juego/minero/clicker desde cero', tr: 'Sıfırdan kendi oyununu/mineriniz/tıklama oyununu yapma video rehberi', pt: 'Videoaula de como criar seu próprio jogo/minerador/clicker do zero' },
  epicPackPerk2: { ru: 'Доступ к закрытому чату где будет оказываться помощь', en: 'Access to a private chat where you’ll get help', uk: 'Доступ до закритого чату, де надаватиметься допомога', es: 'Acceso a un chat privado donde recibirás ayuda', tr: 'Yardım alacağınız özel bir sohbete erişim', pt: 'Acesso a um chat privado onde você receberá ajuda' },
  epicPackPerk3: { ru: 'Детальное объяснение всего, даже тот кто ни разу не видел код поймёт как работать', en: 'A detailed walkthrough of everything — even someone who has never seen code will understand how it works', uk: 'Детальне пояснення всього — зрозуміє навіть той, хто ніколи не бачив код', es: 'Explicación detallada de todo — hasta alguien que nunca vio código entenderá cómo funciona', tr: 'Her şeyin ayrıntılı açıklaması — kodu hiç görmemiş biri bile nasıl çalıştığını anlayacak', pt: 'Explicação detalhada de tudo — até quem nunca viu código vai entender como funciona' },
  epicPackPerk4: { ru: 'Консультация в дальнейшем', en: 'Ongoing consultation afterwards', uk: 'Консультація надалі', es: 'Consultas continuas después', tr: 'İleride danışmanlık', pt: 'Consultoria contínua depois' },
  epicPackPerk5: { ru: 'Полный разбор с чистого листа до полноценного приложения', en: 'A full walkthrough from a blank page to a finished app', uk: 'Повний розбір з чистого аркуша до повноцінного застосунку', es: 'Un recorrido completo desde cero hasta una aplicación terminada', tr: 'Boş sayfadan tam bir uygulamaya kadar eksiksiz anlatım', pt: 'Um passo a passo completo do zero até um aplicativo pronto' },
  goldAmountFmt: { ru: '• {n} золота', en: '• {n} gold', uk: '• {n} золота', es: '• {n} de oro', tr: '• {n} altın', pt: '• {n} de ouro' },
  eachPotionFmt: { ru: '• {n}× каждое зелье (6 видов)', en: '• {n}× of each potion (6 kinds)', uk: '• {n}× кожне зілля (6 видів)', es: '• {n}× de cada poción (6 tipos)', tr: '• her iksirden {n}× (6 çeşit)', pt: '• {n}× de cada poção (6 tipos)' },
  costLbl: { ru: 'Стоимость', en: 'Cost', uk: 'Вартість', es: 'Costo', tr: 'Maliyet', pt: 'Custo' },
  packageFallbackLbl: { ru: 'Пакет', en: 'Package', uk: 'Пакет', es: 'Paquete', tr: 'Paket', pt: 'Pacote' },
  pkgBoughtToast: { ru: '✓ {lbl} куплен!', en: '✓ {lbl} purchased!', uk: '✓ {lbl} придбано!', es: '✓ ¡{lbl} comprado!', tr: '✓ {lbl} satın alındı!', pt: '✓ {lbl} comprado!' },
  purchaseErrorLbl: { ru: 'Ошибка покупки', en: 'Purchase error', uk: 'Помилка покупки', es: 'Error de compra', tr: 'Satın alma hatası', pt: 'Erro na compra' },
  specialChooseBtn: { ru: 'Выбрать', en: 'Choose', uk: 'Обрати', es: 'Elegir', tr: 'Seç', pt: 'Escolher' },
  packNFmt: { ru: 'Пак {n}', en: 'Pack {n}', uk: 'Пак {n}', es: 'Paquete {n}', tr: 'Paket {n}', pt: 'Pacote {n}' },
  petChoiceLbl: { ru: 'Питомец', en: 'Pet', uk: 'Улюбленець', es: 'Mascota', tr: 'Evcil hayvan', pt: 'Mascote' },
  petPickerHint: { ru: 'Выберите питомца', en: 'Choose a pet', uk: 'Оберіть улюбленця', es: 'Elige una mascota', tr: 'Bir evcil hayvan seç', pt: 'Escolha um mascote' },
  refLinkCardTitle: { ru: 'Ваша реферальная ссылка', en: 'Your referral link', uk: 'Ваше реферальне посилання', es: 'Tu enlace de referido', tr: 'Referans bağlantın', pt: 'Seu link de indicação' },
  copyBtn: { ru: 'Копировать', en: 'Copy', uk: 'Копіювати', es: 'Copiar', tr: 'Kopyala', pt: 'Copiar' },
  copiedLbl: { ru: 'Скопировано!', en: 'Copied!', uk: 'Скопійовано!', es: '¡Copiado!', tr: 'Kopyalandı!', pt: 'Copiado!' },
  refBonusHintFmt: { ru: 'За каждый депозит друга вы получаете {pct}', en: 'You get {pct} on every deposit a friend makes', uk: 'За кожен депозит друга ви отримуєте {pct}', es: 'Recibes {pct} en cada depósito de un amigo', tr: 'Bir arkadaşın her yatırımından {pct} kazanırsın', pt: 'Você recebe {pct} a cada depósito de um amigo' },
  friendsCountLbl: { ru: 'Друзей', en: 'Friends', uk: 'Друзів', es: 'Amigos', tr: 'Arkadaş', pt: 'Amigos' },
  gramReceivedLbl: { ru: 'GRAM получено', en: 'GRAM received', uk: 'GRAM отримано', es: 'GRAM recibido', tr: 'Alınan GRAM', pt: 'GRAM recebido' },
  friendsListHdr: { ru: 'Список друзей', en: 'Friends List', uk: 'Список друзів', es: 'Lista de Amigos', tr: 'Arkadaş Listesi', pt: 'Lista de Amigos' },
  noFriendsInvitedHint: { ru: 'Пока нет приглашённых друзей', en: 'No friends invited yet', uk: 'Поки немає запрошених друзів', es: 'Aún no hay amigos invitados', tr: 'Henüz davet edilen arkadaş yok', pt: 'Ainda não há amigos convidados' },
  sendLinkHint: { ru: 'Отправьте ссылку и получайте бонусы', en: 'Send the link and earn bonuses', uk: 'Надішліть посилання та отримуйте бонуси', es: 'Envía el enlace y gana bonos', tr: 'Bağlantıyı gönder ve bonus kazan', pt: 'Envie o link e ganhe bônus' },
  playerFallbackLbl: { ru: 'игрок', en: 'player', uk: 'гравець', es: 'jugador', tr: 'oyuncu', pt: 'jogador' },
  friendJoinedToast: { ru: 'Друг @{u} присоединился!', en: 'Friend @{u} joined!', uk: 'Друг @{u} приєднався!', es: '¡Tu amigo @{u} se unió!', tr: 'Arkadaşın @{u} katıldı!', pt: 'Amigo @{u} entrou!' },
  refBonusReceivedToast: { ru: '+{n} GRAM от реферала @{u}', en: '+{n} GRAM from referral @{u}', uk: '+{n} GRAM від реферала @{u}', es: '+{n} GRAM de referido @{u}', tr: 'Referans @{u}\'den +{n} GRAM', pt: '+{n} GRAM de indicado @{u}' },
  airdropCollectHint: { ru: 'Собирайте монеты Liberty', en: 'Collect Liberty coins', uk: 'Збирайте монети Liberty', es: 'Recolecta monedas Liberty', tr: 'Liberty parası topla', pt: 'Colete moedas Liberty' },
  gramBalanceLbl: { ru: 'Баланс GRAM', en: 'GRAM Balance', uk: 'Баланс GRAM', es: 'Saldo GRAM', tr: 'GRAM Bakiyesi', pt: 'Saldo GRAM' },
  depositBtn: { ru: '↓ Пополнить', en: '↓ Deposit', uk: '↓ Поповнити', es: '↓ Depositar', tr: '↓ Yatır', pt: '↓ Depositar' },
  withdrawBtn: { ru: '↑ Вывести', en: '↑ Withdraw', uk: '↑ Вивести', es: '↑ Retirar', tr: '↑ Çek', pt: '↑ Sacar' },
  txHistoryHdr: { ru: 'История операций', en: 'Transaction History', uk: 'Історія операцій', es: 'Historial de Transacciones', tr: 'İşlem Geçmişi', pt: 'Histórico de Transações' },
  noTxYetHint: { ru: 'Операций пока нет', en: 'No transactions yet', uk: 'Операцій поки немає', es: 'Aún no hay transacciones', tr: 'Henüz işlem yok', pt: 'Ainda não há transações' },
  txDoneLbl: { ru: '✓ Выполнено', en: '✓ Done', uk: '✓ Виконано', es: '✓ Completado', tr: '✓ Tamamlandı', pt: '✓ Concluído' },
  txRejectedLbl: { ru: '✕ Отклонено', en: '✕ Rejected', uk: '✕ Відхилено', es: '✕ Rechazado', tr: '✕ Reddedildi', pt: '✕ Rejeitado' },
  txWaitingLbl: { ru: '⏳ Ожидание', en: '⏳ Waiting', uk: '⏳ Очікування', es: '⏳ Esperando', tr: '⏳ Bekleniyor', pt: '⏳ Aguardando' },
  depositTypeLbl: { ru: 'Пополнение', en: 'Deposit', uk: 'Поповнення', es: 'Depósito', tr: 'Yatırma', pt: 'Depósito' },
  withdrawTypeLbl: { ru: 'Вывод', en: 'Withdrawal', uk: 'Виведення', es: 'Retiro', tr: 'Çekme', pt: 'Saque' },
  walletNotSetLbl: { ru: 'Адрес не настроен', en: 'Address not configured', uk: 'Адресу не налаштовано', es: 'Dirección no configurada', tr: 'Adres ayarlanmadı', pt: 'Endereço não configurado' },
  depositModalTitle: { ru: 'Пополнение GRAM', en: 'Deposit GRAM', uk: 'Поповнення GRAM', es: 'Depositar GRAM', tr: 'GRAM Yatır', pt: 'Depositar GRAM' },
  transferToWalletHint: { ru: 'Переведите GRAM на адрес кошелька:', en: 'Transfer GRAM to this wallet address:', uk: 'Переведіть GRAM на адресу гаманця:', es: 'Transfiere GRAM a esta dirección de billetera:', tr: 'GRAM\'ı bu cüzdan adresine transfer et:', pt: 'Transfira GRAM para este endereço de carteira:' },
  memoRequiredHint: { ru: 'Обязательно укажите MEMO (комментарий):', en: 'Be sure to include the MEMO (comment):', uk: "Обов'язково вкажіть MEMO (коментар):", es: 'Asegúrate de incluir el MEMO (comentario):', tr: 'MEMO (yorum) eklemeyi unutma:', pt: 'Certifique-se de incluir o MEMO (comentário):' },
  memoWarnHint: { ru: '⚠ Без мемо перевод не будет зачислен', en: "⚠ Without the memo, the transfer won't be credited", uk: '⚠ Без мемо переказ не буде зараховано', es: '⚠ Sin el memo, la transferencia no se acreditará', tr: '⚠ Memo olmadan transfer hesaba geçmez', pt: '⚠ Sem o memo, a transferência não será creditada' },
  transferAmountHint: { ru: 'Сумма перевода:', en: 'Transfer amount:', uk: 'Сума переказу:', es: 'Monto de la transferencia:', tr: 'Transfer tutarı:', pt: 'Valor da transferência:' },
  enterGramAmountPlaceholder: { ru: 'Введите сумму GRAM', en: 'Enter the GRAM amount', uk: 'Введіть суму GRAM', es: 'Ingresa el monto en GRAM', tr: 'GRAM tutarını gir', pt: 'Digite o valor em GRAM' },
  iPaidBtn: { ru: 'Я оплатил ✓', en: 'I paid ✓', uk: 'Я оплатив ✓', es: 'Ya pagué ✓', tr: 'Ödedim ✓', pt: 'Eu paguei ✓' },
  minAmountErrToast: { ru: 'Введите сумму от 1 GRAM', en: 'Enter an amount of at least 1 GRAM', uk: 'Введіть суму від 1 GRAM', es: 'Ingresa un monto de al menos 1 GRAM', tr: 'En az 1 GRAM tutar gir', pt: 'Digite um valor de no mínimo 1 GRAM' },
  serviceUnavailableToast: { ru: 'Сервис недоступен', en: 'Service unavailable', uk: 'Сервіс недоступний', es: 'Servicio no disponible', tr: 'Hizmet kullanılamıyor', pt: 'Serviço indisponível' },
  depositRequestCreatedToast: { ru: 'Заявка на пополнение создана — ожидайте подтверждения', en: 'Deposit request created — awaiting confirmation', uk: 'Заявку на поповнення створено — очікуйте підтвердження', es: 'Solicitud de depósito creada — espera confirmación', tr: 'Yatırma talebi oluşturuldu — onay bekleniyor', pt: 'Solicitação de depósito criada — aguarde confirmação' },
  withdrawModalTitle: { ru: 'Вывод GRAM', en: 'Withdraw GRAM', uk: 'Виведення GRAM', es: 'Retirar GRAM', tr: 'GRAM Çek', pt: 'Sacar GRAM' },
  availableFeeFmt: { ru: 'Доступно: {bal} GRAM · Комиссия 10%', en: 'Available: {bal} GRAM · 10% fee', uk: 'Доступно: {bal} GRAM · Комісія 10%', es: 'Disponible: {bal} GRAM · Comisión 10%', tr: 'Kullanılabilir: {bal} GRAM · %10 komisyon', pt: 'Disponível: {bal} GRAM · Taxa de 10%' },
  withdrawAmountHint: { ru: 'Сумма вывода (мин. {n} GRAM):', en: 'Withdrawal amount (min. {n} GRAM):', uk: 'Сума виведення (мін. {n} GRAM):', es: 'Monto a retirar (mín. {n} GRAM):', tr: 'Çekim tutarı (min. {n} GRAM):', pt: 'Valor do saque (mín. {n} GRAM):' },
  gramAmountPlaceholder: { ru: 'Сумма GRAM', en: 'GRAM amount', uk: 'Сума GRAM', es: 'Monto en GRAM', tr: 'GRAM tutarı', pt: 'Valor em GRAM' },
  tonAddrHint: { ru: 'TON-адрес получателя:', en: "Recipient's TON address:", uk: 'TON-адреса отримувача:', es: 'Dirección TON del destinatario:', tr: 'Alıcının TON adresi:', pt: 'Endereço TON do destinatário:' },
  withdrawVipRequiredFmt: { ru: '🔒 Вывод GRAM доступен с VIP {n}', en: '🔒 Withdrawing GRAM requires VIP {n}', uk: '🔒 Виведення GRAM доступне з VIP {n}', es: '🔒 Retirar GRAM requiere VIP {n}', tr: '🔒 GRAM çekmek VIP {n} gerektirir', pt: '🔒 Sacar GRAM requer VIP {n}' },
  submitWithdrawBtn: { ru: 'Подать заявку на вывод', en: 'Submit Withdrawal Request', uk: 'Подати заявку на виведення', es: 'Enviar Solicitud de Retiro', tr: 'Çekim Talebi Gönder', pt: 'Enviar Solicitação de Saque' },
  feeReceiveFmt: { ru: 'Комиссия {fee} GRAM — к получению: {net} GRAM', en: 'Fee {fee} GRAM — you will receive: {net} GRAM', uk: 'Комісія {fee} GRAM — до отримання: {net} GRAM', es: 'Comisión {fee} GRAM — recibirás: {net} GRAM', tr: 'Komisyon {fee} GRAM — alacağın: {net} GRAM', pt: 'Taxa {fee} GRAM — você receberá: {net} GRAM' },
  minWithdrawToast: { ru: 'Минимум {n} GRAM', en: 'Minimum {n} GRAM', uk: 'Мінімум {n} GRAM', es: 'Mínimo {n} GRAM', tr: 'Minimum {n} GRAM', pt: 'Mínimo {n} GRAM' },
  enterTonAddrToast: { ru: 'Введите TON-адрес', en: 'Enter a TON address', uk: 'Введіть TON-адресу', es: 'Ingresa una dirección TON', tr: 'Bir TON adresi gir', pt: 'Digite um endereço TON' },
  notEnoughFundsToast: { ru: 'Недостаточно средств', en: 'Insufficient funds', uk: 'Недостатньо коштів', es: 'Fondos insuficientes', tr: 'Yetersiz bakiye', pt: 'Fundos insuficientes' },
  withdrawRequestCreatedFmt: { ru: 'Заявка на вывод создана — к получению: {net} GRAM', en: 'Withdrawal request created — you will receive: {net} GRAM', uk: 'Заявку на виведення створено — до отримання: {net} GRAM', es: 'Solicitud de retiro creada — recibirás: {net} GRAM', tr: 'Çekim talebi oluşturuldu — alacağın: {net} GRAM', pt: 'Solicitação de saque criada — você receberá: {net} GRAM' },
  equipBtn: { ru: 'Надеть', en: 'Equip', uk: 'Одягнути', es: 'Equipar', tr: 'Kuşan', pt: 'Equipar' },
  sellForFmt: { ru: 'Продать за 100', en: 'Sell for 100', uk: 'Продати за 100', es: 'Vender por 100', tr: '100\'e sat', pt: 'Vender por 100' },
  evtBossIncomingFmt: { ru: '⚔️ Через {time} появится босс — портал в зале', en: '⚔️ A boss appears in {time} — portal in the hall', uk: '⚔️ Через {time} з\'явиться бос — портал у залі', es: '⚔️ Un jefe aparecerá en {time} — portal en el salón', tr: '⚔️ {time} sonra bir boss belirecek — salonda portal', pt: '⚔️ Um chefe aparecerá em {time} — portal no salão' },
  evtArenaLbl: { ru: '⚔️ Арена босса', en: '⚔️ Boss Arena', uk: '⚔️ Арена боса', es: '⚔️ Arena del Jefe', tr: '⚔️ Boss Arenası', pt: '⚔️ Arena do Chefe' },
  evtBossArrived: { ru: '🔥 Босс появился! Портал в зале', en: '🔥 The boss has appeared!', uk: '🔥 Бос з\'явився!', es: '🔥 ¡El jefe ha aparecido!', tr: '🔥 Boss belirdi!', pt: '🔥 O chefe apareceu!' },
  evtBossDefeated: { ru: '🏆 Босс повержен! Собирайте добычу', en: '🏆 The boss is defeated! Grab the loot', uk: '🏆 Боса переможено! Збирайте здобич', es: '🏆 ¡Jefe derrotado! Recoge el botín', tr: '🏆 Boss yenildi! Ganimeti topla', pt: '🏆 Chefe derrotado! Pegue o loot' },

  guildWarLbl: { ru: '🏰 Война гильдий', en: '🏰 Guild War', uk: '🏰 Війна гільдій', es: '🏰 Guerra de Clanes', tr: '🏰 Klan Savaşı', pt: '🏰 Guerra de Clãs' },
  farmZoneLbl: { ru: '🌾 Фарм зона', en: '🌾 Farm Zone', uk: '🌾 Ферм-зона', es: '🌾 Zona de Farmeo', tr: '🌾 Farm Bölgesi', pt: '🌾 Zona de Farm' },
  portalLbl: { ru: '🌀 Телепорт', en: '🌀 Portal', uk: '🌀 Телепорт', es: '🌀 Portal', tr: '🌀 Portal', pt: '🌀 Portal' },
  portalPickTitle: { ru: 'Куда телепортироваться?', en: 'Where to teleport?', uk: 'Куди телепортуватися?', es: '¿A dónde teletransportarse?', tr: 'Nereye ışınlanmak istersin?', pt: 'Para onde teleportar?' },
  // Teleport-stone button (above the chat button) — spends a stone bought
  // from the merchant (see teleportStoneMerchantHdr) to recall to the hub
  // after a channelled cast, from anywhere.
  teleportBtnTitle: { ru: 'Камни телепортации', en: 'Teleport stones', uk: 'Камені телепортації', es: 'Piedras de teletransporte', tr: 'Işınlanma taşları', pt: 'Pedras de teleporte' },
  teleportStoneNoneMsg: { ru: 'Нет камня телепортации — купите у торговца', en: 'No teleport stone — buy one from the merchant', uk: 'Немає каменя телепортації — купіть у торговця', es: 'Sin piedra de teletransporte — cómprala al mercader', tr: 'Işınlanma taşı yok — tüccardan satın al', pt: 'Sem pedra de teleporte — compre com o mercador' },
  teleportStoneMerchantHdr: { ru: 'Камни телепортации', en: 'Teleport stones', uk: 'Камені телепортації', es: 'Piedras de teletransporte', tr: 'Işınlanma taşları', pt: 'Pedras de teleporte' },
  teleportStoneMerchantSub: { ru: 'Телепорт в центральный зал (каст 7 сек)', en: 'Teleports to the central hall (7s cast)', uk: 'Телепорт у центральний зал (каст 7 сек)', es: 'Teletransporta al salón central (canalización de 7s)', tr: 'Merkez salona ışınlanma (7sn kanal)', pt: 'Teleporta para o salão central (canalização de 7s)' },
  npcNotEnoughLiberty: { ru: 'Мало Liberty!', en: 'Not enough Liberty!', uk: 'Мало Liberty!', es: '¡Falta Liberty!', tr: 'Yetersiz Liberty!', pt: 'Liberty insuficiente!' },
  // Map panel's monster reference list, Фарм-зона variant — see
  // updateFloorUI/_farmZoneMonsterListHtml, js/ui.js.
  farmBestiaryHint: { ru: 'Уровень варьируется 21-30 у каждого монстра отдельно — здесь показан средний.', en: 'Each monster rolls its own level 21-30 — shown here is the average.', uk: 'Рівень варіюється 21-30 в кожного монстра окремо — тут показано середній.', es: 'Cada monstruo tiene su propio nivel 21-30 — aquí se muestra el promedio.', tr: 'Her canavarın kendi seviyesi 21-30 arasında — burada ortalama gösteriliyor.', pt: 'Cada monstro sorteia seu próprio nível 21-30 — aqui é mostrada a média.' },
  farmLevelRangeLbl: { ru: 'Уровень 21-30', en: 'Level 21-30', uk: 'Рівень 21-30', es: 'Nivel 21-30', tr: 'Seviye 21-30', pt: 'Nível 21-30' },
  noMonstersHereHint: { ru: 'Здесь монстров нет — зайдите в один из коридоров, чтобы увидеть список.', en: 'No monsters here — enter one of the corridors to see the list.', uk: 'Тут монстрів немає — зайдіть в один з коридорів, щоб побачити список.', es: 'Aquí no hay monstruos — entra en uno de los corredores para ver la lista.', tr: 'Burada canavar yok — listeyi görmek için koridorlardan birine gir.', pt: 'Não há monstros aqui — entre em um dos corredores para ver a lista.' },

  // ── Профессия HUD panel (openProfessionPanel, js/ui.js) — second-profession
  // codex reachable from the HUD button under Мир/ПК.
  professionHdr: { ru: 'Профессия', en: 'Profession', uk: 'Професія', es: 'Profesión', tr: 'Meslek', pt: 'Profissão' },
  profpBannerSub: { ru: 'Вторая грань каждого умения', en: 'A second edge to every skill', uk: 'Друга грань кожного вміння', es: 'Una segunda faceta de cada habilidad', tr: 'Her yeteneğin ikinci yüzü', pt: 'Uma segunda face de cada habilidade' },
  profpLockedFmt: { ru: 'Прокачай навык книгами — {n}/10', en: 'Level the skill up with books — {n}/10', uk: 'Прокачай навичку книгами — {n}/10', es: 'Sube la habilidad con libros — {n}/10', tr: 'Kitaplarla yeteneği yükselt — {n}/10', pt: 'Suba a habilidade com livros — {n}/10' },
  profpNeedBooksFmt: { ru: 'Книг найдено {have} из {need}', en: '{have} of {need} books found', uk: 'Книг знайдено {have} з {need}', es: '{have} de {need} libros encontrados', tr: '{have}/{need} kitap bulundu', pt: '{have} de {need} livros encontrados' },
  profpLearnBtn: { ru: 'Изучить', en: 'Learn', uk: 'Вивчити', es: 'Aprender', tr: 'Öğren', pt: 'Aprender' },
  profpNowLbl: { ru: 'Сейчас', en: 'Now', uk: 'Зараз', es: 'Ahora', tr: 'Şimdi', pt: 'Agora' },
  profpWillBeLbl: { ru: 'Станет', en: 'Will become', uk: 'Стане', es: 'Se convertirá', tr: 'Olacak', pt: 'Se tornará' },
  profpFarmHint: { ru: '📖 Книги продвинутых навыков падают только в Фарм зоне (21-30 ур.)', en: '📖 Advanced-skill books drop only in the Farm Zone (lvl 21-30)', uk: '📖 Книги просунутих навичок падають лише у Ферм-зоні (21-30 рів.)', es: '📖 Los libros de habilidad avanzada solo caen en la Zona de Farmeo (niv. 21-30)', tr: '📖 Gelişmiş yetenek kitapları yalnızca Farm Bölgesi\'nde düşer (sv. 21-30)', pt: '📖 Livros de habilidade avançada só caem na Zona de Farm (nv. 21-30)' },

  // ── "What's new" login modal (js/ui.js's openWhatsNewModal, shown once per
  // WHATS_NEW_VERSION via localStorage — see js/network.js's _finishOnlineStart) ──
  whatsNewTitle: { ru: 'Обновление', en: 'Update', uk: 'Оновлення', es: 'Actualización', tr: 'Güncelleme', pt: 'Atualização' },
  whatsNewCodexTitle: { ru: 'Кодекс наборов', en: 'Item Collections', uk: 'Кодекс наборів', es: 'Colecciones de objetos', tr: 'Eşya Koleksiyonları', pt: 'Coleções de itens' },
  whatsNewCodexDesc: {
    ru: 'Собирай наборы из 2-4 предметов (часто на определённой заточке) в новой панели «Кодекс» на HUD — за каждый завершённый набор персонаж навсегда получает бонус к статам. Всего почти 1000 наборов.',
    en: 'Collect sets of 2-4 items — often at a specific enchant level — in the new Codex panel on the HUD. Completing a set grants your character a permanent stat bonus. Almost 1000 collections in total.',
    uk: 'Збирай набори з 2-4 предметів (часто на певній заточці) у новій панелі «Кодекс» на HUD — за кожен завершений набір персонаж назавжди отримує бонус до статів. Загалом майже 1000 наборів.',
    es: 'Reúne sets de 2-4 objetos (a menudo con un nivel de mejora específico) en el nuevo panel Códice del HUD. Completar un set otorga a tu personaje una bonificación de estadísticas permanente. Casi 1000 colecciones en total.',
    tr: 'HUD üzerindeki yeni Kodeks panelinde 2-4 eşyalık setler topla (genellikle belirli bir güçlendirme seviyesinde). Bir seti tamamlamak karakterine kalıcı bir stat bonusu verir. Toplamda yaklaşık 1000 koleksiyon.',
    pt: 'Reúna conjuntos de 2-4 itens (muitas vezes com um nível de aprimoramento específico) no novo painel Códex do HUD. Completar um conjunto concede ao seu personagem um bônus de status permanente. Quase 1000 coleções ao todo.',
  },
  whatsNewCloseBtn: { ru: 'Понятно', en: 'Got it', uk: 'Зрозуміло', es: 'Entendido', tr: 'Anladım', pt: 'Entendi' },
  guildWarTab: { ru: 'Война гильдий', en: 'Guild War', uk: 'Війна гільдій', es: 'Guerra de Clanes', tr: 'Klan Savaşı', pt: 'Guerra de Clãs' },
  guildWarPhaseOpen:   { ru: 'Локация открыта', en: 'Zone is open', uk: 'Локація відкрита', es: 'Zona abierta', tr: 'Bölge açık', pt: 'Zona aberta' },
  guildWarPhaseClosed: { ru: 'До открытия локации', en: 'Zone opens in', uk: 'До відкриття локації', es: 'La zona abre en', tr: 'Bölge açılana kadar', pt: 'A zona abre em' },
  guildWarNoteOpen: { ru: 'Заходи через портал в зале', en: 'Enter through the portal in the hall', uk: 'Заходь через портал у залі', es: 'Entra por el portal en el salón', tr: 'Salondaki portaldan gir', pt: 'Entre pelo portal no salão' },
  guildWarOwnerLbl:   { ru: 'Замком владеет', en: 'Tower held by', uk: 'Замком володіє', es: 'Torre en poder de', tr: 'Kaleye sahip', pt: 'Torre controlada por' },
  guildWarNoOwnerLbl: { ru: 'Замок пока никем не захвачен', en: 'The tower is unclaimed', uk: 'Замок ще нікому не належить', es: 'La torre está sin dueño', tr: 'Kale henüz ele geçirilmedi', pt: 'A torre está sem dono' },
  guildWarScheduleHdr: { ru: 'Расписание:', en: 'Schedule:', uk: 'Розклад:', es: 'Horario:', tr: 'Program:', pt: 'Programação:' },
  guildWarRule1: { ru: 'Каждый день с 22:00 до 22:15 по Москве', en: 'Every day 22:00–22:15 Moscow time', uk: 'Щодня з 22:00 до 22:15 за Москвою', es: 'Todos los días de 22:00 a 22:15 hora de Moscú', tr: 'Her gün 22:00–22:15 Moskova saati', pt: 'Todos os dias das 22:00 às 22:15 horário de Moscou' },
  guildWarRule2: { ru: 'Клан, который добьёт замок, получает контроль над землёй — бой открытый, PvP разрешён', en: 'The clan that destroys the tower takes control — open PvP is allowed inside', uk: 'Клан, який заб\'є замок, отримує контроль над землею — бій відкритий, PvP дозволено', es: 'El clan que destruya la torre toma el control — el PvP está permitido dentro', tr: 'Kaleyi yıkan klan bölgeyi ele geçirir — bölge içinde PvP serbesttir', pt: 'O clã que destruir a torre assume o controle — PvP livre é permitido dentro' },
  guildWarRule3: { ru: 'Пока клан владеет замком, каждый час в хранилище падают осколки — даже когда локация закрыта', en: 'While a clan holds the tower, shards drop into storage every hour — even while the zone is closed', uk: 'Поки клан володіє замком, щогодини у сховище падають осколки — навіть коли локація закрита', es: 'Mientras un clan controle la torre, caen fragmentos en el almacén cada hora, incluso con la zona cerrada', tr: 'Bir klan kaleye sahipken, bölge kapalıyken bile depoya her saat parçalar düşer', pt: 'Enquanto um clã controla a torre, fragmentos caem no armazém a cada hora — mesmo com a zona fechada' },
  tcConnectBtn: { ru: '🔗 Подключить кошелёк', en: '🔗 Connect Wallet', uk: '🔗 Підключити гаманець', es: '🔗 Conectar Billetera', tr: '🔗 Cüzdan Bağla', pt: '🔗 Conectar Carteira' },
  tcDisconnectBtn: { ru: 'Отключить', en: 'Disconnect', uk: 'Відключити', es: 'Desconectar', tr: 'Bağlantıyı Kes', pt: 'Desconectar' },
  tcConnectedLbl: { ru: 'Кошелёк подключён', en: 'Wallet connected', uk: 'Гаманець підключено', es: 'Billetera conectada', tr: 'Cüzdan bağlandı', pt: 'Carteira conectada' },
  tcSendFromWalletFmt: { ru: 'Отправить {n} GRAM из кошелька', en: 'Send {n} GRAM from wallet', uk: 'Надіслати {n} GRAM з гаманця', es: 'Enviar {n} GRAM desde la billetera', tr: 'Cüzdandan {n} GRAM gönder', pt: 'Enviar {n} GRAM da carteira' },
  tcSendingLbl: { ru: 'Отправка...', en: 'Sending...', uk: 'Надсилання...', es: 'Enviando...', tr: 'Gönderiliyor...', pt: 'Enviando...' },
  tcOrManualHint: { ru: 'Или переведите вручную:', en: 'Or transfer manually:', uk: 'Або переведіть вручну:', es: 'O transfiere manualmente:', tr: 'Ya da manuel gönder:', pt: 'Ou transfira manualmente:' },
  tcTxSentToast: { ru: 'Транзакция отправлена — ожидайте подтверждения', en: 'Transaction sent — awaiting confirmation', uk: 'Транзакцію надіслано — очікуйте підтвердження', es: 'Transacción enviada — espera confirmación', tr: 'İşlem gönderildi — onay bekleniyor', pt: 'Transação enviada — aguarde confirmação' },
  tcTxErrorToast: { ru: 'Не удалось отправить транзакцию', en: 'Failed to send the transaction', uk: 'Не вдалося надіслати транзакцію', es: 'No se pudo enviar la transacción', tr: 'İşlem gönderilemedi', pt: 'Falha ao enviar a transação' },
  tcEnterAmountFirstToast: { ru: 'Сначала введите сумму', en: 'Enter an amount first', uk: 'Спочатку введіть суму', es: 'Primero ingresa un monto', tr: 'Önce bir tutar gir', pt: 'Primeiro digite um valor' },
  className_lev:         { ru: 'Танк',           en: 'Tank',          uk: 'Танк',          es: 'Tanque',                 tr: 'Tank',           pt: 'Tanque' },
  className_deathknight: { ru: 'Рыцарь Смерти',  en: 'Death Knight',  uk: 'Лицар Смерті',  es: 'Caballero de la Muerte', tr: 'Ölüm Şövalyesi', pt: 'Cavaleiro da Morte' },
  className_ranger:      { ru: 'Егерь',          en: 'Ranger',        uk: 'Єгер',          es: 'Guardabosques',         tr: 'Avcı',           pt: 'Guardião' },
  className_mage:        { ru: 'Маг',            en: 'Mage',          uk: 'Маг',           es: 'Mago',                   tr: 'Büyücü',         pt: 'Mago' },
  className_warlock:     { ru: 'Целитель',       en: 'Healer',        uk: 'Цілитель',      es: 'Sanador',               tr: 'Şifacı',         pt: 'Curandeiro' },
  hudMenuBtn: { ru: 'Меню', en: 'Menu', uk: 'Меню', es: 'Menú', tr: 'Menü', pt: 'Menu' },
  navRatingBtn: { ru: 'Рейтинг', en: 'Rating', uk: 'Рейтинг', es: 'Clasificación', tr: 'Sıralama', pt: 'Classificação' },
  navCodexBtn: { ru: 'Кодекс', en: 'Codex', uk: 'Кодекс', es: 'Códice', tr: 'Kodeks', pt: 'Códex' },
  navMarketBtn: { ru: 'Маркет', en: 'Market', uk: 'Маркет', es: 'Mercado', tr: 'Pazar', pt: 'Mercado' },
  navShopBtn: { ru: 'Магазин', en: 'Shop', uk: 'Магазин', es: 'Tienda', tr: 'Mağaza', pt: 'Loja' },
  skillsHdrUpper: { ru: 'НАВЫКИ', en: 'SKILLS', uk: 'НАВИЧКИ', es: 'HABILIDADES', tr: 'YETENEKLER', pt: 'HABILIDADES' },
  gearSectionHdr: { ru: 'Снаряжение (нажми для снятия)', en: 'Equipment (tap to unequip)', uk: 'Спорядження (натисни, щоб зняти)', es: 'Equipo (toca para desequipar)', tr: 'Ekipman (çıkarmak için dokun)', pt: 'Equipamento (toque para desequipar)' },
  itemsSectionHdr: { ru: 'Предметы (нажми для экипировки)', en: 'Items (tap to equip)', uk: 'Предмети (натисни, щоб одягнути)', es: 'Objetos (toca para equipar)', tr: 'Eşyalar (kuşanmak için dokun)', pt: 'Itens (toque para equipar)' },
  upgradesTabLbl: { ru: 'Улучшения', en: 'Upgrades', uk: 'Покращення', es: 'Mejoras', tr: 'Geliştirmeler', pt: 'Melhorias' },
  enemiesLbl: { ru: 'Враги', en: 'Enemies', uk: 'Вороги', es: 'Enemigos', tr: 'Düşmanlar', pt: 'Inimigos' },
  monstersHdr: { ru: 'Монстры', en: 'Monsters', uk: 'Монстри', es: 'Monstruos', tr: 'Canavarlar', pt: 'Monstros' },
  ratingPlayersTab: { ru: 'Игроки', en: 'Players', uk: 'Гравці', es: 'Jugadores', tr: 'Oyuncular', pt: 'Jogadores' },
  vipSystemHdr: { ru: 'VIP Система', en: 'VIP System', uk: 'VIP Система', es: 'Sistema VIP', tr: 'VIP Sistemi', pt: 'Sistema VIP' },
  marketTabLots: { ru: 'Лоты', en: 'Listings', uk: 'Лоти', es: 'Publicaciones', tr: 'İlanlar', pt: 'Anúncios' },
  marketTabMine: { ru: 'Мои лоты', en: 'My Listings', uk: 'Мої лоти', es: 'Mis Publicaciones', tr: 'İlanlarım', pt: 'Meus Anúncios' },
  marketTabHistory: { ru: 'История', en: 'History', uk: 'Історія', es: 'Historial', tr: 'Geçmiş', pt: 'Histórico' },
  gramShopHdr: { ru: 'Магазин GRAM', en: 'GRAM Shop', uk: 'Магазин GRAM', es: 'Tienda GRAM', tr: 'GRAM Mağazası', pt: 'Loja GRAM' },
  shopTabPacks: { ru: 'Паки', en: 'Packs', uk: 'Паки', es: 'Packs', tr: 'Paketler', pt: 'Pacotes' },
  shopTabPets: { ru: 'Питомцы', en: 'Pets', uk: 'Улюбленці', es: 'Mascotas', tr: 'Evcil Hayvanlar', pt: 'Animais' },
  shopTabRebirth: { ru: 'Перерождение', en: 'Rebirth', uk: 'Переродження', es: 'Renacimiento', tr: 'Yeniden Doğuş', pt: 'Renascimento' },
  talkBtnLbl: { ru: 'Поговорить', en: 'Talk', uk: 'Поговорити', es: 'Hablar', tr: 'Konuş', pt: 'Falar' },
  deathXpPenaltyLine: { ru: '−50% опыта на 5 минут', en: '−50% XP for 5 minutes', uk: '−50% досвіду на 5 хвилин', es: '−50% de XP durante 5 minutos', tr: '5 dakika boyunca −%50 tecrübe', pt: '−50% de XP por 5 minutos' },
  chatMentionHint: { ru: 'Отметьте @ник в сообщении, чтобы начать беседу', en: 'Mention @nick in a message to start a conversation', uk: 'Відмітьте @нік у повідомленні, щоб почати бесіду', es: 'Menciona a @nick en un mensaje para iniciar una conversación', tr: 'Sohbet başlatmak için mesajda @kullanıcı etiketle', pt: 'Mencione @nick em uma mensagem para iniciar uma conversa' },
  skillsTabLbl: { ru: 'Навыки', en: 'Skills', uk: 'Навички', es: 'Habilidades', tr: 'Yetenekler', pt: 'Habilidades' },
  rebirthTabLbl: { ru: 'Перерождение', en: 'Rebirth', uk: 'Переродження', es: 'Renacimiento', tr: 'Yeniden Doğuş', pt: 'Renascimento' },
  hudBtnLbl: { ru: 'В HUD', en: 'To HUD', uk: 'У HUD', es: 'Al HUD', tr: 'HUD\'a', pt: 'No HUD' },
  mapPanelTitle: { ru: 'Карта подземелья', en: 'Dungeon Map', uk: 'Карта підземелля', es: 'Mapa de la Mazmorra', tr: 'Zindan Haritası', pt: 'Mapa da Masmorra' },
  mapYouLbl: { ru: 'Вы', en: 'You', uk: 'Ви', es: 'Tú', tr: 'Sen', pt: 'Você' },
  skillLevelUpToast: { ru: '↑ Навык +{n} ур.!', en: '↑ Skill +{n} lvl.!', uk: '↑ Навик +{n} рів.!', es: '↑ ¡Habilidad +{n} niv.!', tr: '↑ Yetenek +{n} sv.!', pt: '↑ Habilidade +{n} nív.!' },
  passiveLevelUpToast: { ru: '↑ Пассивка +{n} ур.!', en: '↑ Passive +{n} lvl.!', uk: '↑ Пасивка +{n} рів.!', es: '↑ ¡Pasiva +{n} niv.!', tr: '↑ Pasif +{n} sv.!', pt: '↑ Passiva +{n} nív.!' },
});

const I18N_CLAN_PERK_DESC = [
  { en: '+5% gold from enemies',      uk: '+5% золота з ворогів',       es: '+5% de oro de enemigos',        tr: 'Düşmanlardan +%5 altın',        pt: '+5% de ouro de inimigos' },
  { en: '+5% XP from enemies',        uk: '+5% досвіду з ворогів',      es: '+5% de XP de enemigos',         tr: 'Düşmanlardan +%5 tecrübe',      pt: '+5% de XP de inimigos' },
  { en: '+10% total gold',            uk: '+10% до золота сумарно',     es: '+10% de oro total',             tr: 'Toplamda +%10 altın',           pt: '+10% de ouro total' },
  { en: '+5% attack for members',     uk: '+5% до атаки учасників',     es: '+5% de ataque para miembros',   tr: 'Üyeler için +%5 saldırı',       pt: '+5% de ataque para membros' },
  { en: '+10% total XP',              uk: '+10% до досвіду сумарно',    es: '+10% de XP total',              tr: 'Toplamda +%10 tecrübe',         pt: '+10% de XP total' },
  { en: '+15% total gold',            uk: '+15% до золота сумарно',     es: '+15% de oro total',             tr: 'Toplamda +%15 altın',           pt: '+15% de ouro total' },
  { en: '+10% total attack',          uk: '+10% до атаки сумарно',      es: '+10% de ataque total',          tr: 'Toplamda +%10 saldırı',         pt: '+10% de ataque total' },
  { en: '+15% total XP',              uk: '+15% до досвіду сумарно',    es: '+15% de XP total',              tr: 'Toplamda +%15 tecrübe',         pt: '+15% de XP total' },
  { en: '+20% gold',                  uk: '+20% до золота',             es: '+20% de oro',                   tr: '+%20 altın',                    pt: '+20% de ouro' },
  { en: '+20% XP',                    uk: '+20% до досвіду',            es: '+20% de XP',                    tr: '+%20 tecrübe',                  pt: '+20% de XP' },
  { en: '+15% attack',                uk: '+15% до атаки',              es: '+15% de ataque',                tr: '+%15 saldırı',                  pt: '+15% de ataque' },
];

function t(key) {
  const e = I18N_UI[key];
  if (!e) return key;
  return e[currentLang] || e.ru || key;
}
// Same as t() but substitutes {varName} placeholders from `vars`.
function tVars(key, vars) {
  let s = t(key);
  Object.keys(vars || {}).forEach(k => { s = s.split('{' + k + '}').join(vars[k]); });
  return s;
}

// Applies every [data-i18n] / [data-i18n-placeholder] element in the current
// DOM — covers the static chrome (nav tabs, chat panel, death screen,
// profile sub-tabs). Called on load and on every language switch.
function applyDomTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
}

// ── Content dictionaries (keyed by the same ids the data already uses) ──

const I18N_CLASSES = {
  lev:         { en: 'Tank',        uk: 'Танк',         es: 'Tanque',              tr: 'Tank',            pt: 'Tanque' },
  deathknight: { en: 'Death Knight',uk: 'Лицар Смерті', es: 'Caballero de la Muerte', tr: 'Ölüm Şövalyesi', pt: 'Cavaleiro da Morte' },
  ranger:      { en: 'Ranger',      uk: 'Єгер',         es: 'Guardabosques',       tr: 'Avcı',            pt: 'Guardião' },
  mage:        { en: 'Mage',        uk: 'Маг',          es: 'Mago',                tr: 'Büyücü',          pt: 'Mago' },
  warlock:     { en: 'Healer',      uk: 'Цілитель',     es: 'Sanador',             tr: 'Şifacı',          pt: 'Curandeiro' },
};

// key: class -> skillKey -> {name, desc}
const I18N_SKILLS = {
  lev: {
    Q: { name: { en: 'Frost Strike',   uk: 'Крижаний удар', es: 'Golpe Helado',      tr: 'Buz Darbesi',     pt: 'Golpe Gélido' },
         desc: { en: '×2 damage to target + 3s stun', uk: '×2 урону по цілі + оглушення 3 сек', es: '×2 daño al objetivo + 3s de aturdimiento', tr: 'Hedefe ×2 hasar + 3sn sersemletme', pt: '×2 de dano no alvo + atordoamento de 3s' } },
    W: { name: { en: 'Blade Whirl',    uk: 'Вихор клинків', es: 'Torbellino de Hojas', tr: 'Bıçak Kasırgası', pt: 'Redemoinho de Lâminas' },
         desc: { en: 'AOE damage, radius 110', uk: 'АОЕ урон, радіус 110', es: 'Daño en área, radio 110', tr: 'Alan hasarı, yarıçap 110', pt: 'Dano em área, raio 110' } },
    E: { name: { en: 'Wrath of the Dead', uk: 'Гнів мерця', es: 'Ira del Muerto',    tr: 'Ölünün Gazabı',   pt: 'Fúria do Morto' },
         desc: { en: '+80% defense for 10s', uk: '+80% захисту на 10 сек', es: '+80% de defensa durante 10s', tr: '10sn boyunca +%80 savunma', pt: '+80% de defesa por 10s' } },
    R: { name: { en: 'Dash of Light',  uk: 'Ривок світла',  es: 'Arremetida de Luz', tr: 'Işık Atılımı',    pt: 'Investida da Luz' },
         desc: { en: 'Dashes to target dealing damage', uk: 'Ривок до цілі з уроном', es: 'Embiste hacia el objetivo infligiendo daño', tr: 'Hedefe atılıp hasar verir', pt: 'Avança até o alvo causando dano' } },
  },
  deathknight: {
    Q: { name: { en: 'Vampirism',      uk: 'Вампіризм',     es: 'Vampirismo',        tr: 'Vampirlik',       pt: 'Vampirismo' },
         desc: { en: 'Lifesteal 10% of damage dealt for 10s', uk: 'Вампіризм 10% від удару на 10 сек', es: 'Robo de vida 10% del daño infligido durante 10s', tr: '10sn boyunca verilen hasarın %10\'unu can olarak al', pt: 'Roubo de vida de 10% do dano causado por 10s' } },
    W: { name: { en: 'Blade Vortex',   uk: 'Вихор клинка',  es: 'Vórtice de Hoja',   tr: 'Bıçak Girdabı',   pt: 'Vórtice de Lâmina' },
         desc: { en: 'AOE damage, radius 110', uk: 'АОЕ урон, радіус 110', es: 'Daño en área, radio 110', tr: 'Alan hasarı, yarıçap 110', pt: 'Dano em área, raio 110' } },
    E: { name: { en: 'Rage',           uk: 'Лють',          es: 'Furia',             tr: 'Öfke',            pt: 'Fúria' },
         desc: { en: '+20% attack for 5s', uk: '+20% атаки на 5 сек', es: '+20% de ataque durante 5s', tr: '5sn boyunca +%20 saldırı', pt: '+20% de ataque por 5s' } },
    R: { name: { en: 'Roll',           uk: 'Кувирок',       es: 'Voltereta',         tr: 'Takla',           pt: 'Rolamento' },
         desc: { en: 'Dashes to target dealing damage', uk: 'Ривок до цілі з уроном', es: 'Embiste hacia el objetivo infligiendo daño', tr: 'Hedefe atılıp hasar verir', pt: 'Avança até o alvo causando dano' } },
  },
  ranger: {
    Q: { name: { en: 'Multi-Shot',     uk: 'Мультипостріл', es: 'Disparo Múltiple', tr: 'Çoklu Atış',      pt: 'Tiro Múltiplo' },
         desc: { en: '3 arrows at ±0.35 rad angle', uk: '3 стріли під кутом ±0.35 рад', es: '3 flechas en ángulo ±0.35 rad', tr: '±0.35 rad açıyla 3 ok', pt: '3 flechas em ângulo de ±0.35 rad' } },
    W: { name: { en: 'Combo Arrow',    uk: 'Комбо-стріла',  es: 'Flecha Combo',     tr: 'Kombo Ok',        pt: 'Flecha Combo' },
         desc: { en: '3 arrows ×1 damage', uk: '3 стріли ×1 урон', es: '3 flechas ×1 daño', tr: '3 ok ×1 hasar', pt: '3 flechas ×1 dano' } },
    E: { name: { en: 'Jump',           uk: 'Стрибок',       es: 'Salto',             tr: 'Zıplama',         pt: 'Salto' },
         desc: { en: 'Dash 80px', uk: 'Ривок 80px', es: 'Embestida 80px', tr: '80px atılım', pt: 'Investida de 80px' } },
    R: { name: { en: 'Attack Speed',   uk: 'Швидкість атаки', es: 'Velocidad de Ataque', tr: 'Saldırı Hızı', pt: 'Velocidade de Ataque' },
         desc: { en: '×1.5 attack speed for 5s', uk: '×1.5 швидкості атаки на 5 сек', es: '×1.5 velocidad de ataque durante 5s', tr: '5sn boyunca ×1.5 saldırı hızı', pt: '×1.5 de velocidade de ataque por 5s' } },
  },
  mage: {
    Q: { name: { en: 'Frost Orb',      uk: 'Крижана куля',  es: 'Orbe de Hielo',    tr: 'Buz Küresi',      pt: 'Orbe de Gelo' },
         desc: { en: 'Projectile ×2 damage', uk: 'Снаряд ×2 урону', es: 'Proyectil ×2 daño', tr: 'Mermi ×2 hasar', pt: 'Projétil ×2 de dano' } },
    W: { name: { en: 'Frost Nova',     uk: 'Крижана нова',  es: 'Nova de Hielo',    tr: 'Buz Nova',        pt: 'Nova de Gelo' },
         desc: { en: 'AOE damage 130 + 3s freeze', uk: 'АОЕ урон 130 + заморозка 3 сек', es: 'Daño en área 130 + congelación 3s', tr: 'Alan hasarı 130 + 3sn donma', pt: 'Dano em área 130 + congelamento de 3s' } },
    E: { name: { en: 'Barrier',        uk: 'Бар\'єр',       es: 'Barrera',          tr: 'Bariyer',         pt: 'Barreira' },
         desc: { en: '+50% defense for 3s', uk: '+50% захисту на 3 сек', es: '+50% de defensa durante 3s', tr: '3sn boyunca +%50 savunma', pt: '+50% de defesa por 3s' } },
    R: { name: { en: 'Teleport',       uk: 'Телепорт',      es: 'Teletransporte',   tr: 'Işınlanma',       pt: 'Teleporte' },
         desc: { en: 'Dash 180px in facing direction', uk: 'Ривок 180px за напрямком', es: 'Embestida 180px en la dirección', tr: 'Baktığı yöne 180px atılım', pt: 'Investida de 180px na direção' } },
  },
  warlock: {
    Q: { name: { en: 'Dark Heal',      uk: 'Темне зцілення', es: 'Curación Oscura', tr: 'Karanlık Şifa',   pt: 'Cura Sombria' },
         desc: { en: '+20% maxHP', uk: '+20% від макс. HP', es: '+20% de HP máx.', tr: '+%20 maksimum HP', pt: '+20% do HP máximo' } },
    W: { name: { en: 'Chains of Darkness', uk: 'Кайдани темряви', es: 'Cadenas de Oscuridad', tr: 'Karanlık Zincirleri', pt: 'Correntes das Trevas' },
         desc: { en: 'Roots target in place for 3s', uk: 'Утримує ціль на місці 3 сек', es: 'Inmoviliza al objetivo durante 3s', tr: 'Hedefi 3sn boyunca yerinde tutar', pt: 'Prende o alvo no lugar por 3s' } },
    E: { name: { en: 'Dark Shield',    uk: 'Темний щит',    es: 'Escudo Oscuro',    tr: 'Karanlık Kalkan', pt: 'Escudo Sombrio' },
         desc: { en: '+50% defense to self and party for 4s', uk: '+50% захисту собі й паті на 4 сек', es: '+50% de defensa a ti y al grupo durante 4s', tr: '4sn boyunca kendine ve gruba +%50 savunma', pt: '+50% de defesa para você e o grupo por 4s' } },
    R: { name: { en: 'Dark Prayer',    uk: 'Темна молитва', es: 'Oración Oscura',   tr: 'Karanlık Dua',    pt: 'Oração Sombria' },
         desc: { en: '+10% maxHP to self and +10% to party', uk: '+10% макс. HP собі та +10% паті', es: '+10% de HP máx. a ti y +10% al grupo', tr: 'Kendine +%10, grubuna +%10 maksimum HP', pt: '+10% do HP máximo para você e +10% para o grupo' } },
  },
};

// Advanced skills ("вторая профессия") — same [class][key] -> {name, desc}
// shape as I18N_SKILLS above, applied to ADV_SKILL_DEF (js/definitions.js)
// by the same applyLocale/_i18nSnapshot pass, just keyed off its own
// _i18nOrigName/_i18nOrigDesc snapshot (see both functions below).
const I18N_ADV_SKILLS = {
  lev: {
    Q: { name: { en: 'Hammer of Wrath', uk: 'Молот гніву', es: 'Martillo de Ira', tr: 'Gazap Çekici', pt: 'Martelo da Ira' },
         desc: { en: '×3 damage to target + 5s stun', uk: '×3 урону по цілі + оглушення 5 сек', es: '×3 daño al objetivo + 5s de aturdimiento', tr: 'Hedefe ×3 hasar + 5sn sersemletme', pt: '×3 de dano no alvo + atordoamento de 5s' } },
    W: { name: { en: 'Whirl', uk: 'Вихор', es: 'Torbellino', tr: 'Kasırga', pt: 'Redemoinho' },
         desc: { en: 'AOE damage ×2, radius 220', uk: 'АОЕ урон ×2, радіус 220', es: 'Daño en área ×2, radio 220', tr: 'Alan hasarı ×2, yarıçap 220', pt: 'Dano em área ×2, raio 220' } },
    E: { name: { en: 'Shield', uk: 'Щит', es: 'Escudo', tr: 'Kalkan', pt: 'Escudo' },
         desc: { en: '+80% defense and +10% attack for 10s', uk: '+80% захисту та +10% атаки на 10 сек', es: '+80% de defensa y +10% de ataque durante 10s', tr: '10sn boyunca +%80 savunma ve +%10 saldırı', pt: '+80% de defesa e +10% de ataque por 10s' } },
    R: { name: { en: 'Dash', uk: 'Ривок', es: 'Arremetida', tr: 'Atılım', pt: 'Investida' },
         desc: { en: 'Dashes to target, slowing them 30% for 10s', uk: 'Стрибає до цілі, сповільнюючи її на 30% на 10 сек', es: 'Embiste hacia el objetivo, ralentizándolo 30% durante 10s', tr: 'Hedefe atılır, %30 yavaşlatarak 10sn', pt: 'Avança até o alvo, reduzindo sua velocidade em 30% por 10s' } },
  },
  deathknight: {
    Q: { name: { en: 'Exhaustion', uk: 'Виснаження', es: 'Agotamiento', tr: 'Tükenme', pt: 'Exaustão' },
         desc: { en: 'Lifesteal 15% + attack +20% for 10s', uk: 'Вампіризм 15% + атака +20% на 10 сек', es: 'Robo de vida 15% + ataque +20% durante 10s', tr: '%15 can çalma + %20 saldırı, 10sn', pt: 'Roubo de vida de 15% + ataque +20% por 10s' } },
    W: { name: { en: 'Greed', uk: 'Жадібність', es: 'Codicia', tr: 'Açgözlülük', pt: 'Ganância' },
         desc: { en: '+5% crit damage for 20 minutes', uk: '+5% крит. урону на 20 хвилин', es: '+5% de daño crítico durante 20 minutos', tr: '20 dakika boyunca +%5 kritik hasar', pt: '+5% de dano crítico por 20 minutos' } },
    E: { name: { en: 'Madness', uk: 'Безумство', es: 'Locura', tr: 'Çılgınlık', pt: 'Loucura' },
         desc: { en: '+25% attack, basic hits deal AOE damage, for 5s', uk: '+25% атаки, звичайні удари завдають АОЕ урону, на 5 сек', es: '+25% de ataque, los golpes básicos infligen daño en área, durante 5s', tr: '+%25 saldırı, normal vuruşlar 5sn boyunca alan hasarı verir', pt: '+25% de ataque, golpes básicos causam dano em área, por 5s' } },
    R: { name: { en: 'Hunt', uk: 'Полювання', es: 'Caza', tr: 'Av', pt: 'Caça' },
         desc: { en: 'Dashes to target, stripping 20% of their defense for 10s', uk: 'Стрибає до цілі, знімаючи 20% її захисту на 10 сек', es: 'Embiste hacia el objetivo, reduciendo 20% de su defensa durante 10s', tr: 'Hedefe atılır, 10sn boyunca savunmasının %20\'sini düşürür', pt: 'Avança até o alvo, removendo 20% de sua defesa por 10s' } },
  },
  ranger: {
    Q: { name: { en: 'Arrow Storm', uk: 'Град стріл', es: 'Lluvia de Flechas', tr: 'Ok Fırtınası', pt: 'Chuva de Flechas' },
         desc: { en: 'AOE damage ×3, radius 220', uk: 'АОЕ урон ×3, радіус 220', es: 'Daño en área ×3, radio 220', tr: 'Alan hasarı ×3, yarıçap 220', pt: 'Dano em área ×3, raio 220' } },
    W: { name: { en: 'Piercing Tip', uk: 'Вістря', es: 'Punta Afilada', tr: 'Sivri Uç', pt: 'Ponta Afiada' },
         desc: { en: '×3 damage to target + 2s stun', uk: '×3 урону по цілі + оглушення 2 сек', es: '×3 daño al objetivo + 2s de aturdimiento', tr: 'Hedefe ×3 hasar + 2sn sersemletme', pt: '×3 de dano no alvo + atordoamento de 2s' } },
    E: { name: { en: 'Crit Buff', uk: 'Баф криту', es: 'Bufo de Crítico', tr: 'Kritik Bafı', pt: 'Buff de Crítico' },
         desc: { en: '+5% crit chance for 20 minutes', uk: '+5% шансу криту на 20 хвилин', es: '+5% de probabilidad crítica durante 20 minutos', tr: '20 dakika boyunca +%5 kritik şansı', pt: '+5% de chance de crítico por 20 minutos' } },
    R: { name: { en: 'Acceleration', uk: 'Прискорення', es: 'Aceleración', tr: 'Hızlanma', pt: 'Aceleração' },
         desc: { en: '×2 attack speed for 5s', uk: '×2 швидкості атаки на 5 сек', es: '×2 velocidad de ataque durante 5s', tr: '5sn boyunca ×2 saldırı hızı', pt: '×2 de velocidade de ataque por 5s' } },
  },
  mage: {
    Q: { name: { en: 'Lightning Damage', uk: 'Урон блискавки', es: 'Daño de Rayo', tr: 'Yıldırım Hasarı', pt: 'Dano de Raio' },
         desc: { en: 'Projectile ×3 damage + 3s stun', uk: 'Снаряд ×3 урону + оглушення 3 сек', es: 'Proyectil ×3 daño + 3s de aturdimiento', tr: 'Mermi ×3 hasar + 3sn sersemletme', pt: 'Projétil ×3 de dano + atordoamento de 3s' } },
    W: { name: { en: 'Discharge', uk: 'Розряд', es: 'Descarga', tr: 'Boşalım', pt: 'Descarga' },
         desc: { en: 'AOE damage ×3, radius 220', uk: 'АОЕ урон ×3, радіус 220', es: 'Daño en área ×3, radio 220', tr: 'Alan hasarı ×3, yarıçap 220', pt: 'Dano em área ×3, raio 220' } },
    E: { name: { en: 'Flash', uk: 'Спалах', es: 'Destello', tr: 'Parlama', pt: 'Clarão' },
         desc: { en: 'AOE damage ×2, radius 220 + defense +80% for 3s', uk: 'АОЕ урон ×2, радіус 220 + захист +80% на 3 сек', es: 'Daño en área ×2, radio 220 + defensa +80% durante 3s', tr: 'Alan hasarı ×2, yarıçap 220 + savunma +%80, 3sn', pt: 'Dano em área ×2, raio 220 + defesa +80% por 3s' } },
    R: { name: { en: 'Transference', uk: 'Перенесення', es: 'Transferencia', tr: 'Aktarım', pt: 'Transferência' },
         desc: { en: 'Dash 180px + restores 20% health', uk: 'Ривок 180px + відновлює 20% здоров\'я', es: 'Embestida 180px + restaura 20% de salud', tr: '180px atılım + %20 can yeniler', pt: 'Investida de 180px + restaura 20% de vida' } },
  },
  warlock: {
    Q: { name: { en: 'Butterflies', uk: 'Метелики', es: 'Mariposas', tr: 'Kelebekler', pt: 'Borboletas' },
         desc: { en: 'Summons butterflies for 10s — heal 5% HP per second', uk: 'Викликає метеликів на 10 сек — лікують 5% HP щосекунди', es: 'Invoca mariposas durante 10s — curan 5% de HP por segundo', tr: '10sn boyunca kelebekler çağırır — saniyede %5 HP iyileştirir', pt: 'Invoca borboletas por 10s — curam 5% de HP por segundo' } },
    W: { name: { en: 'Thorned Chains', uk: 'Колючі кайдани', es: 'Cadenas Espinosas', tr: 'Dikenli Zincirler', pt: 'Correntes Espinhosas' },
         desc: { en: 'Roots target for 3s, dealing ×3 damage', uk: 'Утримує ціль 3 сек, завдаючи ×3 урону', es: 'Inmoviliza al objetivo 3s, infligiendo ×3 daño', tr: 'Hedefi 3sn tutar, ×3 hasar verir', pt: 'Prende o alvo por 3s, causando ×3 de dano' } },
    E: { name: { en: 'Thirst', uk: 'Спрага', es: 'Sed', tr: 'Susuzluk', pt: 'Sede' },
         desc: { en: '+50% defense to self and party, ×2 attack speed, for 4s', uk: '+50% захисту собі й паті, ×2 швидкості атаки, на 4 сек', es: '+50% de defensa a ti y al grupo, ×2 velocidad de ataque, durante 4s', tr: 'Kendine ve gruba +%50 savunma, ×2 saldırı hızı, 4sn', pt: '+50% de defesa para você e o grupo, ×2 de velocidade de ataque, por 4s' } },
    R: { name: { en: 'Healing', uk: 'Зцілення', es: 'Curación', tr: 'İyileştirme', pt: 'Cura' },
         desc: { en: 'Heals 20% HP to self and party', uk: 'Лікує 20% HP собі й паті', es: 'Cura 20% de HP a ti y al grupo', tr: 'Kendine ve gruba %20 HP iyileştirir', pt: 'Cura 20% de HP para você e o grupo' } },
  },
};

// key: passive id -> {name, desc}
const I18N_PASSIVES = {
  tankatk:  { name: { en: 'Berserker Might',   uk: 'Міць берсерка',    es: 'Poder del Berserker', tr: 'Berserker Gücü',   pt: 'Poder do Berserker' },
              desc: { en: '+3% attack per level', uk: '+3% атаки за рівень', es: '+3% de ataque por nivel', tr: 'Seviye başına +%3 saldırı', pt: '+3% de ataque por nível' } },
  deftank:  { name: { en: 'Unbreakable',       uk: 'Незламність',      es: 'Inquebrantable',      tr: 'Yıkılmazlık',      pt: 'Inquebrável' },
              desc: { en: '+3% defense per level', uk: '+3% захисту за рівень', es: '+3% de defensa por nivel', tr: 'Seviye başına +%3 savunma', pt: '+3% de defesa por nível' } },
  dkatk:    { name: { en: 'Blood Pact',        uk: 'Кривавий пакт',    es: 'Pacto de Sangre',     tr: 'Kan Paktı',        pt: 'Pacto de Sangue' },
              desc: { en: '+3% attack per level', uk: '+3% атаки за рівень', es: '+3% de ataque por nivel', tr: 'Seviye başına +%3 saldırı', pt: '+3% de ataque por nível' } },
  dkdef:    { name: { en: 'Dark Carapace',     uk: 'Темний панцир',    es: 'Caparazón Oscuro',    tr: 'Karanlık Zırh',    pt: 'Carapaça Sombria' },
              desc: { en: '+3% defense per level', uk: '+3% захисту за рівень', es: '+3% de defensa por nivel', tr: 'Seviye başına +%3 savunma', pt: '+3% de defesa por nível' } },
  bowatk:   { name: { en: 'Keen Eye',          uk: 'Влучне око',       es: 'Ojo Certero',         tr: 'Keskin Göz',       pt: 'Olho Certeiro' },
              desc: { en: '+3% attack per level', uk: '+3% атаки за рівень', es: '+3% de ataque por nivel', tr: 'Seviye başına +%3 saldırı', pt: '+3% de ataque por nível' } },
  bowdef:   { name: { en: 'Tracker\'s Instinct', uk: 'Чуття слідопита', es: 'Instinto de Rastreador', tr: 'İzci İçgüdüsü', pt: 'Instinto de Rastreador' },
              desc: { en: '+3% defense per level', uk: '+3% захисту за рівень', es: '+3% de defensa por nivel', tr: 'Seviye başına +%3 savunma', pt: '+3% de defesa por nível' } },
  mageatk:  { name: { en: 'Mana Flow',         uk: 'Потік мани',       es: 'Flujo de Maná',       tr: 'Mana Akışı',       pt: 'Fluxo de Mana' },
              desc: { en: '+3% attack per level', uk: '+3% атаки за рівень', es: '+3% de ataque por nivel', tr: 'Seviye başına +%3 saldırı', pt: '+3% de ataque por nível' } },
  magedef:  { name: { en: 'Ice Shield',        uk: 'Крижаний щит',     es: 'Escudo de Hielo',     tr: 'Buz Kalkanı',      pt: 'Escudo de Gelo' },
              desc: { en: '+3% defense per level', uk: '+3% захисту за рівень', es: '+3% de defensa por nivel', tr: 'Seviye başına +%3 savunma', pt: '+3% de defesa por nível' } },
  healatk:  { name: { en: 'Dark Thirst',       uk: 'Темна спрага',     es: 'Sed Oscura',          tr: 'Karanlık Susuzluk',pt: 'Sede Sombria' },
              desc: { en: '+3% attack per level', uk: '+3% атаки за рівень', es: '+3% de ataque por nivel', tr: 'Seviye başına +%3 saldırı', pt: '+3% de ataque por nível' } },
  healdef:  { name: { en: 'Dark Ward',         uk: 'Оберіг тьми',      es: 'Amuleto Oscuro',      tr: 'Karanlık Muska',   pt: 'Amuleto Sombrio' },
              desc: { en: '+3% defense per level', uk: '+3% захисту за рівень', es: '+3% de defensa por nivel', tr: 'Seviye başına +%3 savunma', pt: '+3% de defesa por nível' } },
  allatkspeed: { name: { en: 'Swiftness',      uk: 'Стрімкість',       es: 'Celeridad',           tr: 'Çeviklik',         pt: 'Rapidez' },
              desc: { en: '+2% attack speed per level', uk: '+2% швидкості атаки за рівень', es: '+2% de velocidad de ataque por nivel', tr: 'Seviye başına +%2 saldırı hızı', pt: '+2% de velocidade de ataque por nível' } },
  allhp:    { name: { en: 'Vitality',          uk: 'Живучість',        es: 'Vitalidad',           tr: 'Dayanıklılık',     pt: 'Vitalidade' },
              desc: { en: '+3% max HP per level', uk: '+3% макс. здоров\'я за рівень', es: '+3% de HP máx. por nivel', tr: 'Seviye başına +%3 maksimum HP', pt: '+3% de HP máximo por nível' } },
  allcritdmg: { name: { en: 'Blood Frenzy',    uk: 'Кривава лють',     es: 'Frenesí Sangriento',  tr: 'Kan Çılgınlığı',   pt: 'Frenesi Sangrento' },
              desc: { en: '+4% crit power per level', uk: '+4% сили криту за рівень', es: '+4% de poder crítico por nivel', tr: 'Seviye başına +%4 kritik güç', pt: '+4% de poder crítico por nível' } },
  allspeed: { name: { en: 'Fleet Feet',        uk: 'Швидкі ноги',      es: 'Pies Ligeros',        tr: 'Hızlı Ayaklar',    pt: 'Pés Ligeiros' },
              desc: { en: '+2% movement speed per level', uk: '+2% швидкості руху за рівень', es: '+2% de velocidad de movimiento por nivel', tr: 'Seviye başına +%2 hareket hızı', pt: '+2% de velocidade de movimento por nível' } },
  allcdskill: { name: { en: 'Clear Mind',      uk: 'Ясний розум',      es: 'Mente Clara',         tr: 'Berrak Zihin',     pt: 'Mente Clara' },
              desc: { en: '-2% skill cooldown per level', uk: '-2% перезарядки навичок за рівень', es: '-2% de reutilización de habilidades por nivel', tr: 'Seviye başına -%2 yetenek bekleme süresi', pt: '-2% de recarga de habilidades por nível' } },
  allregen: { name: { en: 'Regeneration',      uk: 'Регенерація',      es: 'Regeneración',        tr: 'Yenilenme',        pt: 'Regeneração' },
              desc: { en: '+0.2 HP regen/sec per level', uk: '+0.2 реген. HP/сек за рівень', es: '+0.2 regen. HP/s por nivel', tr: 'Seviye başına +0.2 HP/sn yenilenme', pt: '+0.2 regen. HP/s por nível' } },
};

const I18N_NPCS = {
  merchant:  { name: { en: 'Merchant',  uk: 'Торговець', es: 'Comerciante', tr: 'Tüccar',   pt: 'Mercador' },
               desc: { en: 'Potions and consumables', uk: 'Зілля та витратні матеріали', es: 'Pociones y consumibles', tr: 'İksirler ve tüketim malzemeleri', pt: 'Poções e consumíveis' } },
  craftsman: { name: { en: 'Blacksmith', uk: 'Коваль',   es: 'Herrero',     tr: 'Demirci',  pt: 'Ferreiro' },
               desc: { en: 'Craft items', uk: 'Крафт предметів', es: 'Fabricar objetos', tr: 'Eşya üretimi', pt: 'Fabricação de itens' } },
  storage:   { name: { en: 'Storage',    uk: 'Сховище',  es: 'Almacén',     tr: 'Depo',     pt: 'Armazém' },
               desc: { en: 'Store items (200 slots)', uk: 'Зберігання предметів (200 комірок)', es: 'Guardar objetos (200 espacios)', tr: 'Eşya saklama (200 slot)', pt: 'Guardar itens (200 espaços)' } },
};

const I18N_RARITY = {
  common:    { en: 'Common',    uk: 'Звичайний',  es: 'Común',     tr: 'Sıradan',   pt: 'Comum' },
  uncommon:  { en: 'Uncommon',  uk: 'Незвичайний',es: 'Poco Común',tr: 'Nadir Değil', pt: 'Incomum' },
  rare:      { en: 'Rare',      uk: 'Рідкісний',  es: 'Raro',      tr: 'Nadir',     pt: 'Raro' },
  epic:      { en: 'Epic',      uk: 'Епічний',    es: 'Épico',     tr: 'Efsanevi Öncesi', pt: 'Épico' },
  legendary: { en: 'Legendary', uk: 'Легендарний',es: 'Legendario',tr: 'Efsanevi',  pt: 'Lendário' },
};

const I18N_SLOTS = {
  weapon:  { en: 'Weapon',   uk: 'Зброя',    es: 'Arma',        tr: 'Silah',     pt: 'Arma' },
  helmet:  { en: 'Helmet',   uk: 'Шолом',    es: 'Casco',       tr: 'Miğfer',    pt: 'Elmo' },
  body:    { en: 'Armor',    uk: 'Броня',    es: 'Armadura',    tr: 'Zırh',      pt: 'Armadura' },
  gloves:  { en: 'Gloves',   uk: 'Рукавиці', es: 'Guantes',     tr: 'Eldiven',   pt: 'Luvas' },
  boots:   { en: 'Boots',    uk: 'Чоботи',   es: 'Botas',       tr: 'Botlar',    pt: 'Botas' },
  ring:    { en: 'Ring',     uk: 'Каблучка', es: 'Anillo',      tr: 'Yüzük',     pt: 'Anel' },
  belt:    { en: 'Belt',     uk: 'Пояс',     es: 'Cinturón',    tr: 'Kemer',     pt: 'Cinto' },
  pet:     { en: 'Pet',      uk: 'Улюбленець', es: 'Mascota',   tr: 'Evcil Hayvan', pt: 'Mascote' },
  cloak:   { en: 'Cloak',    uk: 'Плащ',     es: 'Capa',        tr: 'Pelerin',   pt: 'Capa' },
  artifact:{ en: 'Artifact', uk: 'Артефакт', es: 'Artefacto',   tr: 'Eser',      pt: 'Artefato' },
  use:     { en: 'Consumable', uk: 'Витратний матеріал', es: 'Consumible', tr: 'Sarf Malzemesi', pt: 'Consumível' },
  material:{ en: 'Material', uk: 'Матеріал', es: 'Material',    tr: 'Malzeme',   pt: 'Material' },
  recipe:  { en: 'Recipe',   uk: 'Рецепт',   es: 'Receta',      tr: 'Tarif',     pt: 'Receita' },
  buff_potion: { en: 'Buff Potion', uk: 'Зілля посилення', es: 'Poción de Mejora', tr: 'Güçlendirme İksiri', pt: 'Poção de Bônus' },
  box:     { en: 'Box',      uk: 'Бокс',     es: 'Caja',        tr: 'Kutu',      pt: 'Caixa' },
};

// Equipment slot picker labels (js/definitions.js EQ_SLOTS) — same words as
// I18N_SLOTS above but a couple are deliberately shorter there (Russian
// "Перчи"/"Боты" are themselves abbreviations of "Перчатки"/"Ботинки") so
// this is kept as its own table rather than reusing I18N_SLOTS verbatim.
const I18N_EQ_SLOT_LABELS = {
  weapon:  { en: 'Weapon',  uk: 'Зброя',    es: 'Arma',     tr: 'Silah',   pt: 'Arma' },
  helmet:  { en: 'Helmet',  uk: 'Шолом',    es: 'Casco',    tr: 'Miğfer',  pt: 'Elmo' },
  body:    { en: 'Body',    uk: 'Тіло',     es: 'Cuerpo',   tr: 'Gövde',   pt: 'Corpo' },
  gloves:  { en: 'Gloves',  uk: 'Рукавиці', es: 'Guantes',  tr: 'Eldiven', pt: 'Luvas' },
  boots:   { en: 'Boots',   uk: 'Чоботи',   es: 'Botas',    tr: 'Botlar',  pt: 'Botas' },
  ring:    { en: 'Ring',    uk: 'Каблучка', es: 'Anillo',   tr: 'Yüzük',   pt: 'Anel' },
  belt:    { en: 'Belt',    uk: 'Пояс',     es: 'Cinturón', tr: 'Kemer',   pt: 'Cinto' },
  pet:     { en: 'Pet',     uk: 'Улюбленець', es: 'Mascota', tr: 'Evcil Hayvan', pt: 'Mascote' },
  cloak:   { en: 'Cloak',   uk: 'Плащ',     es: 'Capa',     tr: 'Pelerin', pt: 'Capa' },
  artifact:{ en: 'Artifact',uk: 'Артефакт', es: 'Artefacto',tr: 'Eser',    pt: 'Artefato' },
};

const I18N_UPGRADES = {
  atk:        { label: { en: 'Attack',       uk: 'Атака',           es: 'Ataque',           tr: 'Saldırı',          pt: 'Ataque' },
                desc:  { en: '+1 ATK', uk: '+1 АТК', es: '+1 ATQ', tr: '+1 SLD', pt: '+1 ATQ' } },
  def:        { label: { en: 'Defense',      uk: 'Захист',          es: 'Defensa',          tr: 'Savunma',          pt: 'Defesa' },
                desc:  { en: '+1 DEF', uk: '+1 ЗАХ', es: '+1 DEF', tr: '+1 SAV', pt: '+1 DEF' } },
  hp:         { label: { en: 'Health',       uk: 'Здоров\'я',       es: 'Salud',            tr: 'Can',              pt: 'Vida' },
                desc:  { en: '+10 MaxHP', uk: '+10 Макс.HP', es: '+10 HP Máx.', tr: '+10 Maks.HP', pt: '+10 HP Máx.' } },
  atkSpeed:   { label: { en: 'Attack Spd.',  uk: 'Швид. атаки',     es: 'Vel. Ataque',      tr: 'Sld. Hızı',        pt: 'Vel. Ataque' },
                desc:  { en: '+0.05 hits/s', uk: '+0.05 удар/с', es: '+0.05 golpes/s', tr: '+0.05 vuruş/s', pt: '+0.05 golpes/s' } },
  critChance: { label: { en: 'Crit Chance',  uk: 'Шанс криту',      es: 'Prob. Crítico',    tr: 'Kritik Şansı',     pt: 'Chance Crítico' },
                desc:  { en: '+1%', uk: '+1%', es: '+1%', tr: '+%1', pt: '+1%' } },
  critPower:  { label: { en: 'Crit Power',   uk: 'Сила криту',      es: 'Poder Crítico',    tr: 'Kritik Gücü',      pt: 'Poder Crítico' },
                desc:  { en: '+3%', uk: '+3%', es: '+3%', tr: '+%3', pt: '+3%' } },
  hpRegen:    { label: { en: 'HP Regen',     uk: 'Реген HP',        es: 'Regen. HP',        tr: 'HP Yenilenme',     pt: 'Regen. HP' },
                desc:  { en: '+0.1/sec', uk: '+0.1/сек', es: '+0.1/s', tr: '+0.1/sn', pt: '+0.1/s' } },
};

const I18N_CLAN_LEVELS = {
  1:  { en: 'Newly Formed', uk: 'Новоутворений', es: 'Recién Formado',   tr: 'Yeni Kurulmuş',   pt: 'Recém-formado' },
  2:  { en: 'Coordinated',  uk: 'Злагоджений',   es: 'Coordinado',       tr: 'Koordineli',      pt: 'Coordenado' },
  3:  { en: 'United',       uk: 'Згуртований',   es: 'Unido',            tr: 'Kenetlenmiş',     pt: 'Unido' },
  4:  { en: 'Experienced',  uk: 'Досвідчений',   es: 'Experimentado',    tr: 'Deneyimli',       pt: 'Experiente' },
  5:  { en: 'Renowned',     uk: 'Іменитий',      es: 'Renombrado',       tr: 'Ünlü',            pt: 'Renomado' },
  6:  { en: 'Famed',        uk: 'Прославлений',  es: 'Afamado',          tr: 'Meşhur',          pt: 'Afamado' },
  7:  { en: 'Legendary',    uk: 'Легендарний',   es: 'Legendario',       tr: 'Efsanevi',        pt: 'Lendário' },
  8:  { en: 'Great',        uk: 'Великий',       es: 'Grandioso',        tr: 'Büyük',           pt: 'Grandioso' },
  9:  { en: 'Invincible',   uk: 'Непереможний',  es: 'Invencible',       tr: 'Yenilmez',        pt: 'Invencível' },
  10: { en: 'Immortal',     uk: 'Безсмертний',   es: 'Inmortal',         tr: 'Ölümsüz',         pt: 'Imortal' },
};

// key: item id -> {en, uk, es, tr, pt}
const I18N_ITEMS = {
  sw1: { en: 'Rusty Sword',   uk: 'Іржавий меч',   es: 'Espada Oxidada',   tr: 'Paslı Kılıç',    pt: 'Espada Enferrujada' },
  sw2: { en: 'Steel Sword',   uk: 'Сталевий меч',  es: 'Espada de Acero',  tr: 'Çelik Kılıç',    pt: 'Espada de Aço' },
  sw3: { en: 'Dragon Sword',  uk: 'Меч дракона',   es: 'Espada de Dragón', tr: 'Ejderha Kılıcı', pt: 'Espada do Dragão' },
  sw4: { en: 'Shadow Sword',  uk: 'Меч тіней',     es: 'Espada de Sombras', tr: 'Gölge Kılıcı',  pt: 'Espada das Sombras' },
  sw5: { en: 'Hero\'s Sword', uk: 'Меч героя',     es: 'Espada del Héroe', tr: 'Kahraman Kılıcı',pt: 'Espada do Herói' },
  tw1: { en: 'Rusty Axe',     uk: 'Іржавий сокира',es: 'Hacha Oxidada',    tr: 'Paslı Balta',    pt: 'Machado Enferrujado' },
  tw2: { en: 'Steel Axe',     uk: 'Сталева сокира',es: 'Hacha de Acero',   tr: 'Çelik Balta',    pt: 'Machado de Aço' },
  tw3: { en: 'Dragon Axe',    uk: 'Сокира дракона',es: 'Hacha de Dragón',  tr: 'Ejderha Baltası',pt: 'Machado do Dragão' },
  tw4: { en: 'Shadow Axe',    uk: 'Сокира тіней',  es: 'Hacha de Sombras', tr: 'Gölge Baltası',  pt: 'Machado das Sombras' },
  tw5: { en: 'Hero\'s Axe',   uk: 'Сокира героя',  es: 'Hacha del Héroe',  tr: 'Kahraman Baltası',pt: 'Machado do Herói' },
  bw1: { en: 'Wooden Bow',    uk: 'Дерев\'яний лук', es: 'Arco de Madera', tr: 'Ahşap Yay',      pt: 'Arco de Madeira' },
  bw2: { en: 'Silver Bow',    uk: 'Срібний лук',   es: 'Arco de Plata',    tr: 'Gümüş Yay',      pt: 'Arco de Prata' },
  bw3: { en: 'Hunter\'s Bow', uk: 'Лук мисливця',  es: 'Arco del Cazador', tr: 'Avcı Yayı',      pt: 'Arco do Caçador' },
  bw4: { en: 'Moon Bow',      uk: 'Місячний лук',  es: 'Arco Lunar',       tr: 'Ay Yayı',        pt: 'Arco Lunar' },
  bw5: { en: 'Hero\'s Bow',   uk: 'Лук героя',     es: 'Arco del Héroe',   tr: 'Kahraman Yayı',  pt: 'Arco do Herói' },
  st1: { en: 'Novice Staff',  uk: 'Посох новачка', es: 'Bastón de Novato', tr: 'Acemi Asası',    pt: 'Cajado de Novato' },
  st2: { en: 'Fighter\'s Staff', uk: 'Посох бійця', es: 'Bastón del Luchador', tr: 'Savaşçı Asası', pt: 'Cajado do Lutador' },
  st3: { en: 'Hunter\'s Staff', uk: 'Посох мисливця', es: 'Bastón del Cazador', tr: 'Avcı Asası', pt: 'Cajado do Caçador' },
  st4: { en: 'Hero\'s Staff', uk: 'Посох Героя',   es: 'Bastón del Héroe', tr: 'Kahraman Asası', pt: 'Cajado do Herói' },
  st5: { en: 'Legend\'s Staff', uk: 'Посох Легенди', es: 'Bastón de la Leyenda', tr: 'Efsane Asası', pt: 'Cajado da Lenda' },
  hm1: { en: 'Leather Helmet', uk: 'Шкіряний шолом', es: 'Casco de Cuero', tr: 'Deri Miğfer',    pt: 'Elmo de Couro' },
  hm2: { en: 'Iron Helmet',    uk: 'Залізний шолом', es: 'Casco de Hierro', tr: 'Demir Miğfer',  pt: 'Elmo de Ferro' },
  hm3: { en: 'Platinum Helmet',uk: 'Платиновий шолом', es: 'Casco de Platino', tr: 'Platin Miğfer', pt: 'Elmo de Platina' },
  hm4: { en: 'Hero\'s Crown', uk: 'Корона героя',  es: 'Corona del Héroe', tr: 'Kahraman Tacı',  pt: 'Coroa do Herói' },
  hm5: { en: 'Legend\'s Helmet', uk: 'Шолом легенди', es: 'Casco de la Leyenda', tr: 'Efsane Miğferi', pt: 'Elmo da Lenda' },
  ar1: { en: 'Leather Armor',  uk: 'Шкіряна броня', es: 'Armadura de Cuero', tr: 'Deri Zırh',    pt: 'Armadura de Couro' },
  ar2: { en: 'Iron Armor',     uk: 'Залізна броня', es: 'Armadura de Hierro', tr: 'Demir Zırh',  pt: 'Armadura de Ferro' },
  ar3: { en: 'Platinum Armor', uk: 'Платинова броня', es: 'Armadura de Platino', tr: 'Platin Zırh', pt: 'Armadura de Platina' },
  ar4: { en: 'Hero\'s Armor', uk: 'Обладунок героя', es: 'Armadura del Héroe', tr: 'Kahraman Zırhı', pt: 'Armadura do Herói' },
  ar5: { en: 'Legend\'s Armor', uk: 'Обладунок легенди', es: 'Armadura de la Leyenda', tr: 'Efsane Zırhı', pt: 'Armadura da Lenda' },
  gl1: { en: 'Leather Gloves', uk: 'Шкіряні рукавиці', es: 'Guantes de Cuero', tr: 'Deri Eldiven', pt: 'Luvas de Couro' },
  gl2: { en: 'Iron Gloves',    uk: 'Залізні рукавиці', es: 'Guantes de Hierro', tr: 'Demir Eldiven', pt: 'Luvas de Ferro' },
  gl3: { en: 'Platinum Gloves', uk: 'Платинові рукавиці', es: 'Guantes de Platino', tr: 'Platin Eldiven', pt: 'Luvas de Platina' },
  gl4: { en: 'Hero\'s Gloves', uk: 'Рукавиці героя', es: 'Guantes del Héroe', tr: 'Kahraman Eldiveni', pt: 'Luvas do Herói' },
  gl5: { en: 'Legend\'s Gloves', uk: 'Рукавиці легенди', es: 'Guantes de la Leyenda', tr: 'Efsane Eldiveni', pt: 'Luvas da Lenda' },
  bt1: { en: 'Leather Boots', uk: 'Шкіряні чоботи', es: 'Botas de Cuero',  tr: 'Deri Botlar',    pt: 'Botas de Couro' },
  bt2: { en: 'Iron Boots',    uk: 'Залізні чоботи', es: 'Botas de Hierro', tr: 'Demir Botlar',   pt: 'Botas de Ferro' },
  bt3: { en: 'Platinum Boots', uk: 'Платинові чоботи', es: 'Botas de Platino', tr: 'Platin Botlar', pt: 'Botas de Platina' },
  bt4: { en: 'Hero\'s Boots', uk: 'Чоботи героя',   es: 'Botas del Héroe', tr: 'Kahraman Botları', pt: 'Botas do Herói' },
  bt5: { en: 'Legend\'s Boots', uk: 'Чоботи легенди', es: 'Botas de la Leyenda', tr: 'Efsane Botları', pt: 'Botas da Lenda' },
  rn1: { en: 'Ring of Power',  uk: 'Каблучка сили', es: 'Anillo de Poder', tr: 'Güç Yüzüğü',     pt: 'Anel de Poder' },
  rn2: { en: 'Ring of Protection', uk: 'Каблучка захисту', es: 'Anillo de Protección', tr: 'Koruma Yüzüğü', pt: 'Anel de Proteção' },
  rn3: { en: 'Ring of Blood',  uk: 'Каблучка крові', es: 'Anillo de Sangre', tr: 'Kan Yüzüğü',    pt: 'Anel de Sangue' },
  rn4: { en: 'Hero\'s Ring',   uk: 'Каблучка героя', es: 'Anillo del Héroe', tr: 'Kahraman Yüzüğü', pt: 'Anel do Herói' },
  rn5: { en: 'Legend\'s Ring', uk: 'Каблучка легенди', es: 'Anillo de la Leyenda', tr: 'Efsane Yüzüğü', pt: 'Anel da Lenda' },
  nd1: { en: 'Belt of Power',  uk: 'Пояс сили',     es: 'Cinturón de Poder', tr: 'Güç Kemeri',   pt: 'Cinto de Poder' },
  nd2: { en: 'Belt of Health', uk: 'Пояс здоров\'я', es: 'Cinturón de Salud', tr: 'Can Kemeri',   pt: 'Cinto de Vida' },
  nd3: { en: 'Belt of Darkness', uk: 'Пояс тьми',   es: 'Cinturón de Oscuridad', tr: 'Karanlık Kemeri', pt: 'Cinto das Trevas' },
  nd4: { en: 'Hero\'s Belt',   uk: 'Пояс героя',    es: 'Cinturón del Héroe', tr: 'Kahraman Kemeri', pt: 'Cinto do Herói' },
  nd5: { en: 'Legend\'s Belt', uk: 'Пояс легенди',  es: 'Cinturón de la Leyenda', tr: 'Efsane Kemeri', pt: 'Cinto da Lenda' },
  pt1: { en: 'Small Potion',   uk: 'Мале зілля',    es: 'Poción Pequeña',  tr: 'Küçük İksir',    pt: 'Poção Pequena' },
  pt2: { en: 'Large Potion',   uk: 'Велике зілля',  es: 'Poción Grande',   tr: 'Büyük İksir',    pt: 'Poção Grande' },
  bp_hp:       { en: 'HP Potion',          uk: 'Зілля здоров\'я', es: 'Poción de Salud',   tr: 'Can İksiri',      pt: 'Poção de Vida' },
  bp_exp:      { en: 'XP Potion',          uk: 'Зілля досвіду',   es: 'Poción de Experiencia', tr: 'Tecrübe İksiri', pt: 'Poção de Experiência' },
  bp_gold:     { en: 'Gold Potion',        uk: 'Зілля золота',    es: 'Poción de Oro',     tr: 'Altın İksiri',    pt: 'Poção de Ouro' },
  bp_regen:    { en: 'Regen Potion',       uk: 'Зілля регенерації', es: 'Poción de Regeneración', tr: 'Yenilenme İksiri', pt: 'Poção de Regeneração' },
  bp_atkspeed: { en: 'Speed Potion',       uk: 'Зілля швидкості', es: 'Poción de Velocidad', tr: 'Hız İksiri',    pt: 'Poção de Velocidade' },
  bp_atk:      { en: 'Attack Potion',      uk: 'Зілля атаки',     es: 'Poción de Ataque',  tr: 'Saldırı İksiri',  pt: 'Poção de Ataque' },
};

// key: material/recipe/book id -> {en, uk, es, tr, pt}
const I18N_MATS = {
  recu: { en: 'Uncommon Recipe',  uk: 'Незвичайний рецепт', es: 'Receta Poco Común', tr: 'Nadir Olmayan Tarif', pt: 'Receita Incomum' },
  recr: { en: 'Rare Recipe',      uk: 'Рідкісний рецепт',   es: 'Receta Rara',       tr: 'Nadir Tarif',        pt: 'Receita Rara' },
  rece: { en: 'Epic Recipe',      uk: 'Епічний рецепт',     es: 'Receta Épica',      tr: 'Efsanevi Tarif',     pt: 'Receita Épica' },
  recl: { en: 'Legendary Recipe', uk: 'Легендарний рецепт', es: 'Receta Legendaria', tr: 'Efsane Tarif',       pt: 'Receita Lendária' },
  norm_stone:   { en: 'Stone of Normal Enchant', uk: 'Камінь звичайного гартування', es: 'Piedra de Encantamiento Normal', tr: 'Normal Büyü Taşı', pt: 'Pedra de Encantamento Normal' },
  bless_stone:  { en: 'Stone of Safe Enchant',   uk: 'Камінь безпечного гартування', es: 'Piedra de Encantamiento Seguro', tr: 'Güvenli Büyü Taşı', pt: 'Pedra de Encantamento Seguro' },
  teleport_stone: { en: 'Teleport Stone', uk: 'Камінь телепортації', es: 'Piedra de Teletransporte', tr: 'Işınlanma Taşı', pt: 'Pedra de Teleporte' },
  key_uncommon: { en: 'Uncommon Key', uk: 'Незвичайний ключ', es: 'Llave Poco Común', tr: 'Nadir Olmayan Anahtar', pt: 'Chave Incomum' },
  key_rare:     { en: 'Rare Key',      uk: 'Рідкісний ключ',   es: 'Llave Rara',       tr: 'Nadir Anahtar',        pt: 'Chave Rara' },
  book_lev_Q: { en: 'Book: Frost Strike',  uk: 'Книга: Крижаний удар', es: 'Libro: Golpe Helado', tr: 'Kitap: Buz Darbesi', pt: 'Livro: Golpe Gélido' },
  book_lev_W: { en: 'Book: Blade Whirl',   uk: 'Книга: Вихор клинків', es: 'Libro: Torbellino de Hojas', tr: 'Kitap: Bıçak Kasırgası', pt: 'Livro: Redemoinho de Lâminas' },
  book_lev_E: { en: 'Book: Wrath of the Dead', uk: 'Книга: Гнів мерця', es: 'Libro: Ira del Muerto', tr: 'Kitap: Ölünün Gazabı', pt: 'Livro: Fúria do Morto' },
  book_lev_R: { en: 'Book: Dash of Light', uk: 'Книга: Ривок світла', es: 'Libro: Arremetida de Luz', tr: 'Kitap: Işık Atılımı', pt: 'Livro: Investida da Luz' },
  book_deathknight_Q: { en: 'Book: Vampirism',    uk: 'Книга: Вампіризм', es: 'Libro: Vampirismo', tr: 'Kitap: Vampirlik', pt: 'Livro: Vampirismo' },
  book_deathknight_W: { en: 'Book: Blade Vortex',  uk: 'Книга: Вихор клинка', es: 'Libro: Vórtice de Hoja', tr: 'Kitap: Bıçak Girdabı', pt: 'Livro: Vórtice de Lâmina' },
  book_deathknight_E: { en: 'Book: Rage',          uk: 'Книга: Лють', es: 'Libro: Furia', tr: 'Kitap: Öfke', pt: 'Livro: Fúria' },
  book_deathknight_R: { en: 'Book: Roll',          uk: 'Книга: Кувирок', es: 'Libro: Voltereta', tr: 'Kitap: Takla', pt: 'Livro: Rolamento' },
  book_ranger_Q: { en: 'Book: Multi-Shot',   uk: 'Книга: Мультипостріл', es: 'Libro: Disparo Múltiple', tr: 'Kitap: Çoklu Atış', pt: 'Livro: Tiro Múltiplo' },
  book_ranger_W: { en: 'Book: Combo Arrow',  uk: 'Книга: Комбо-стріла', es: 'Libro: Flecha Combo', tr: 'Kitap: Kombo Ok', pt: 'Livro: Flecha Combo' },
  book_ranger_E: { en: 'Book: Jump',         uk: 'Книга: Стрибок', es: 'Libro: Salto', tr: 'Kitap: Zıplama', pt: 'Livro: Salto' },
  book_ranger_R: { en: 'Book: Attack Speed', uk: 'Книга: Швидкість атаки', es: 'Libro: Velocidad de Ataque', tr: 'Kitap: Saldırı Hızı', pt: 'Livro: Velocidade de Ataque' },
  book_mage_Q: { en: 'Book: Frost Orb',  uk: 'Книга: Крижана куля', es: 'Libro: Orbe de Hielo', tr: 'Kitap: Buz Küresi', pt: 'Livro: Orbe de Gelo' },
  book_mage_W: { en: 'Book: Frost Nova', uk: 'Книга: Крижана нова', es: 'Libro: Nova de Hielo', tr: 'Kitap: Buz Nova', pt: 'Livro: Nova de Gelo' },
  book_mage_E: { en: 'Book: Barrier',    uk: 'Книга: Бар\'єр', es: 'Libro: Barrera', tr: 'Kitap: Bariyer', pt: 'Livro: Barreira' },
  book_mage_R: { en: 'Book: Teleport',   uk: 'Книга: Телепорт', es: 'Libro: Teletransporte', tr: 'Kitap: Işınlanma', pt: 'Livro: Teleporte' },
  book_warlock_Q: { en: 'Book: Dark Heal',   uk: 'Книга: Темне зцілення', es: 'Libro: Curación Oscura', tr: 'Kitap: Karanlık Şifa', pt: 'Livro: Cura Sombria' },
  book_warlock_W: { en: 'Book: Chains of Darkness', uk: 'Книга: Кайдани темряви', es: 'Libro: Cadenas de Oscuridad', tr: 'Kitap: Karanlık Zincirleri', pt: 'Livro: Correntes das Trevas' },
  book_warlock_E: { en: 'Book: Dark Shield', uk: 'Книга: Темний щит', es: 'Libro: Escudo Oscuro', tr: 'Kitap: Karanlık Kalkan', pt: 'Livro: Escudo Sombrio' },
  book_warlock_R: { en: 'Book: Dark Prayer', uk: 'Книга: Темна молитва', es: 'Libro: Oración Oscura', tr: 'Kitap: Karanlık Dua', pt: 'Livro: Oração Sombria' },
  book_pas_tankatk: { en: 'Book: Berserker Might', uk: 'Книга: Міць берсерка', es: 'Libro: Poder del Berserker', tr: 'Kitap: Berserker Gücü', pt: 'Livro: Poder do Berserker' },
  book_pas_deftank: { en: 'Book: Unbreakable',     uk: 'Книга: Незламність', es: 'Libro: Inquebrantable', tr: 'Kitap: Yıkılmazlık', pt: 'Livro: Inquebrável' },
  book_pas_dkatk:   { en: 'Book: Blood Pact',      uk: 'Книга: Кривавий пакт', es: 'Libro: Pacto de Sangre', tr: 'Kitap: Kan Paktı', pt: 'Livro: Pacto de Sangue' },
  book_pas_dkdef:   { en: 'Book: Dark Carapace',   uk: 'Книга: Темний панцир', es: 'Libro: Caparazón Oscuro', tr: 'Kitap: Karanlık Zırh', pt: 'Livro: Carapaça Sombria' },
  book_pas_bowatk:  { en: 'Book: Keen Eye',        uk: 'Книга: Влучне око', es: 'Libro: Ojo Certero', tr: 'Kitap: Keskin Göz', pt: 'Livro: Olho Certeiro' },
  book_pas_bowdef:  { en: 'Book: Tracker\'s Instinct', uk: 'Книга: Чуття слідопита', es: 'Libro: Instinto de Rastreador', tr: 'Kitap: İzci İçgüdüsü', pt: 'Livro: Instinto de Rastreador' },
  book_pas_mageatk: { en: 'Book: Mana Flow',       uk: 'Книга: Потік мани', es: 'Libro: Flujo de Maná', tr: 'Kitap: Mana Akışı', pt: 'Livro: Fluxo de Mana' },
  book_pas_magedef: { en: 'Book: Ice Shield',      uk: 'Книга: Крижаний щит', es: 'Libro: Escudo de Hielo', tr: 'Kitap: Buz Kalkanı', pt: 'Livro: Escudo de Gelo' },
  book_pas_healatk: { en: 'Book: Dark Thirst',     uk: 'Книга: Темна спрага', es: 'Libro: Sed Oscura', tr: 'Kitap: Karanlık Susuzluk', pt: 'Livro: Sede Sombria' },
  book_pas_healdef: { en: 'Book: Dark Ward',       uk: 'Книга: Оберіг тьми', es: 'Libro: Amuleto Oscuro', tr: 'Kitap: Karanlık Muska', pt: 'Livro: Amuleto Sombrio' },
  book_pas_allatkspeed: { en: 'Book: Swiftness',   uk: 'Книга: Стрімкість', es: 'Libro: Celeridad', tr: 'Kitap: Çeviklik', pt: 'Livro: Rapidez' },
  book_pas_allhp:       { en: 'Book: Vitality',    uk: 'Книга: Живучість', es: 'Libro: Vitalidad', tr: 'Kitap: Dayanıklılık', pt: 'Livro: Vitalidade' },
  book_pas_allcritdmg:  { en: 'Book: Blood Frenzy',uk: 'Книга: Кривава лють', es: 'Libro: Frenesí Sangriento', tr: 'Kitap: Kan Çılgınlığı', pt: 'Livro: Frenesi Sangrento' },
  book_pas_allspeed:    { en: 'Book: Fleet Feet',  uk: 'Книга: Швидкі ноги', es: 'Libro: Pies Ligeros', tr: 'Kitap: Hızlı Ayaklar', pt: 'Livro: Pés Ligeiros' },
  book_pas_allcdskill:  { en: 'Book: Clear Mind',  uk: 'Книга: Ясний розум', es: 'Libro: Mente Clara', tr: 'Kitap: Berrak Zihin', pt: 'Livro: Mente Clara' },
  book_pas_allregen:    { en: 'Book: Regeneration',uk: 'Книга: Регенерація', es: 'Libro: Regeneración', tr: 'Kitap: Yenilenme', pt: 'Livro: Regeneração' },
};

const I18N_BOXES = {
  box_uncommon: { en: 'Uncommon Box', uk: 'Незвичайний бокс', es: 'Caja Poco Común', tr: 'Nadir Olmayan Kutu', pt: 'Caixa Incomum' },
  box_rare:     { en: 'Rare Box',     uk: 'Рідкісний бокс',   es: 'Caja Rara',       tr: 'Nadir Kutu',        pt: 'Caixa Rara' },
};

// key: enemy eid -> {en, uk, es, tr, pt} — base species+rank name (e.g.
// "rat_guard" = "Крыса страж"). Used both if the target-frame follow-up ever
// lands, and right now to translate quest text that embeds these names.
const I18N_ENEMIES = {
  rat_guard:      { en: 'Rat Guard',       uk: 'Щур-вартовий',   es: 'Rata Guardiana',  tr: 'Fare Muhafız',   pt: 'Rato Guardião' },
  rat_warrior:    { en: 'Rat Warrior',     uk: 'Щур-воїн',       es: 'Rata Guerrera',   tr: 'Fare Savaşçı',   pt: 'Rato Guerreiro' },
  slime_guard:    { en: 'Slime Guard',     uk: 'Слиз-вартовий',  es: 'Limo Guardián',   tr: 'Slime Muhafız',  pt: 'Lodo Guardião' },
  slime_warrior:  { en: 'Slime Warrior',   uk: 'Слиз-воїн',      es: 'Limo Guerrero',   tr: 'Slime Savaşçı',  pt: 'Lodo Guerreiro' },
  imp_guard:      { en: 'Imp Guard',       uk: 'Біс-вартовий',   es: 'Diablillo Guardián', tr: 'İblis Muhafız', pt: 'Diabrete Guardião' },
  imp_warrior:    { en: 'Imp Warrior',     uk: 'Біс-воїн',       es: 'Diablillo Guerrero', tr: 'İblis Savaşçı', pt: 'Diabrete Guerreiro' },
  imp_boss:       { en: 'Imp Boss',        uk: 'Бос бісів',      es: 'Jefe Diablillo',  tr: 'İblis Patronu',  pt: 'Chefe Diabrete' },
  zombie_guard:   { en: 'Zombie Guard',    uk: 'Зомбі-вартовий', es: 'Zombi Guardián',  tr: 'Zombi Muhafız',  pt: 'Zumbi Guardião' },
  zombie_warrior: { en: 'Zombie Warrior',  uk: 'Зомбі-воїн',     es: 'Zombi Guerrero',  tr: 'Zombi Savaşçı',  pt: 'Zumbi Guerreiro' },
  lizardman_guard:   { en: 'Lizardman Guard',   uk: 'Ящір-вартовий', es: 'Hombre Lagarto Guardián', tr: 'Kertenkele Muhafız', pt: 'Homem-Lagarto Guardião' },
  lizardman_warrior: { en: 'Lizardman Warrior', uk: 'Ящір-воїн',    es: 'Hombre Lagarto Guerrero', tr: 'Kertenkele Savaşçı', pt: 'Homem-Lagarto Guerreiro' },
  orc_guard:      { en: 'Orc Guard',       uk: 'Орк-вартовий',   es: 'Orco Guardián',   tr: 'Ork Muhafız',    pt: 'Orc Guardião' },
  orc_warrior:    { en: 'Orc Warrior',     uk: 'Орк-воїн',       es: 'Orco Guerrero',   tr: 'Ork Savaşçı',    pt: 'Orc Guerreiro' },
  orc_boss:       { en: 'Orc Boss',        uk: 'Бос орків',      es: 'Jefe Orco',       tr: 'Ork Patronu',    pt: 'Chefe Orc' },
  plant_guard:    { en: 'Vine Guard',      uk: 'Лоза-вартовий',  es: 'Enredadera Guardiana', tr: 'Asma Muhafız', pt: 'Trepadeira Guardiã' },
  plant_warrior:  { en: 'Vine Warrior',    uk: 'Лоза-воїн',      es: 'Enredadera Guerrera', tr: 'Asma Savaşçı', pt: 'Trepadeira Guerreira' },
  vampire_guard:  { en: 'Vampire Guard',   uk: 'Вампір-вартовий', es: 'Vampiro Guardián', tr: 'Vampir Muhafız', pt: 'Vampiro Guardião' },
  vampire_warrior:{ en: 'Vampire Warrior', uk: 'Вампір-воїн',    es: 'Vampiro Guerrero', tr: 'Vampir Savaşçı', pt: 'Vampiro Guerreiro' },
  beholder_guard: { en: 'Beholder Guard',  uk: 'Глазир-вартовий', es: 'Observador Guardián', tr: 'Gözcü Muhafız', pt: 'Observador Guardião' },
  beholder_warrior: { en: 'Beholder Warrior', uk: 'Глазир-воїн', es: 'Observador Guerrero', tr: 'Gözcü Savaşçı', pt: 'Observador Guerreiro' },
  beholder_boss:  { en: 'Beholder Boss',   uk: 'Бос глазирів',   es: 'Jefe Observador', tr: 'Gözcü Patronu',  pt: 'Chefe Observador' },
  ent_guard:      { en: 'Ent Guard',       uk: 'Древень-вартовий', es: 'Ent Guardián',  tr: 'Ent Muhafız',    pt: 'Ent Guardião' },
  ent_warrior:    { en: 'Ent Warrior',     uk: 'Древень-воїн',   es: 'Ent Guerrero',    tr: 'Ent Savaşçı',    pt: 'Ent Guerreiro' },
  demon_guard:    { en: 'Demon Guard',     uk: 'Демон-вартовий', es: 'Demonio Guardián', tr: 'Şeytan Muhafız', pt: 'Demônio Guardião' },
  demon_warrior:  { en: 'Demon Warrior',   uk: 'Демон-воїн',     es: 'Demonio Guerrero', tr: 'Şeytan Savaşçı', pt: 'Demônio Guerreiro' },
  demon_boss:     { en: 'Demon Boss',      uk: 'Бос демонів',    es: 'Jefe Demonio',    tr: 'Şeytan Patronu', pt: 'Chefe Demônio' },
};
// Reverse index built lazily (RU base name -> eid) so quest desc translation
// can look up an enemy's localized name starting only from the RU string
// baked into QUEST_DEF.enemies[].
let _ruEnemyNameToEid = null;
function _enemyEidForRuName(ruName) {
  if (!_ruEnemyNameToEid) {
    // Must read the PRISTINE RU name (_i18nOrigName, set by _i18nSnapshot
    // before any mutation), not the live .name field — by the time this is
    // first called (from applyLocale, after ENEMY_DEF has already been
    // rewritten to the target language earlier in the same call), .name no
    // longer holds Russian text and this lookup would always miss.
    _ruEnemyNameToEid = {};
    (typeof ENEMY_DEF !== 'undefined' ? ENEMY_DEF : []).forEach(d => { _ruEnemyNameToEid[d._i18nOrigName || d.name] = d.eid; });
  }
  return _ruEnemyNameToEid[ruName] || null;
}
function _tEnemyBaseName(ruName, lang) {
  const eid = _enemyEidForRuName(ruName);
  const e = eid && I18N_ENEMIES[eid];
  return (e && e[lang]) || ruName;
}

// ── Quest titles (60) — key: quest id ──
const I18N_QUEST_TITLES = {
  f1q1:  { en: 'First Blood',        uk: 'Перша кров',        es: 'Primera Sangre',      tr: 'İlk Kan',           pt: 'Primeiro Sangue' },
  f1q2:  { en: 'The Guard Falls',    uk: 'Вартовий впаде',     es: 'Cae el Guardián',     tr: 'Muhafız Düşecek',  pt: 'O Guardião Cai' },
  f1q3:  { en: 'Trading',           uk: 'Торгівля',            es: 'Comercio',            tr: 'Ticaret',           pt: 'Comércio' },
  f1q4:  { en: 'Hunter',            uk: 'Мисливець',           es: 'Cazador',             tr: 'Avcı',              pt: 'Caçador' },
  f1q5:  { en: 'Punisher',          uk: 'Каратель',            es: 'Castigador',          tr: 'Cezalandırıcı',    pt: 'Punidor' },
  f1q6:  { en: 'Seasoned Fighter',  uk: 'Досвідчений боєць',   es: 'Luchador Experto',    tr: 'Deneyimli Savaşçı', pt: 'Lutador Experiente' },
  f1q7:  { en: 'Slime Hunter',      uk: 'Ловець слизу',        es: 'Cazador de Limo',     tr: 'Slime Avcısı',      pt: 'Caçador de Lodo' },
  f1q8:  { en: 'Scourge of Imps',   uk: 'Гроза бісів',         es: 'Azote de Diablillos', tr: 'İblis Belası',      pt: 'Flagelo dos Diabretes' },
  f1q10: { en: 'Veteran',          uk: 'Ветеран',             es: 'Veterano',            tr: 'Gazi',              pt: 'Veterano' },
  f1q11: { en: 'Conqueror',        uk: 'Підкорювач',          es: 'Conquistador',        tr: 'Fatih',             pt: 'Conquistador' },
  f1q12: { en: 'Butcher',          uk: 'М\'ясник',            es: 'Carnicero',           tr: 'Kasap',             pt: 'Açougueiro' },
  f1q13: { en: 'Berserker',        uk: 'Берсерк',             es: 'Berserker',           tr: 'Berserker',         pt: 'Berserker' },
  f1q14: { en: 'Tempering',        uk: 'Загартування',        es: 'Templanza',           tr: 'Pekişme',           pt: 'Têmpera' },
  f1q9:  { en: 'Imp Banisher',     uk: 'Виганяч бісів',       es: 'Expulsor de Diablillos', tr: 'İblis Kovucu',   pt: 'Banidor de Diabretes' },
  f1q15: { en: 'Farmer',           uk: 'Фермер',              es: 'Granjero',            tr: 'Çiftçi',            pt: 'Fazendeiro' },

  f2q1:  { en: 'First Blood II',       uk: 'Перша кров II',       es: 'Primera Sangre II',     tr: 'İlk Kan II',          pt: 'Primeiro Sangue II' },
  f2q2:  { en: 'The Guard Falls II',   uk: 'Вартовий впаде II',   es: 'Cae el Guardián II',    tr: 'Muhafız Düşecek II', pt: 'O Guardião Cai II' },
  f2q3:  { en: 'Trading II',           uk: 'Торгівля II',          es: 'Comercio II',           tr: 'Ticaret II',          pt: 'Comércio II' },
  f2q4:  { en: 'Hunter II',            uk: 'Мисливець II',         es: 'Cazador II',            tr: 'Avcı II',             pt: 'Caçador II' },
  f2q5:  { en: 'Punisher II',          uk: 'Каратель II',          es: 'Castigador II',         tr: 'Cezalandırıcı II',   pt: 'Punidor II' },
  f2q6:  { en: 'Seasoned Fighter II',  uk: 'Досвідчений боєць II', es: 'Luchador Experto II',   tr: 'Deneyimli Savaşçı II', pt: 'Lutador Experiente II' },
  f2q7:  { en: 'Lizardman Hunter',     uk: 'Мисливець на ящерів',  es: 'Cazador de Hombres Lagarto', tr: 'Kertenkele Avcısı', pt: 'Caçador de Homens-Lagarto' },
  f2q8:  { en: 'Fury of the Orcs',     uk: 'Лють орків',           es: 'Furia de los Orcos',    tr: 'Ork Öfkesi',          pt: 'Fúria dos Orcs' },
  f2q10: { en: 'Veteran II',           uk: 'Ветеран II',           es: 'Veterano II',           tr: 'Gazi II',             pt: 'Veterano II' },
  f2q11: { en: 'Conqueror II',         uk: 'Підкорювач II',        es: 'Conquistador II',       tr: 'Fatih II',            pt: 'Conquistador II' },
  f2q12: { en: 'Butcher II',           uk: 'М\'ясник II',          es: 'Carnicero II',          tr: 'Kasap II',            pt: 'Açougueiro II' },
  f2q13: { en: 'Berserker II',         uk: 'Берсерк II',           es: 'Berserker II',          tr: 'Berserker II',        pt: 'Berserker II' },
  f2q14: { en: 'Honored Member',       uk: 'Почесний член',        es: 'Miembro Honorario',     tr: 'Onursal Üye',         pt: 'Membro Honorário' },
  f2q9:  { en: 'Boss Slayer II',       uk: 'Вбивця босів II',      es: 'Cazador de Jefes II',   tr: 'Patron Avcısı II',    pt: 'Matador de Chefes II' },
  f2q15: { en: 'Into the Dark',        uk: 'У глиб темряви',       es: 'Hacia la Oscuridad',    tr: 'Karanlığın Derinliklerine', pt: 'Rumo às Trevas' },

  f3q1:  { en: 'First Blood III',      uk: 'Перша кров III',       es: 'Primera Sangre III',    tr: 'İlk Kan III',         pt: 'Primeiro Sangue III' },
  f3q2:  { en: 'The Guard Falls III',  uk: 'Вартовий впаде III',   es: 'Cae el Guardián III',   tr: 'Muhafız Düşecek III', pt: 'O Guardião Cai III' },
  f3q3:  { en: 'Trading III',          uk: 'Торгівля III',         es: 'Comercio III',          tr: 'Ticaret III',         pt: 'Comércio III' },
  f3q4:  { en: 'Hunter III',           uk: 'Мисливець III',        es: 'Cazador III',           tr: 'Avcı III',            pt: 'Caçador III' },
  f3q5:  { en: 'Punisher III',         uk: 'Каратель III',         es: 'Castigador III',        tr: 'Cezalandırıcı III',   pt: 'Punidor III' },
  f3q6:  { en: 'Seasoned Fighter III', uk: 'Досвідчений боєць III',es: 'Luchador Experto III',  tr: 'Deneyimli Savaşçı III', pt: 'Lutador Experiente III' },
  f3q7:  { en: 'Vampire Hunter',       uk: 'Мисливець на вампірів',es: 'Cazador de Vampiros',   tr: 'Vampir Avcısı',       pt: 'Caçador de Vampiros' },
  f3q8:  { en: 'Gaze of the Abyss',    uk: 'Погляд безодні',       es: 'Mirada del Abismo',     tr: 'Uçurumun Bakışı',     pt: 'Olhar do Abismo' },
  f3q10: { en: 'Veteran III',          uk: 'Ветеран III',          es: 'Veterano III',          tr: 'Gazi III',            pt: 'Veterano III' },
  f3q11: { en: 'Conqueror III',        uk: 'Підкорювач III',       es: 'Conquistador III',      tr: 'Fatih III',           pt: 'Conquistador III' },
  f3q12: { en: 'Butcher III',          uk: 'М\'ясник III',         es: 'Carnicero III',         tr: 'Kasap III',           pt: 'Açougueiro III' },
  f3q13: { en: 'Berserker III',        uk: 'Берсерк III',          es: 'Berserker III',         tr: 'Berserker III',       pt: 'Berserker III' },
  f3q14: { en: 'Pillar of the Clan',   uk: 'Стовп клану',          es: 'Pilar del Clan',        tr: 'Klanın Direği',       pt: 'Pilar do Clã' },
  f3q9:  { en: 'Boss Slayer III',      uk: 'Вбивця босів III',     es: 'Cazador de Jefes III',  tr: 'Patron Avcısı III',   pt: 'Matador de Chefes III' },
  f3q15: { en: 'To the Edge of the World', uk: 'На край світу',    es: 'Al Fin del Mundo',      tr: 'Dünyanın Ucuna',      pt: 'Até o Fim do Mundo' },

  f4q1:  { en: 'First Blood IV',       uk: 'Перша кров IV',        es: 'Primera Sangre IV',     tr: 'İlk Kan IV',          pt: 'Primeiro Sangue IV' },
  f4q2:  { en: 'The Guard Falls IV',   uk: 'Вартовий впаде IV',    es: 'Cae el Guardián IV',    tr: 'Muhafız Düşecek IV',  pt: 'O Guardião Cai IV' },
  f4q3:  { en: 'Trading IV',           uk: 'Торгівля IV',          es: 'Comercio IV',           tr: 'Ticaret IV',          pt: 'Comércio IV' },
  f4q4:  { en: 'Hunter IV',            uk: 'Мисливець IV',         es: 'Cazador IV',            tr: 'Avcı IV',             pt: 'Caçador IV' },
  f4q5:  { en: 'Punisher IV',          uk: 'Каратель IV',          es: 'Castigador IV',         tr: 'Cezalandırıcı IV',    pt: 'Punidor IV' },
  f4q6:  { en: 'Seasoned Fighter IV',  uk: 'Досвідчений боєць IV', es: 'Luchador Experto IV',   tr: 'Deneyimli Savaşçı IV', pt: 'Lutador Experiente IV' },
  f4q7:  { en: 'Demon Banisher',       uk: 'Виганяч демонів',      es: 'Expulsor de Demonios',  tr: 'Şeytan Kovucu',       pt: 'Banidor de Demônios' },
  f4q8:  { en: 'Flame of the Abyss',   uk: 'Полум\'я безодні',     es: 'Llama del Abismo',      tr: 'Uçurumun Alevi',      pt: 'Chama do Abismo' },
  f4q10: { en: 'Veteran IV',           uk: 'Ветеран IV',           es: 'Veterano IV',           tr: 'Gazi IV',             pt: 'Veterano IV' },
  f4q11: { en: 'Conqueror IV',         uk: 'Підкорювач IV',        es: 'Conquistador IV',       tr: 'Fatih IV',            pt: 'Conquistador IV' },
  f4q12: { en: 'Butcher IV',           uk: 'М\'ясник IV',          es: 'Carnicero IV',          tr: 'Kasap IV',            pt: 'Açougueiro IV' },
  f4q13: { en: 'Berserker IV',         uk: 'Берсерк IV',           es: 'Berserker IV',          tr: 'Berserker IV',        pt: 'Berserker IV' },
  f4q14: { en: 'Legend of the Clan',   uk: 'Легенда клану',        es: 'Leyenda del Clan',      tr: 'Klanın Efsanesi',     pt: 'Lenda do Clã' },
  f4q9:  { en: 'Boss Slayer IV',       uk: 'Вбивця босів IV',      es: 'Cazador de Jefes IV',   tr: 'Patron Avcısı IV',    pt: 'Matador de Chefes IV' },
  f4q15: { en: 'Lord of the Dungeon',  uk: 'Володар підземелля',   es: 'Señor de la Mazmorra',  tr: 'Zindanın Efendisi',   pt: 'Senhor da Masmorra' },
};

// ── Quest description templates (data-driven, covers all 60 quests) ──
// uk values are genitive case ("до верхнього коридору") since every
// template below places them after "до" (to/toward), which in Ukrainian
// (like Russian) governs the genitive — nominative here would be a
// grammar error even though the other four languages don't decline nouns
// this way.
const _CORRIDOR_NAME = {
  2: { en: 'top corridor',    uk: 'верхнього коридору', es: 'corredor superior', tr: 'üst koridor',  pt: 'corredor superior' },
  3: { en: 'bottom corridor', uk: 'нижнього коридору',  es: 'corredor inferior', tr: 'alt koridor',  pt: 'corredor inferior' },
  4: { en: 'right corridor',  uk: 'правого коридору',   es: 'corredor derecho',  tr: 'sağ koridor',  pt: 'corredor direito' },
};
const I18N_QUEST_TPL = {
  en: {
    kill: (n, enemy) => `Kill ${n} ${enemy}`,
    buyPotion: (n) => `Buy ${n} potions`,
    level: (lvl) => `Reach level ${lvl}`,
    joinClan: () => 'Join a clan',
    promoteClan: () => 'Get promoted in your clan',
    gotoFloor: (floor) => `Reach the ${_CORRIDOR_NAME[floor].en}`,
    dungeonClear: (floor) => `Reach the end of the ${_CORRIDOR_NAME[floor].en}`,
    enterFarmZone: () => 'Enter the Farm Zone',
  },
  uk: {
    kill: (n, enemy) => `Вбий ${n} ${enemy}`,
    buyPotion: (n) => `Купи ${n} зіль`,
    level: (lvl) => `Досягни ${lvl} рівня`,
    joinClan: () => 'Вступи до клану',
    promoteClan: () => 'Підвищ ранг у клані',
    gotoFloor: (floor) => `Дійди до ${_CORRIDOR_NAME[floor].uk}`,
    dungeonClear: (floor) => `Дійди до кінця ${_CORRIDOR_NAME[floor].uk}`,
    enterFarmZone: () => 'Зайди у Ферм-зону',
  },
  es: {
    kill: (n, enemy) => `Mata a ${n} ${enemy}`,
    buyPotion: (n) => `Compra ${n} pociones`,
    level: (lvl) => `Alcanza el nivel ${lvl}`,
    joinClan: () => 'Únete a un clan',
    promoteClan: () => 'Sube de rango en tu clan',
    gotoFloor: (floor) => `Llega al ${_CORRIDOR_NAME[floor].es}`,
    dungeonClear: (floor) => `Llega al final del ${_CORRIDOR_NAME[floor].es}`,
    enterFarmZone: () => 'Entra en la Zona de Farmeo',
  },
  tr: {
    kill: (n, enemy) => `${n} ${enemy} öldür`,
    buyPotion: (n) => `${n} iksir satın al`,
    level: (lvl) => `${lvl}. seviyeye ulaş`,
    joinClan: () => 'Bir klana katıl',
    promoteClan: () => 'Klanında rütbe atla',
    gotoFloor: (floor) => `${_CORRIDOR_NAME[floor].tr}'a ulaş`,
    dungeonClear: (floor) => `${_CORRIDOR_NAME[floor].tr}'un sonuna ulaş`,
    enterFarmZone: () => "Çiftlik Bölgesi'ne gir",
  },
  pt: {
    kill: (n, enemy) => `Mate ${n} ${enemy}`,
    buyPotion: (n) => `Compre ${n} poções`,
    level: (lvl) => `Alcance o nível ${lvl}`,
    joinClan: () => 'Entre em um clã',
    promoteClan: () => 'Suba de patente no seu clã',
    gotoFloor: (floor) => `Chegue ao ${_CORRIDOR_NAME[floor].pt}`,
    dungeonClear: (floor) => `Chegue ao fim do ${_CORRIDOR_NAME[floor].pt}`,
    enterFarmZone: () => 'Entre na Zona de Farm',
  },
};
function _questDescFor(q, lang) {
  const tpl = I18N_QUEST_TPL[lang];
  if (!tpl) return q._i18nOrigDesc || q.desc;
  switch (q.type) {
    case 'kill': {
      const enemyRu = (q.enemies && q.enemies[0]) || '';
      return tpl.kill(q.count, _tEnemyBaseName(enemyRu, lang));
    }
    case 'buy_potion': return tpl.buyPotion(q.count);
    case 'level': return tpl.level(q.level);
    case 'join_guild': return (q._i18nOrigDesc || q.desc).indexOf('Вступи') === 0 ? tpl.joinClan() : tpl.promoteClan();
    case 'goto_floor': return tpl.gotoFloor(q.targetFloor);
    case 'dungeon_clear': return tpl.dungeonClear(q.floor);
    case 'enter_zone': return q.zone === 'farmZone' ? tpl.enterFarmZone() : (q._i18nOrigDesc || q.desc);
    default: return q._i18nOrigDesc || q.desc;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Snapshot + apply
// ═══════════════════════════════════════════════════════════════════════
let _i18nSnapshotDone = false;
function _i18nSnapshot() {
  if (_i18nSnapshotDone) return;
  _i18nSnapshotDone = true;
  if (typeof ITEM_DEF !== 'undefined') ITEM_DEF.forEach(d => { d._i18nOrigName = d.name; });
  if (typeof CRAFT_MATS !== 'undefined') CRAFT_MATS.forEach(d => { d._i18nOrigName = d.name; });
  if (typeof BOX_DEF !== 'undefined') BOX_DEF.forEach(d => { d._i18nOrigName = d.name; });
  if (typeof ENEMY_DEF !== 'undefined') ENEMY_DEF.forEach(d => { d._i18nOrigName = d.name; });
  if (typeof QUEST_DEF !== 'undefined') QUEST_DEF.forEach(q => {
    q._i18nOrigTitle = q.title;
    q._i18nOrigDesc = q.desc;
    if (q.enemies) q._i18nOrigEnemies = [...q.enemies];
  });
  if (typeof CHAR_DEF !== 'undefined') Object.keys(CHAR_DEF).forEach(k => { CHAR_DEF[k]._i18nOrigName = CHAR_DEF[k].name; });
  if (typeof SKILL_DEF !== 'undefined') Object.keys(SKILL_DEF).forEach(cls => {
    SKILL_DEF[cls].forEach(s => { s._i18nOrigName = s.name; s._i18nOrigDesc = s.desc; });
  });
  if (typeof ADV_SKILL_DEF !== 'undefined') Object.keys(ADV_SKILL_DEF).forEach(cls => {
    ADV_SKILL_DEF[cls].forEach(s => { s._i18nOrigName = s.name; s._i18nOrigDesc = s.desc; });
  });
  if (typeof PASSIVE_CLASS_DEF !== 'undefined') Object.keys(PASSIVE_CLASS_DEF).forEach(cls => {
    PASSIVE_CLASS_DEF[cls].forEach(p => { p._i18nOrigName = p.name; p._i18nOrigDesc = p.desc; });
  });
  if (typeof PASSIVE_COMMON_DEF !== 'undefined') PASSIVE_COMMON_DEF.forEach(p => { p._i18nOrigName = p.name; p._i18nOrigDesc = p.desc; });
  if (typeof NPC_DEF !== 'undefined') NPC_DEF.forEach(n => { n._i18nOrigName = n.name; n._i18nOrigDesc = n.desc; });
  if (typeof MERCHANT_SHOP_UI !== 'undefined') MERCHANT_SHOP_UI.forEach(m => { m._i18nOrigName = m.name; });
  if (typeof EQ_SLOTS !== 'undefined') EQ_SLOTS.forEach(s => { s._i18nOrigLabel = s.label; });
  if (typeof UPGRADE_DEF !== 'undefined') Object.keys(UPGRADE_DEF).forEach(k => {
    UPGRADE_DEF[k]._i18nOrigLabel = UPGRADE_DEF[k].label; UPGRADE_DEF[k]._i18nOrigDesc = UPGRADE_DEF[k].desc;
  });
  if (typeof CLAN_LEVELS !== 'undefined') CLAN_LEVELS.forEach(l => { l._i18nOrigLabel = l.label; });
  if (typeof _RARITY_NAMES !== 'undefined') { window._i18nOrigRarityNames = { ..._RARITY_NAMES }; }
  if (typeof _SLOT_NAMES !== 'undefined') { window._i18nOrigSlotNames = { ..._SLOT_NAMES }; }
}

// Rewrites every data array's display fields in place for `lang` — every
// existing `.find(...).name`-style lookup across the whole app then just
// shows the right language automatically. Always derives from the pristine
// RU snapshot (_i18nSnapshot), never from whatever the fields currently
// hold, so switching languages back and forth is always correct.
function applyLocale(lang, opts) {
  _i18nSnapshot();
  currentLang = lang;
  const isRu = lang === 'ru';
  const pick = (dict, key, fallback) => (!isRu && dict[key] && dict[key][lang]) || fallback;
  const pickField = (dict, key, field, fallback) => (!isRu && dict[key] && dict[key][field] && dict[key][field][lang]) || fallback;

  if (typeof ITEM_DEF !== 'undefined') ITEM_DEF.forEach(d => { d.name = pick(I18N_ITEMS, d.id, d._i18nOrigName); });
  if (typeof CRAFT_MATS !== 'undefined') CRAFT_MATS.forEach(d => { d.name = pick(I18N_MATS, d.id, d._i18nOrigName); });
  if (typeof BOX_DEF !== 'undefined') BOX_DEF.forEach(d => { d.name = pick(I18N_BOXES, d.id, d._i18nOrigName); });
  if (typeof ENEMY_DEF !== 'undefined') ENEMY_DEF.forEach(d => { d.name = pick(I18N_ENEMIES, d.eid, d._i18nOrigName); });

  if (typeof QUEST_DEF !== 'undefined') QUEST_DEF.forEach(q => {
    q.title = pick(I18N_QUEST_TITLES, q.id, q._i18nOrigTitle);
    q.desc = isRu ? q._i18nOrigDesc : _questDescFor({ ...q, desc: q._i18nOrigDesc, enemies: q._i18nOrigEnemies || q.enemies }, lang);
    if (q._i18nOrigEnemies) {
      q.enemies = isRu ? [...q._i18nOrigEnemies] : q._i18nOrigEnemies.map(e => _tEnemyBaseName(e, lang));
    }
  });

  if (typeof CHAR_DEF !== 'undefined') Object.keys(CHAR_DEF).forEach(k => { CHAR_DEF[k].name = pick(I18N_CLASSES, k, CHAR_DEF[k]._i18nOrigName); });

  if (typeof SKILL_DEF !== 'undefined') Object.keys(SKILL_DEF).forEach(cls => {
    SKILL_DEF[cls].forEach(s => {
      const src = I18N_SKILLS[cls] && I18N_SKILLS[cls][s.key];
      s.name = pickField({ x: src }, 'x', 'name', s._i18nOrigName);
      s.desc = pickField({ x: src }, 'x', 'desc', s._i18nOrigDesc);
    });
  });
  if (typeof ADV_SKILL_DEF !== 'undefined') Object.keys(ADV_SKILL_DEF).forEach(cls => {
    ADV_SKILL_DEF[cls].forEach(s => {
      const src = I18N_ADV_SKILLS[cls] && I18N_ADV_SKILLS[cls][s.key];
      s.name = pickField({ x: src }, 'x', 'name', s._i18nOrigName);
      s.desc = pickField({ x: src }, 'x', 'desc', s._i18nOrigDesc);
    });
  });

  if (typeof PASSIVE_CLASS_DEF !== 'undefined') Object.keys(PASSIVE_CLASS_DEF).forEach(cls => {
    PASSIVE_CLASS_DEF[cls].forEach(p => {
      p.name = pickField(I18N_PASSIVES, p.id, 'name', p._i18nOrigName);
      p.desc = pickField(I18N_PASSIVES, p.id, 'desc', p._i18nOrigDesc);
    });
  });
  if (typeof PASSIVE_COMMON_DEF !== 'undefined') PASSIVE_COMMON_DEF.forEach(p => {
    p.name = pickField(I18N_PASSIVES, p.id, 'name', p._i18nOrigName);
    p.desc = pickField(I18N_PASSIVES, p.id, 'desc', p._i18nOrigDesc);
  });

  if (typeof NPC_DEF !== 'undefined') NPC_DEF.forEach(n => {
    n.name = pickField(I18N_NPCS, n.id, 'name', n._i18nOrigName);
    n.desc = pickField(I18N_NPCS, n.id, 'desc', n._i18nOrigDesc);
  });
  if (typeof MERCHANT_SHOP_UI !== 'undefined') MERCHANT_SHOP_UI.forEach(m => { m.name = pick(I18N_ITEMS, m.itemId, m._i18nOrigName); });

  if (typeof EQ_SLOTS !== 'undefined') EQ_SLOTS.forEach(s => { s.label = pick(I18N_EQ_SLOT_LABELS, s.slot, s._i18nOrigLabel); });
  if (typeof UPGRADE_DEF !== 'undefined') Object.keys(UPGRADE_DEF).forEach(k => {
    UPGRADE_DEF[k].label = pickField(I18N_UPGRADES, k, 'label', UPGRADE_DEF[k]._i18nOrigLabel);
    UPGRADE_DEF[k].desc = pickField(I18N_UPGRADES, k, 'desc', UPGRADE_DEF[k]._i18nOrigDesc);
  });
  if (typeof CLAN_LEVELS !== 'undefined') CLAN_LEVELS.forEach(l => { l.label = pick(I18N_CLAN_LEVELS, l.lvl, l._i18nOrigLabel); });

  if (typeof _RARITY_NAMES !== 'undefined' && window._i18nOrigRarityNames) {
    Object.keys(window._i18nOrigRarityNames).forEach(k => { _RARITY_NAMES[k] = pick(I18N_RARITY, k, window._i18nOrigRarityNames[k]); });
  }
  if (typeof _SLOT_NAMES !== 'undefined' && window._i18nOrigSlotNames) {
    Object.keys(window._i18nOrigSlotNames).forEach(k => { _SLOT_NAMES[k] = pick(I18N_SLOTS, k, window._i18nOrigSlotNames[k]); });
  }

  applyDomTranslations();
  // Called with skipRerender at page load — see initLocale for why the
  // re-render cannot run until the rest of the bundle has executed.
  if (opts && opts.skipRerender) return;
  // Re-render whatever's currently visible so the switch shows up immediately.
  // Wrapped in try/catch: applyLocale() runs once at page load (initLocale(),
  // called from the bottom of js/network.js) *before* later-loading bundle
  // files (js/quests.js, js/clans.js, js/game.js, js/npc.js — see
  // BUNDLE_FILES in server/index.js) have executed their own top-level
  // `let`/`const` declarations. Referencing one of those bindings here even
  // via `typeof` throws (TDZ — unlike a truly undeclared name, `typeof` does
  // NOT safely return 'undefined' for a `let`/`const` that exists later in
  // the same concatenated script but hasn't been reached yet), and an
  // uncaught throw here would abort every top-level statement after it in
  // network.js — including _initTelegramWidget(), i.e. the whole game would
  // never start. Hit exactly this with _activeQuestTab (js/quests.js).
  // Each call is guarded on its own rather than sharing one try/catch: the
  // _activeQuestTab TDZ throw described above aborted the whole block, so at
  // page load the two calls after it (the VIP panel and the language picker)
  // never ran either. Per-call isolation keeps one not-yet-initialised binding
  // from silently skipping unrelated re-renders.
  const _try = (label, fn) => {
    try { fn(); } catch (err) { console.error('[i18n] applyLocale: ' + label + ' skipped:', err); }
  };
  _try('inventory',  () => { if (typeof updateInvUI === 'function') updateInvUI(); });
  _try('profile',    () => { if (typeof updateProfileUI === 'function') updateProfileUI(); });
  _try('quests',     () => { if (typeof updateQuestUI === 'function') updateQuestUI(); });
  _try('specialQuests', () => {
    if (typeof updateSpecialQuestUI === 'function' && typeof _activeQuestTab !== 'undefined' && _activeQuestTab === 'special') updateSpecialQuestUI();
  });
  _try('vip',        () => { if (typeof renderVipPanel === 'function' && typeof window._vipData !== 'undefined') renderVipPanel(); });
  _try('langPicker', () => { if (typeof _renderLangPicker === 'function') _renderLangPicker(); });
}

// Persisted via localStorage immediately (works even before login) and
// mirrored into the server save blob (js/network.js's _buildSaveStats/
// restoreFromSave) so it follows the account across devices too.
function setLang(code) {
  if (!I18N_LANGS.some(l => l.code === code)) return;
  applyLocale(code);
  try { localStorage.setItem('lang', code); } catch (_) {}
  if (typeof netSaveProgress === 'function') netSaveProgress();
}

function _loadSavedLang() {
  try {
    const saved = localStorage.getItem('lang');
    if (saved && I18N_LANGS.some(l => l.code === saved)) return saved;
  } catch (_) {}
  return 'ru';
}

// Called once on startup (js/network.js) before the first UI render.
//
// The re-render half is deferred to the end of the current task rather than
// run inline. The bundle is 24 files in ONE script, and initLocale is called
// from network.js — which sits ahead of quests.js, clans.js, game.js and
// npc.js in the concat order, so their top-level `let`/`const` bindings do not
// exist yet. Touching one is a TDZ throw, which `typeof` does NOT make safe
// for a binding declared later in the same script, and applyLocale's re-render
// block touches several. It was caught per call and logged, so the damage was
// only that those panels silently kept their previous language — but the
// throw was real and it happened on every single page load.
//
// A microtask runs after the whole script has finished executing, so by then
// every file's declarations exist and there is nothing to trip over. The
// translation of the DATA still happens synchronously here: that is what the
// first render reads.
function initLocale() {
  const lang = _loadSavedLang();
  applyLocale(lang, { skipRerender: true });
  queueMicrotask(() => applyLocale(lang));
}
