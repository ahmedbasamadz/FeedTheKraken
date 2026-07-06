// ============================================
// GameRoom - محرك اللعبة الكامل
// State Machine يدير كل مراحل وقواعد اللعبة
// ============================================

const crypto = require('crypto');
const C = require('./constants');
const { buildLongJourneyMap, VICTORY, START_HEX, SUPPLY_LINE_AFTER_ROW, isVictory, isValidExit, serializeMap } = require('./mapLong');
const { CHARACTERS, CHARACTER_BY_ID } = require('./characters');

const RESOLVE_DELAY_MS = 0;
const MUTINY_COMMIT_DELAY_MS = 0;

const BEFORE_SUPPLY_LINE = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]);

const PHASES = {
  LOBBY: 'lobby',
  GATHERING: 'pirate_gathering',     // التجمع السري للقراصنة
  APPOINT: 'appoint_team',           // 1. تعيين فريق الملاحة
  LOYALTY_COMMIT: 'loyalty_commit',  // 2. سؤال الولاء - وضع المسدسات سراً
  POST_REVEAL: 'post_reveal',        // نافذة بطاقات "فوراً بعد كشف المسدسات"
  MUTINY_TIE: 'mutiny_tie',          // حل التعادل في مطيانة ناجحة
  NAV_CAPTAIN: 'nav_captain',        // 3. الملاحة - القبطان يختار
  NAV_LIEUTENANT: 'nav_lieutenant',  //    الـ Lieutenant يختار
  NAV_NAVIGATOR: 'nav_navigator',    //    الـ Navigator يختار
  MAP_ACTION: 'map_action',          // II. تنفيذ Map Action
  CARD_ACTION: 'card_action',        // III. تنفيذ Navigation Card Action
  CULT_RITUAL: 'cult_ritual',        // طقس الـ Cult (بعد Cult Uprising)
  GAME_OVER: 'game_over',
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class GameRoom {
  constructor(code, narratorId, mode = 'long') {
    // R-MIN5: اللعبة مصممة لـ 5 لاعبين كحد أدنى — رفض أي وضع أقل (test3/quick سابقاً)
    if (mode === 'three_player' || mode === 'test3') {
      throw new Error('عذراً يا قبطان! اللعبة مصممة لـ 5 لاعبين كحد أدنى.');
    }
    this.code = code;
    this.narratorId = narratorId;
    // [توحيد الخرائط] Long Journey فقط — خريطة الـ 31 خلية + 23 ورقة لكل الألعاب
    this.mode = 'long';
    this.phase = PHASES.LOBBY;
    this.readyPlayers = new Set();
    this.players = []; // بترتيب الجلوس (seat order = ترتيب الانضمام، الراوي يقدر يعدله)
    this.log = [];
    this.winner = null;
    this.winReason = null;

    // الخريطة والسفينة
    this.map = buildLongJourneyMap();
    this.shipHex = START_HEX;
    this.usedMapActions = new Set(); // الـ tokens تُستخدم مرة واحدة فقط

    // الأوراق
    this.drawPile = [];
    this.discardPile = []; // الـ Deep Sea
    this.cultRitualDeck = [];

    // الأدوار الحالية
    this.captainId = null;
    this.lieutenantId = null;
    this.navigatorId = null;
    this.isEmergencyNav = false;

    // حالة المطيانة
    this.mutiny = null;
    // حالة الملاحة
    this.nav = null;
    this.lastPlayedCard = null;
    this.lastActivatedCharacter = null;
    // حالة معلقة (map action / card action / ritual)
    this.pending = null;
    // [إصلاح #7] معاينة المراقب (Look-Out) المعلقة: { playerId, card }
    this.lookoutPending = null;
    // [C16] نافذة عابرة بعد التعيين وقبل أول commitGuns — لبطاقات after_appoint
    this.afterAppointWindow = false;
    this.pausedForCharacters = null; // { timing, decisions: { [playerId]: 'pending' | 'skipped' | 'activated' } }
    // تعديلات بطاقات الشخصيات على المطيانة القادمة
    this.nextMutinyMods = this._freshMutinyMods();

    this.startingPlayerCount = 0;
    this.supplyLineCrossed = false;
    // [إصلاح #14] الاحتياطي العام: 40 مسدساً فيزيائياً (قواعد ص2)
    this.generalSupply = C.TOTAL_GUNS;
  }

  _freshMutinyMods() {
    return {
      excluded: new Set(),      // Minstrel: لا يشاركون
      mustReveal: new Set(),    // Agitator: يكشفون مسدساً على الأقل
      equalizer: false,         // عتبة = 1 وحد أقصى 1 لكل لاعب
      smugglerTarget: null,     // يسحب 3 أوراق (للملاحة وليس المطيانة لكن نخزنه هنا للجولة)
      consultantLtPick: null,   // المستشار يعين الـ Lieutenant (يُبث في publicState — C02)
    };
  }

  // ============ إدارة اللاعبين ============

  addPlayer(name, socketId) {
    if (this.phase !== PHASES.LOBBY) throw new Error('اللعبة بدأت بالفعل');
    if (this.players.length >= 11) throw new Error('الغرفة ممتلئة (11 لاعب كحد أقصى)');
    const player = {
      id: crypto.randomUUID(),
      socketId,
      name,
      seat: this.players.length,
      faction: null,
      originalFaction: null,
      alive: true,
      eliminated: null, // 'kraken' | 'overboard'
      guns: 0,
      offDuty: false,
      examined: false,    // خضع لـ Cabin Search أو Flogging → غير قابل للتحويل
      tongueCut: false,
      floggingResult: null, // الفريق الذي ثبت أنه "ليس منه"
      resumes: [],          // أوراق الملاحة المكشوفة أمامه (كقبطان)
      character: null,      // { id, revealed, usedFlags }
      connected: true,
    };
    this.players.push(player);
    this._log(`انضم ${name}`);
    return player;
  }

  get alivePlayers() { return this.players.filter(p => p.alive); }
  player(id) { return this.players.find(p => p.id === id); }

  _log(msg, secret = false) {
    this.log.push({ t: Date.now(), msg, secret });
  }

  // ============ بدء اللعبة ============

  start() {
    const n = this.players.length;
    // R-MIN5: 5 لاعبين كحد أدنى، 11 كحد أقصى (قواعد ص4/ص6 — خريطة Long موحّدة)
    if (n < 5 || n > 11) throw new Error('اللعبة تتطلب 5-11 لاعباً (الحد الأدنى 5)');
    this.readyPlayers.clear();
    this.startingPlayerCount = n;

    this._distributeFactions(n);
    this._dealCharacters();
    this._buildDecks();

    for (const p of this.players) p.guns = C.STARTING_GUNS;
    this.generalSupply -= n * C.STARTING_GUNS; // [إصلاح #14]

    this.phase = PHASES.GATHERING;
    this._log('بدأت اللعبة - التجمع السري للقراصنة');
  }

  _distributeFactions(n) {
    let bag = [];
    const comp = C.TEAM_COMPOSITIONS[n];
    if (comp.special5) {
      // قاعدة الـ 5 لاعبين: 3 بحارة + 2 قراصنة → إزالة واحد عشوائياً → إضافة قائد الطائفة
      let pool = [C.FACTIONS.SAILOR, C.FACTIONS.SAILOR, C.FACTIONS.SAILOR, C.FACTIONS.PIRATE, C.FACTIONS.PIRATE];
      pool = shuffle(pool);
      pool.pop(); // إزالة كيس عشوائي دون كشفه
      pool.push(C.FACTIONS.CULT_LEADER);
      bag = shuffle(pool);
    } else {
      for (let i = 0; i < comp.sailor; i++) bag.push(C.FACTIONS.SAILOR);
      for (let i = 0; i < comp.pirate; i++) bag.push(C.FACTIONS.PIRATE);
      for (let i = 0; i < comp.cult_leader; i++) bag.push(C.FACTIONS.CULT_LEADER);
      for (let i = 0; i < comp.cultist; i++) bag.push(C.FACTIONS.CULTIST);
      bag = shuffle(bag);
    }
    this.players.forEach((p, i) => {
      p.faction = bag[i];
      p.originalFaction = bag[i];
    });
  }

  _dealCharacters() {
    // ننحي بطاقة القبطان، نخلط البقية، نأخذ (عدد اللاعبين - 1)، نضيف القبطان ونخلط
    const others = shuffle(CHARACTERS.filter(c => c.id !== 'captain').map(c => c.id));
    const dealt = others.slice(0, this.players.length - 1);
    dealt.push('captain');
    const final = shuffle(dealt);
    const remaining = others.slice(this.players.length - 1);

    this.players.forEach((p, i) => {
      p.character = { id: final[i], revealed: false, gunsmithActive: false };
    });

    // من معه بطاقة القبطان يكشفها فوراً ويصبح القبطان الأول + يأخذ بطاقة بديلة
    const firstCaptain = this.players.find(p => p.character.id === 'captain');
    this.captainId = firstCaptain.id;
    const replacement = remaining[0];
    firstCaptain.character = { id: replacement, revealed: false, gunsmithActive: false };
    this._log(`${firstCaptain.name} هو القبطان الأول`);
  }

  _buildDecks() {
    // [توحيد الخرائط] مجموعة Long Journey الـ 23 ورقة لكل الألعاب (قواعد ص6)
    this.drawPile = shuffle(C.buildLongJourneyDeck());
    this.cultRitualDeck = shuffle(C.buildCultRitualDeck());
  }

  // التجمع السري: رقمياً، القراصنة يشوفون بعض في التطبيق مباشرة
  getPirateGatheringInfo(playerId) {
    const p = this.player(playerId);
    if (!p || p.faction !== C.FACTIONS.PIRATE) return null;
    return this.players
      .filter(q => q.faction === C.FACTIONS.PIRATE)
      .map(q => ({ id: q.id, name: q.name }));
  }

  finishGathering() {
    // [إصلاح #17] تثبيت قائمة "القراصنة المعروفين" لحظة التجمع السري -
    // ذاكرة اللاعبين لا تتأثر بتعديلات لاحقة (تحويل/تدخل راوٍ)
    const cohort = this.players
      .filter(q => q.originalFaction === C.FACTIONS.PIRATE)
      .map(q => ({ id: q.id, name: q.name }));
    for (const p of this.players) {
      if (p.originalFaction === C.FACTIONS.PIRATE) p.pirateCohort = cohort;
    }
    this.readyPlayers.clear();
    this.phase = PHASES.APPOINT;
    this._log('انتهى التجمع - تبدأ الرحلة!');
    this._checkPauseForCharacters('before_appoint');
  }

  toggleReady(playerId) {
    const p = this.player(playerId);
    if (!p) throw new Error('لاعب غير صالح');
    
    if (this.phase !== PHASES.LOBBY && this.phase !== PHASES.GATHERING) {
      throw new Error('تأكيد الجاهزية غير متاح في هذه المرحلة');
    }

    if (this.phase === PHASES.LOBBY) {
      if (this.readyPlayers.has(playerId)) {
        this.readyPlayers.delete(playerId);
        this._log(`${p.name} غير جاهز`);
      } else {
        this.readyPlayers.add(playerId);
        this._log(`${p.name} جاهز لبدء اللعبة`);
        
        // Auto start if all players are ready (minimum 5) and there is no narrator
        if (!this.narratorId && this.players.length >= 5 && this.readyPlayers.size === this.players.length) {
          this.readyPlayers.clear();
          this.start();
        }
      }
    } else if (this.phase === PHASES.GATHERING) {
      if (this.readyPlayers.has(playerId)) {
        this.readyPlayers.delete(playerId);
        this._log(`${p.name} غير جاهز لبدء الرحلة`);
      } else {
        this.readyPlayers.add(playerId);
        this._log(`${p.name} جاهز لبدء الرحلة`);
        
        // Auto finish gathering if all players are ready and there is no narrator
        if (!this.narratorId && this.readyPlayers.size === this.players.length) {
          this.readyPlayers.clear();
          this.finishGathering();
        }
      }
    }
  }

  // ============ المرحلة 1: تعيين فريق الملاحة ============

  appointTeam(captainId, ltId, navId) {
    this._assertPhase(PHASES.APPOINT);
    if (this.pausedForCharacters) throw new Error('بانتظار قرارات الشخصيات');
    if (captainId !== this.captainId) throw new Error('فقط القبطان يعيّن الفريق');
    // R64: إذا قلّ عدد اللاعبين المؤهلين عن اثنين، تُملأ المراكز الشاغرة عشوائياً
    // (قواعد صX: دون 3 لاعبين على السفينة، القبطان يسحب ورقتين ويُبقي واحدة عشوائياً)
    const eligible = this.players.filter(p =>
      p.alive &&
      p.id !== this.captainId &&
      !p.offDuty // علامات Off-duty تُتجاهل عند قلة العدد (R31)
    );
    if (eligible.length < 2) {
      this._log('R64: أقل من لاعبَين مؤهلين — ملء عشوائي للمراكز الشاغرة');
      this.lieutenantId = null;
      this.navigatorId = null;
      this.isEmergencyNav = false;
      this.fillPositionsRandomlyPending = true;
      this.triggerStartNavigation();
      return;
    }
    const lt = this.player(ltId), nav = this.player(navId);
    if (!lt || !nav || !lt.alive || !nav.alive) throw new Error('لاعب غير صالح');
    if (ltId === navId) throw new Error('لا يمكن أن يكون نفس الشخص Lieutenant و Navigator');
    if (ltId === this.captainId || navId === this.captainId) throw new Error('القبطان لا يعيّن نفسه');
    // استثناء: علامات Off-duty تُتجاهل إذا لم يتبق لاعبون كافون
    const availableCount = this.alivePlayers.filter(p => !p.offDuty && p.id !== this.captainId).length;
    const ignoreOffDuty = availableCount < 2;
    if (!ignoreOffDuty) {
      if (lt.offDuty || nav.offDuty) throw new Error('لاعب Off-Duty لا يمكن تعيينه');
    }
    // المستشار (Consultant): إذا فُعّلت، الـ Lieutenant محدد مسبقاً
    // [إصلاح #10] إعادة التحقق من صلاحية الاختيار وقت التعيين (قد تتغير الحالة بعد التفعيل)
    if (this.nextMutinyMods.consultantLtPick) {
      const pin = this.player(this.nextMutinyMods.consultantLtPick);
      const pinValid = pin && pin.alive && (!pin.offDuty || ignoreOffDuty) && pin.id !== this.captainId;
      if (!pinValid) {
        this.nextMutinyMods.consultantLtPick = null;
        this._log('اختيار المستشار لم يعد صالحاً - يُتجاهل');
      }
    }
    if (this.nextMutinyMods.consultantLtPick && ltId !== this.nextMutinyMods.consultantLtPick) {
      throw new Error('المستشار عيّن الـ Lieutenant بالفعل');
    }

    this.lieutenantId = ltId;
    this.navigatorId = navId;
    this.isEmergencyNav = false;
    this._log(`القبطان عيّن ${lt.name} (Lieutenant) و ${nav.name} (Navigator)`);
    // [C16] افتح نافذة after_appoint العابرة حتى أول commitGuns
    this.afterAppointWindow = true;

    // المرحلة 2: سؤال الولاء
    this.phase = PHASES.LOYALTY_COMMIT;
    this.mutiny = {
      commitments: new Map(), // playerId -> عدد المسدسات (سري)
      revealed: false,
      startedAt: Date.now(),
      doubledTarget: null,    // Troublemaker
      peacemakerTarget: null, // Peacemaker
      halved: false,          // Rabble-rouser
      strategists: new Set(), // Master Strategist المفعّلون
      tieQueue: null,
      tieChooser: null,       // من له حق إسقاط المتعادل التالي
    };

    this._checkPauseForCharacters('after_appoint');
  }

  // ============ المرحلة 2: سؤال الولاء / المطيانة ============

  commitGuns(playerId, count) {
    this._assertPhase(PHASES.LOYALTY_COMMIT);
    if (this.pausedForCharacters) throw new Error('بانتظار قرارات الشخصيات');
    const elapsed = Date.now() - (this.mutiny?.startedAt || 0);
    if (elapsed < MUTINY_COMMIT_DELAY_MS) {
      throw new Error('الرجاء الانتظار 7 ثوانٍ لإتاحة الفرصة لاستخدام قدرات الشخصيات.');
    }
    const p = this.player(playerId);
    if (!p || !p.alive) throw new Error('لاعب غير صالح');
    if (playerId === this.captainId) throw new Error('القبطان لا يشارك في المطيانة');
    if (this.nextMutinyMods.excluded.has(playerId) && count > 0)
      throw new Error('المنشد استبعدك من هذه المطيانة');
    if (this.nextMutinyMods.mustReveal.has(playerId) && count < 1 && p.guns > 0)
      throw new Error('المحرّض يلزمك بكشف مسدس واحد على الأقل');
    if (this.nextMutinyMods.equalizer && count > 1)
      throw new Error('المُعادِل: مسدس واحد كحد أقصى');
    if (count < 0 || count > p.guns) throw new Error('عدد مسدسات غير صالح');
    this.mutiny.commitments.set(playerId, count);
    // [C16] أول قرار يُغلق نافذة after_appont
    this.afterAppointWindow = false;
  }

  get allCommitted() {
    const eligible = this.alivePlayers.filter(p => p.id !== this.captainId);
    return eligible.every(p => this.mutiny.commitments.has(p.id));
  }

  revealMutiny() {
    this._assertPhase(PHASES.LOYALTY_COMMIT);
    if (!this.allCommitted) throw new Error('لم يقرر الجميع بعد');
    this.mutiny.revealed = true;
    this.mutiny.revealedAt = Date.now();
    // نافذة "فوراً بعد كشف المسدسات": بطاقات after_reveal تُفعَّل الآن،
    // ثم القبطان (أو الراوي) يستدعي resolveMutinyOutcome لحساب النتيجة.
    this.phase = PHASES.POST_REVEAL;
    this._log('كُشفت المسدسات - نافذة بطاقات الشخصيات مفتوحة');
    this._checkPauseForCharacters('after_reveal');
    return { revealed: true };
  }

  resolveMutinyOutcome() {
    this._assertPhase(PHASES.POST_REVEAL);
    if (this.pausedForCharacters) throw new Error('بانتظار قرارات الشخصيات');
    this._assertNoLookoutPending(); // [إصلاح #7] قد يبدأ هذا المسار ملاحة (سحب أوراق)
    if (this.pendingInstigator) throw new Error("بانتظار قرار المستفز");

    const elapsed = Date.now() - (this.mutiny?.revealedAt || 0);
    if (elapsed < RESOLVE_DELAY_MS) {
      throw new Error(`حسم التمرد غير متاح قبل مرور 15 ثانية (تبقت ${Math.ceil((RESOLVE_DELAY_MS - elapsed) / 1000)} ثانية)`);
    }

    let total = 0;
    for (const [pid, n] of this.mutiny.commitments) {
      let v = n;
      if (this.mutiny.doubledTarget === pid) v *= 2;       // Troublemaker
      if (this.mutiny.peacemakerTarget === pid) v = 0;     // Peacemaker
      total += v;
    }

    let threshold = C.mutinyThreshold(this.startingPlayerCount);
    if (this.mutiny.halved) threshold = Math.ceil(threshold / 2); // Rabble-rouser
    if (this.nextMutinyMods.equalizer) threshold = 1;             // Equalizer

    this._log(`مطيانة: ${total} مسدس مكشوف (المطلوب ${threshold})`);

    if (total >= threshold) {
      return this._resolveSuccessfulMutiny();
    } else {
      // فشلت: الكل يسترجع مسدساته، ننتقل للملاحة
      this._log('فشلت المطيانة - تستمر الملاحة');
      this.mutiny = null;
      this.triggerStartNavigation();
      return { success: false };
    }
  }

  _resolveSuccessfulMutiny() {
    // الفائز = من كشف أكثر مسدسات (الـ Peacemaker target لا يُحتسب)
    // [إصلاح #3] مقطوع اللسان لا يصبح قبطاناً: عدّه = 0 عند تحديد القبطان (قواعد ص13)
    // [إصلاح #5] مضاعفة Troublemaker تنطبق على تحديد الفائز أيضاً ("للمطيانة الحالية" كلها)
    const counts = [];
    for (const [pid, n] of this.mutiny.commitments) {
      if (this.mutiny.peacemakerTarget === pid) continue;
      if (this.player(pid)?.tongueCut) continue;
      let v = n;
      if (this.mutiny.doubledTarget === pid) v = n * 2;
      if (v > 0) counts.push({ pid, n: v });
    }
    // حالة حدية: كل الكاشفين مقطوعو اللسان → لا فائز مؤهل، القبطان الحالي يبقى
    if (counts.length === 0) {
      this._log('لا فائز مؤهل (الكاشفون مقطوعو اللسان) - القبطان يبقى في منصبه');
      this._finishMutiny(this.captainId);
      return { success: true, newCaptain: this.captainId };
    }
    const max = Math.max(...counts.map(c => c.n));
    const tied = counts.filter(c => c.n === max).map(c => c.pid);

    if (tied.length === 1) {
      this._finishMutiny(tied[0]);
      return { success: true, newCaptain: tied[0] };
    }
    // تعادل: القبطان الحالي يُسقط أول لاعب، ثم المُسقَط يختار التالي (قواعد ص10)
    this.phase = PHASES.MUTINY_TIE;
    this.mutiny.tieQueue = tied;
    this.mutiny.tieChooser = this.captainId; // [إصلاح #2] تتبع من له حق الإسقاط
    this._log(`تعادل بين ${tied.length} لاعبين - القبطان يحسم`);
    return { success: true, tie: tied };
  }

  // القبطان (ثم المُسقَط الأخير) يختار من يخفض يده
  resolveTieDrop(chooserId, dropId) {
    this._assertPhase(PHASES.MUTINY_TIE);
    // [إصلاح #2] فرض دورة الاختيار: القبطان أولاً، ثم كل مُسقَط يختار التالي
    if (chooserId !== this.mutiny.tieChooser)
      throw new Error('ليس دورك في الاختيار');
    const q = this.mutiny.tieQueue;
    if (!q.includes(dropId)) throw new Error('هذا اللاعب ليس في التعادل');
    this.mutiny.tieQueue = q.filter(id => id !== dropId);
    this.mutiny.tieChooser = dropId; // المُسقَط يختار التالي
    if (this.mutiny.tieQueue.length === 1) {
      this._finishMutiny(this.mutiny.tieQueue[0]);
      return { newCaptain: this.captainId };
    }
    return { remaining: this.mutiny.tieQueue };
  }

  _finishMutiny(newCaptainId) {
    // كل المشاركين في مطيانة ناجحة يُسقطون مسدساتهم المكشوفة
    for (const [pid, n] of this.mutiny.commitments) {
      const p = this.player(pid);
      let lost = n;
      if (this.mutiny.peacemakerTarget === pid) lost = 0;          // تُعاد لمخزونه
      if (this.mutiny.strategists.has(pid) && pid !== newCaptainId) lost = 0; // الاستراتيجي يسترجعها
      p.guns -= lost;
      this.generalSupply += lost; // [إصلاح #14] المسدسات المرمية تعود للاحتياطي
      // صانع الأسلحة: يسترجع مسدساً واحداً بعد مطيانة ناجحة شارك فيها
      if (p.character?.gunsmithActive && n > 0 && lost > 0) {
        p.guns += 1;
        this.generalSupply -= 1; // [إصلاح #14] (مضمون ≥1 لأن lost ≥ 1)
      }
    }
    const nc = this.player(newCaptainId);
    this.captainId = newCaptainId;
    this.lieutenantId = null;
    this.navigatorId = null;
    this._log(`نجحت المطيانة! ${nc.name} هو القبطان الجديد`);
    // ملاحظة: علامات Off-duty لا تُمرر بعد مطيانة، والجولة تبدأ من جديد
    this.mutiny = null;
    // [smuggler] حفظ smugglerTarget عبر إعادة تعيين nextMutinyMods — التأثير ينتظر الملاحة حتى بعد مطيانة ناجحة
    const _smug = this.nextMutinyMods.smugglerTarget;
    this.nextMutinyMods = this._freshMutinyMods();
    this.nextMutinyMods.smugglerTarget = _smug;
    this.phase = PHASES.APPOINT;
    this._checkPauseForCharacters('before_appoint');
  }

  // ============ المرحلة 3: الملاحة ============

  // [إصلاح #7] لا تعديل على كومة السحب وثمة معاينة Look-Out معلقة
  _assertNoLookoutPending() {
    if (this.lookoutPending) {
      const w = this.player(this.lookoutPending.playerId);
      throw new Error(`المراقب (${w?.name || '؟'}) يجب أن يحسم قراره أولاً`);
    }
  }

  _startNavigation() {
    // إعادة الخلط إذا قلّت الأوراق عن 4 قبل الملاحة
    if (this.drawPile.length < C.RESHUFFLE_THRESHOLD) {
      this.drawPile = shuffle([...this.drawPile, ...this.discardPile]);
      this.discardPile = [];
      this._log('أُعيد خلط الأوراق (Deep Sea + Draw Pile)');
    }

    const smug = this.nextMutinyMods.smugglerTarget;
    const draw = (n) => this.drawPile.splice(0, n);

    const capCount = (smug === this.captainId) ? 3 : 2;
    // R64: حماية بحث الـ Lieutenant ضد null (ملء عشوائي عند قلة اللاعبين)
    const ltCount = this.lieutenantId ? ((smug === this.lieutenantId) ? 3 : 2) : 0;

    // [إصلاح #13] سحب أوراق القبطان والـ Lieutenant معاً مقدماً (قواعد ص10:
    // "القبطان يسحب أعلى ورقتين... الـ Lieutenant يسحب الورقتين التاليتين") -
    // يمنع تسرب ورقة القبطان المرمية إلى يد الـ Lieutenant عبر إعادة خلط طارئة
    if (this.drawPile.length < capCount + ltCount) this._emergencyReshuffle();
    this.nav = {
      captainCards: draw(capCount),
      ltCards: draw(ltCount),
      ltCount,
      logbook: [],
      played: null,
      archivistUsedBy: new Set(),
      ltFilledRandomly: false, // R64: علامة ملء الـ Lieutenant عشوائياً
      navFilledRandomly: false, // R64: علامة ملء الـ Navigator عشوائياً
    };
    this.phase = PHASES.NAV_CAPTAIN;
    this._checkPauseForCharacters('before_draw'); // Check for Archivist in NAV_CAPTAIN
  }

  // R64: ملء المراكز الشاغرة عشوائياً عند قلة اللاعبين (دون 3 على السفينة)
  // القبطان يسحب ورقتين لكل مركز شاغر، يخلطهما، يُبقي واحدة في الـ Logbook ويرمي الأخرى
  _fillPositionsRandomly() {
    const captain = this.players.find(p => p.id === this.captainId);

    // ورقة القبطان: إبقاء واحدة عشوائياً في الـ Logbook (القبطان حاضر لكن لا فريق)
    if (this.nav.captainCards.length > 0) {
      const capCards = shuffle(this.nav.captainCards);
      this.nav.logbook.push(capCards[0]);
      this.discardPile.push(...capCards.slice(1));
      this.nav.captainCards = [];
    }

    // ملء الـ Lieutenant عشوائياً إن كان شاغراً
    if (!this.lieutenantId && !this.nav.ltFilledRandomly) {
      this._log('R64: ملء الـ Lieutenant عشوائياً (قلة لاعبين)');
      const [keep, discard] = this._drawTwoAndPick();
      this.nav.logbook.push(keep);
      this.discardPile.push(discard);
      this.lieutenantId = null; // لا Lieutenant بشري
      this.nav.ltFilledRandomly = true;
    }

    // ملء الـ Navigator عشوائياً إن كان شاغراً
    if (!this.navigatorId && !this.nav.navFilledRandomly) {
      this._log('R64: ملء الـ Navigator عشوائياً (قلة لاعبين)');
      const [keep, discard] = this._drawTwoAndPick();
      this.nav.logbook.push(keep);
      this.discardPile.push(discard);
      this.navigatorId = null; // لا Navigator بشري
      this.nav.navFilledRandomly = true;
    }

    // خلط الـ Logbook واختيار ورقة عشوائية للعب (دور الـ Navigator العشوائي)
    this.nav.logbook = shuffle(this.nav.logbook);
    const played = this.nav.logbook[0];
    this.discardPile.push(...this.nav.logbook.slice(1));
    this.nav.played = played;
    this._executeNavigationCard(played);
  }

  // R64: سحب ورقتين، خلطهما، إرجاع [المُبقاة، المرمية]
  _drawTwoAndPick() {
    if (this.drawPile.length < 2) this._emergencyReshuffle();
    const cards = [this.drawPile.pop(), this.drawPile.pop()];
    shuffle(cards);
    return [cards[0], cards[1]]; // المُبقاة، المرمية
  }

  // الأرشيفي: القبطان/Lieutenant المختار يرمي أوراقه ويسحب ورقتين جديدتين
  // [غموض موثق 5.6.6] نص البطاقة "قبل سحب أوراق الملاحة" لكن التأثير يفترض أوراقاً
  // مسحوبة؛ التفسير الوحيد ذو المعنى = أثناء مرحلتي NAV_CAPTAIN/NAV_LIEUTENANT (كما هنا)
  archivistRedraw(targetId) {
    this._assertNoLookoutPending();
    const isCap = targetId === this.captainId;
    const isLt = targetId === this.lieutenantId;
    if (!isCap && !isLt) throw new Error('غير متاح في هذه المرحلة');
    if (this.drawPile.length < 2) this._emergencyReshuffle(); // [C03] Trigger reshuffle if < 2
    if (isCap) {
      this.discardPile.push(...this.nav.captainCards);
      this.nav.captainCards = this.drawPile.splice(0, 2);
    } else {
      this.discardPile.push(...this.nav.ltCards);
      this.nav.ltCards = this.drawPile.splice(0, 2);
    }
  }

  _emergencyReshuffle() {
    // حالة نادرة: نفدت الأوراق أثناء الملاحة (Archivist/Smuggler/Look-Out)
    this.drawPile = shuffle(this.discardPile);
    this.discardPile = [];
    this._log('إعادة خلط طارئة أثناء الملاحة');
  }

  captainChoose(playerId, keepIndices) {
    this._assertPhase(PHASES.NAV_CAPTAIN);
    if (this.pausedForCharacters) throw new Error('بانتظار قرارات الشخصيات');
    if (playerId !== this.captainId) throw new Error('ليس دورك');
    this._chooseKeepOne(this.nav.captainCards, keepIndices);
    // [إصلاح #13] أوراق الـ Lieutenant مسحوبة مقدماً في _startNavigation
    this.phase = PHASES.NAV_LIEUTENANT;
    this._checkPauseForCharacters('before_draw'); // Check for Archivist in NAV_LIEUTENANT
  }

  lieutenantChoose(playerId, keepIndices) {
    this._assertPhase(PHASES.NAV_LIEUTENANT);
    if (this.pausedForCharacters) throw new Error('بانتظار قرارات الشخصيات');
    if (playerId !== this.lieutenantId) throw new Error('ليس دورك');
    this._chooseKeepOne(this.nav.ltCards, keepIndices);
    // الـ Logbook يُخلط (رقمياً: ترتيب عشوائي)
    this.nav.logbook = shuffle(this.nav.logbook);
    this.phase = PHASES.NAV_NAVIGATOR;
  }

  _chooseKeepOne(cards, keepIndex) {
    if (keepIndex < 0 || keepIndex >= cards.length) throw new Error('اختيار غير صالح');
    const kept = cards[keepIndex];
    cards.forEach((c, i) => { if (i !== keepIndex) this.discardPile.push(c); });
    this.nav.logbook.push(kept);
  }

  navigatorChoose(playerId, keepIndex) {
    this._assertPhase(PHASES.NAV_NAVIGATOR);
    if (playerId !== this.navigatorId) throw new Error('ليس دورك');
    if (keepIndex < 0 || keepIndex > 1) throw new Error('اختيار غير صالح');
    const played = this.nav.logbook[keepIndex];
    const discarded = this.nav.logbook[1 - keepIndex];
    this.discardPile.push(discarded);
    this.nav.played = played;
    return this._executeNavigationCard(played);
  }

  // رفض الأوامر: الـ Navigator يقفز من السفينة
  denyCommand(playerId) {
    this._assertPhase(PHASES.NAV_NAVIGATOR);
    if (playerId !== this.navigatorId) throw new Error('فقط الـ Navigator يرفض الأوامر');
    const nav = this.player(playerId);
    // كلتا الورقتين للـ Deep Sea
    this.discardPile.push(...this.nav.logbook);
    this.nav.logbook = [];
    nav.alive = false;
    nav.eliminated = 'overboard';
    this._log(`${nav.name} رفض الأوامر وقفز من السفينة!`);
    // ملاحظة قانونية: قائد الطائفة لا يفوز بالقفز حتى على مساحة Feed the Kraken
    this.navigatorId = null;
    this.phase = PHASES.APPOINT; // مؤقتاً: القبطان يختار Emergency Navigator
    this.pending = { type: 'emergency_navigator' };
    return { emergencyNeeded: true };
  }

  setEmergencyNavigator(captainId, navId) {
    if (this.pending?.type !== 'emergency_navigator') throw new Error('لا حاجة لملاح طوارئ');
    this._assertNoLookoutPending(); // [إصلاح #7] الملاحة الفورية تسحب أوراقاً
    if (captainId !== this.captainId) throw new Error('فقط القبطان');
    const nav = this.player(navId);
    if (!nav || !nav.alive || navId === this.captainId || navId === this.lieutenantId)
      throw new Error('اختيار غير صالح');
    // يجوز اختيار لاعب Off-duty، ولا مطيانة ضده
    this.navigatorId = navId;
    this.isEmergencyNav = true;
    this.pending = null;
    this._log(`${nav.name} ملاح طوارئ - تُعاد الملاحة فوراً`);
    this.triggerStartNavigation();
  }

  // ============ تنفيذ ورقة الملاحة ============

  // [قاعدة الحركة] طبقة تأكيد واحدة: السهم على الخلية الحالية هو ما يحدد الهدف،
  // والورقة (لونها) تختار أحد الأسهم الثلاثة فقط. كل سهم = خطوة واحدة شمالاً.
  _resolveShipDest(color) {
    const fromHex = this.map[this.shipHex];
    if (!fromHex) throw new Error('السفينة على خلية غير معروفة: ' + this.shipHex);
    const dest = fromHex.exits[color];
    if (!dest) {
      throw new Error(`لا يوجد سهم ${color} من ${this.shipHex} — حركة مستحيلة`);
    }
    // حتى لو كان dest ثابت نصر، يجب أن يكون داخل exits (مصدر الحقيقة الوحيد).
    // وإلا فالتحقق من الخطوة الواحدة شمالاً صراحةً:
    if (!isVictory(dest) && !isValidExit(fromHex, dest, this.map)) {
      throw new Error(`سهم ${color} من ${this.shipHex} → ${dest} يخالف قاعدة الخطوة الواحدة`);
    }
    return { fromHex, dest };
  }

  // أداة الراوي move_ship: الآن يُسمح فقط بنقل السفينة إلى إحدى المخارج
  // (أو ثابت نصر) قد يكون أي هدف في exits الحالية — يبقي قاعدة "اتبع السهم".
  _applyLegalShipMove(targetHexId) {
    if (!targetHexId || typeof targetHexId !== 'string') {
      throw new Error('move_ship يتطلب hexId صالح');
    }
    const fromHex = this.map[this.shipHex];
    if (!fromHex) throw new Error('السفينة على خلية غير معروفة: ' + this.shipHex);
    const exits = Object.values(fromHex.exits);
    if (!exits.includes(targetHexId)) {
      throw new Error(`move_ship: ${targetHexId} ليس مخرجاً من ${this.shipHex} (الأهداف: ${exits.join(', ')})`);
    }
    if (isVictory(targetHexId)) {
      this.shipHex = targetHexId;
      return;
    }
    if (!isValidExit(fromHex, targetHexId, this.map)) {
      throw new Error(`move_ship: ${targetHexId} يخالف قاعدة الخطوة الواحدة`);
    }
    this.shipHex = targetHexId;
  }

  _executeNavigationCard(card) {
    // الورقة المكشوفة تصبح résumé أمام القبطان - لا تعود للمجموعة أبداً
    const captain = this.player(this.captainId);
    captain.resumes.push(card);

    this.lastPlayedCard = {
      color: card.color,
      action: card.action,
      navigatorName: this.player(this.navigatorId)?.name || 'ملاح طوارئ / النظام',
      timestamp: Date.now(),
    };

    // I. تحريك السفينة — قراءة السهم من الخلية الحالية فقط (ليس من لون الورقة)
    const { fromHex, dest } = this._resolveShipDest(card.color);
    this._log(`كُشفت ورقة ${card.color} (${card.action}) — ${fromHex.id} → ${dest}`);

    if (isVictory(dest)) {
      return this._endGame(dest);
    }
    const toHex = this.map[dest];

    // [C01] Immediate Victory on Landing Spaces
    if (toHex.num === 31) return this._endGame(VICTORY.CULT, 'وصلت السفينة إلى الكراكن!');
    if ([22, 26, 29].includes(toHex.num)) return this._endGame(VICTORY.PIRATE, 'وصلت السفينة إلى خليج القراصنة!');
    if ([25, 28, 30].includes(toHex.num)) return this._endGame(VICTORY.SAILOR, 'وصلت السفينة إلى مياه البحارة!');
    // عبور خط الإمداد → كل لاعب يستعيد مسدساته حتى 3
    // [توحيد الخرائط] خط الإمداد موجود دائماً (خريطة Long موحّدة - قواعد ص12)
    if (BEFORE_SUPPLY_LINE.has(fromHex.num) && !BEFORE_SUPPLY_LINE.has(toHex.num) && !this.supplyLineCrossed) {
      this.supplyLineCrossed = true;
      for (const p of this.alivePlayers) {
        if (p.guns < C.SUPPLY_REFILL_TO) {
          // [إصلاح #14] التجديد من الاحتياطي العام، وبقدر المتاح فيه
          const give = Math.min(C.SUPPLY_REFILL_TO - p.guns, this.generalSupply);
          p.guns += give;
          this.generalSupply -= give;
        }
      }
      this._log('عبرت السفينة خط الإمداد - تم تجديد المسدسات حتى 3');
    }
    this.shipHex = dest;

    // II. هل في المساحة الجديدة Map Action لم يُستخدم؟
    if (toHex.action && !this.usedMapActions.has(dest)) {
      this.pending = { type: 'map_action', action: toHex.action, hexId: dest, card };
      this.phase = PHASES.MAP_ACTION;
      return { mapAction: toHex.action };
    }
    // III. مباشرة لتنفيذ Navigation Card Action
    return this._executeCardAction(card);
  }

  // الـ Captain ينفذ الـ Map Action باختيار هدف
  resolveMapAction(captainId, targetId) {
    this._assertPhase(PHASES.MAP_ACTION);
    if (captainId !== this.captainId) throw new Error('فقط القبطان');
    const { action, hexId, card } = this.pending;
    const target = this.player(targetId);
    if (!target || !target.alive) throw new Error('هدف غير صالح');
    if (targetId === this.captainId) throw new Error('القبطان لا يختار نفسه');

    this.usedMapActions.add(hexId);
    let result = {};

    switch (action) {
      case C.MAP_ACTIONS.CABIN_SEARCH: {
        // القبطان يرى faction الهدف سراً، والهدف يصبح غير قابل للتحويل
        target.examined = true;
        result = { secretFor: this.captainId, info: { type: 'cabin_search', target: target.name, faction: target.faction } };
        this._log(`Cabin Search على ${target.name}`);
        break;
      }
      case C.MAP_ACTIONS.FLOGGING: {
        // النتيجة: كشف فريق واحد عشوائي "لا ينتمي إليه" اللاعب من بين الفريقين الآخرين
        target.examined = true;
        const isCult = target.faction === C.FACTIONS.CULT_LEADER || target.faction === C.FACTIONS.CULTIST;
        const all = ['pirate', 'sailor', 'cult'];
        const own = isCult ? 'cult' : target.faction;
        const others = all.filter(f => f !== own);
        const revealedNot = others[crypto.randomInt(2)];
        target.floggingResult = revealedNot; // معلومة عامة دائمة
        result = { public: { type: 'flogging', target: target.name, isNot: revealedNot,
          message: `🪢 الجلد: ${target.name} ليس من فريق ${revealedNot}` } };
        this._log(`Flogging: ${target.name} ليس من فريق ${revealedNot} (معلومة عامة)`);
        break;
      }
      case C.MAP_ACTIONS.OFF_WITH_TONGUE: {
        target.tongueCut = true;
        result = { public: { type: 'tongue', target: target.name,
          message: `🗡️ قُطع لسان ${target.name} — لا كلام ولا قبطانية بعد الآن` } };
        this._log(`قُطع لسان ${target.name} - لا كلام ولا قبطانية بعد الآن`);
        break;
      }
      case C.MAP_ACTIONS.FEED_THE_KRAKEN: {
        target.alive = false;
        target.eliminated = 'kraken';
        this._log(`${target.name} أُلقي للكراكن!`);
        // إذا كان قائد الطائفة → الطائفة تفوز فوراً
        if (target.faction === C.FACTIONS.CULT_LEADER) {
          return this._endGame(VICTORY.CULT, 'قائد الطائفة ضُحّي به للكراكن');
        }
        result = { public: { type: 'kraken', target: target.name,
          message: `🐙 أُلقي ${target.name} للكراكن!` } };
        break;
      }
    }

    this.pending = null;
    const after = this._executeCardAction(card);
    return { ...result, ...after };
  }

  // ============ Navigation Card Actions ============

  skipSpiritualist(playerId) {
    const p = this.player(playerId);
    if (!p || p.character?.id !== 'spiritualist') throw new Error('فقط الروحاني يمتلك هذه الصلاحية');
    if (!this.spiritualistWindowActive) throw new Error('لا توجد نافذة انتظار');
    this.spiritualistWindowActive = false;
    this.pending = null;
    this._log(`${p.name} تخطى استخدام بطاقة الروحاني`);
    return this._finishRound();
  }

  _executeCardAction(card) {
    const tryFinish = () => {
      if (card.color === 'yellow') {
        const sp = this.players.find(p => p.alive && p.character?.id === 'spiritualist' && !p.character.revealed);
        if (sp) {
          this.spiritualistWindowActive = true;
          this.phase = PHASES.CARD_ACTION;
          this.pending = { type: 'card_action', action: 'spiritualist_wait' };
          this._log('بانتظار بطاقة الروحاني...');
          return { cardAction: 'spiritualist_wait' };
        }
      }
      return this._finishRound();
    };

    switch (card.action) {
      case C.NAV_ACTIONS.DRUNK: {
        this._applyDrunk();
        return tryFinish();
      }
      case C.NAV_ACTIONS.ARMED: {
        const nav = this.player(this.navigatorId);
        // [إصلاح #14] من الاحتياطي العام؛ إن نفد فلا مسدس (ندرة فيزيائية)
        if (nav && this.generalSupply >= 1) {
          nav.guns += 1; this.generalSupply -= 1;
          this._log(`${nav.name} (Navigator) حصل على مسدس`);
        }
        return tryFinish();
      }
      case C.NAV_ACTIONS.DISARMED: {
        const nav = this.player(this.navigatorId);
        if (nav && nav.guns > 0) {
          nav.guns -= 1;
          this.generalSupply += 1; // [إصلاح #14]
          this._log(`${nav.name} (Navigator) فقد مسدساً`);
        }
        return tryFinish();
      }
      case C.NAV_ACTIONS.MERMAID: {
        // القبطان يختار لاعباً يرى آخر 3 أوراق في الـ Deep Sea
        this.pending = { type: 'card_action', action: 'mermaid' };
        this.phase = PHASES.CARD_ACTION;
        return { cardAction: 'mermaid' };
      }
      case C.NAV_ACTIONS.TELESCOPE: {
        this.pending = { type: 'card_action', action: 'telescope', stage: 'pick_player' };
        this.phase = PHASES.CARD_ACTION;
        return { cardAction: 'telescope' };
      }
      case C.NAV_ACTIONS.CULT_UPRISING: {
        // الطقس يُنفذ في نهاية الملاحة
        return this._startCultRitual();
      }
      default:
        return tryFinish();
    }
  }

  _applyDrunk() {
    // القبطان يفقد منصبه. الدور ينتقل مع عقارب الساعة لأول لاعب بأقل résumées
    // اللاعب مقطوع اللسان يُتجاهل عند تحديد القبطان عبر Drunk
    // [F11] استبعاد القبطان الحالي من حساب الحد الأدنى للـ résumées (قواعد ص14: "القبطان يفقد منصبه")
    const eligible = this.alivePlayers.filter(p => !p.tongueCut && p.id !== this.captainId);
    const minResumes = Math.min(...eligible.map(p => p.resumes.length));
    const capSeat = this.player(this.captainId).seat;
    const ordered = [...this.players]
      .sort((a, b) => a.seat - b.seat);
    // نبدأ من اللاعب التالي للقبطان مع عقارب الساعة
    const n = ordered.length;
    const startIdx = ordered.findIndex(p => p.seat === capSeat);
    for (let i = 1; i <= n; i++) {
      const cand = ordered[(startIdx + i) % n];
      if (cand.alive && !cand.tongueCut && cand.resumes.length === minResumes) {
        this.captainId = cand.id;
        this._log(`Drunk! ${cand.name} هو القبطان الجديد`);
        return;
      }
    }
    // [إصلاح #12] لا مرشح بالحد الأدنى (مثلاً: القبطان وحده يملكه) →
    // القبطانية "يجب أن تنتقل": أول لاعب حي غير مقطوع اللسان مع عقارب الساعة
    for (let i = 1; i <= n; i++) {
      const cand = ordered[(startIdx + i) % n];
      if (cand.id !== this.captainId && cand.alive && !cand.tongueCut) {
        this.captainId = cand.id;
        this._log(`Drunk! ${cand.name} هو القبطان الجديد (لا مرشح بالحد الأدنى)`);
        return;
      }
    }
    // الجميع ميت/مقطوع اللسان → يبقى القبطان (حالة قصوى)
    this._log('Drunk: لا بديل متاح - القبطان يبقى');
  }

  resolveMermaid(captainId, targetId) {
    if (this.pending?.action !== 'mermaid') throw new Error('غير متاح');
    if (captainId !== this.captainId) throw new Error('فقط القبطان');
    const target = this.player(targetId);
    if (!target || !target.alive) throw new Error('هدف غير صالح');
    // [إصلاح #4] "القبطان يختار لاعباً آخر" (قواعد ص14)
    if (targetId === this.captainId) throw new Error('القبطان لا يختار نفسه');
    // ملاحظة موثقة: إن كان في الـ Deep Sea أقل من 3 أوراق، تُعرض الموجودة فقط (القواعد صامتة)
    const last3 = this.discardPile.slice(-3);
    this.pending = null;
    const after = this._finishRound();
    this._log(`Mermaid: ${target.name} رأى آخر 3 أوراق في الـ Deep Sea`);
    return { secretFor: targetId, info: { type: 'mermaid', cards: shuffle(last3) }, ...after };
  }

  telescopePickPlayer(captainId, targetId) {
    if (this.pending?.action !== 'telescope' || this.pending.stage !== 'pick_player') throw new Error('غير متاح');
    if (captainId !== this.captainId) throw new Error('فقط القبطان');
    const target = this.player(targetId);
    if (!target || !target.alive) throw new Error('هدف غير صالح');
    // [إصلاح #4] "القبطان يختار لاعباً آخر" (قواعد ص14)
    if (targetId === this.captainId) throw new Error('القبطان لا يختار نفسه');
    this._assertNoLookoutPending();
    if (this.drawPile.length === 0) this._emergencyReshuffle();
    this.pending = { type: 'card_action', action: 'telescope', stage: 'decide', targetId };
    return { secretFor: targetId, info: { type: 'telescope', topCard: this.drawPile[0] } };
  }

  telescopeDecide(playerId, discard) {
    if (this.pending?.action !== 'telescope' || this.pending.stage !== 'decide') throw new Error('غير متاح');
    if (playerId !== this.pending.targetId) throw new Error('ليس دورك');
    if (discard) {
      const c = this.drawPile.shift();
      this.discardPile.push(c);
      this._log('Telescope: رُميت الورقة العلوية في الـ Deep Sea');
    } else {
      this._log('Telescope: بقيت الورقة العلوية مكانها');
    }
    this.pending = null;
    return this._finishRound();
  }

  // ============ طقوس الـ Cult ============

  _startCultRitual() {
    const ritual = this.cultRitualDeck.pop();
    if (!ritual) {
      this._log('لا طقوس متبقية');
      return this._finishRound();
    }
    const leader = this.players.find(p => p.faction === C.FACTIONS.CULT_LEADER);
    this._log(`Cult Uprising! كُشف طقس: ${ritual}`);
    // [إصلاح #9] قائد الطائفة خارج اللعبة (غرق/كراكن) → الطقس يُكشف ويُهدر بلا تنفيذ
    // (الميت ملزم بالصمت - قواعد ص12 - فلا يجوز له أداء طقوس)
    if (!leader || !leader.alive) {
      this._log('قائد الطائفة خارج اللعبة - الطقس يُهدر');
      return this._finishRound();
    }
    this.phase = PHASES.CULT_RITUAL;
    this.pending = { type: 'cult_ritual', ritual };

    switch (ritual) {
      case C.CULT_RITUALS.GUNS_STASH:
        // قائد الطائفة يوزع 3 مسدسات سراً على أي لاعبين (بمن فيهم نفسه)
        return { ritual, actorId: leader?.id || null };
      case C.CULT_RITUALS.CULT_CABIN_SEARCH: {
        // قائد الطائفة يعرف سراً فرق فريق الملاحة الحالي
        // [إصلاح #11] الجولة لا تتقدم حتى يؤكد القائد اطلاعه (نافذة الـ30 ثانية - قواعد ص15)
        const team = [this.captainId, this.lieutenantId, this.navigatorId]
          .filter(Boolean)
          .map(id => { const p = this.player(id); return { name: p.name, faction: p.faction }; });
        this.pending = { type: 'cult_ritual', ritual, awaitingAck: true };
        return { ritual, secretFor: leader.id, info: { type: 'cult_cabin_search', team } };
      }
      case C.CULT_RITUALS.CONVERSION:
        // قائد الطائفة يحول لاعباً قابلاً للتحويل
        return { ritual, actorId: leader?.id || null };
    }
  }

  cultDistributeGuns(leaderId, allocations) {
    if (this.pending?.ritual !== C.CULT_RITUALS.GUNS_STASH) throw new Error('غير متاح');
    const leader = this.player(leaderId);
    if (!leader || leader.faction !== C.FACTIONS.CULT_LEADER) throw new Error('فقط قائد الطائفة');
    if (!leader.alive) throw new Error('قائد الطائفة خارج اللعبة'); // [إصلاح #9]
    const total = Object.values(allocations).reduce((a, b) => a + b, 0);
    if (total > 3) throw new Error('3 مسدسات كحد أقصى');
    if (total > this.generalSupply) throw new Error('الاحتياطي العام لا يكفي'); // [إصلاح #14]
    for (const [pid, n] of Object.entries(allocations)) {
      const p = this.player(pid);
      if (p && p.alive) { p.guns += n; this.generalSupply -= n; }
    }
    this._log('وُزّع مخبأ أسلحة الطائفة سراً');
    this.pending = null;
    return this._finishRound();
  }

  cultConvert(leaderId, targetId) {
    if (this.pending?.ritual !== C.CULT_RITUALS.CONVERSION) throw new Error('غير متاح');
    const leader = this.player(leaderId);
    if (!leader || leader.faction !== C.FACTIONS.CULT_LEADER) throw new Error('فقط قائد الطائفة');
    if (!leader.alive) throw new Error('قائد الطائفة خارج اللعبة'); // [إصلاح #9]
    const target = this.player(targetId);
    if (!target || !target.alive) throw new Error('هدف غير صالح');
    if (target.examined) throw new Error('هذا اللاعب غير قابل للتحويل (خضع لفحص)');
    if (target.faction === C.FACTIONS.CULT_LEADER || target.faction === C.FACTIONS.CULTIST)
      throw new Error('بالفعل في الطائفة');
    target.faction = C.FACTIONS.CULTIST;
    target.knownCultLeader = leader.name; // [C02] Persistent Cultist Conversion
    if (!leader.knownCultists) leader.knownCultists = [];
    leader.knownCultists.push({ id: target.id, name: target.name });

    this._log(`تحويل سري: انضم عضو جديد للطائفة`, true);
    this.pending = null;
    const after = this._finishRound();
    return { secretFor: targetId, info: { type: 'converted', leader: leader.name }, ...after };
  }

  // [إصلاح #11] قائد الطائفة يؤكد انتهاءه من الاطلاع على فرق فريق الملاحة
  cultAckCabinSearch(leaderId) {
    if (this.pending?.ritual !== C.CULT_RITUALS.CULT_CABIN_SEARCH) throw new Error('غير متاح');
    const leader = this.player(leaderId);
    if (!leader || leader.faction !== C.FACTIONS.CULT_LEADER) throw new Error('فقط قائد الطائفة');
    this.pending = null;
    this._log('انتهى قائد الطائفة من الاطلاع');
    return this._finishRound();
  }

  // قائد الطائفة يمكنه تخطي التحويل (لا يوجد هدف مناسب)
  cultSkipRitual(leaderId) {
    if (this.pending?.type !== 'cult_ritual') throw new Error('غير متاح');
    this.pending = null;
    this._log('تخطّى قائد الطائفة الطقس');
    return this._finishRound();
  }

  // ============ المرحلة 4: Off-Duty ونهاية الجولة ============

  _finishRound() {
    if (this.phase === PHASES.GAME_OVER) return { gameOver: true };

    // توزيع علامات Off-Duty حسب عدد اللاعبين عند بدء اللعبة
    const roles = C.offDutyRoles(this.startingPlayerCount);
    for (const p of this.players) p.offDuty = false; // السابقون يعودون متاحين
    const roleMap = { captain: this.captainId, lieutenant: this.lieutenantId, navigator: this.navigatorId };
    for (const r of roles) {
      const p = this.player(roleMap[r]);
      if (p && p.alive) p.offDuty = true;
    }

    // إعادة تعيين الأدوار وتعديلات الجولة
    this.lieutenantId = null;
    this.navigatorId = null;
    this.nav = null;
    this.archivistOffer = null;
    this.nextMutinyMods = this._freshMutinyMods();
    // [C16] ضمان إغلاق النافذة في نهاية الجولة (لأمان الحالة)
    this.afterAppointWindow = false;
    this.phase = PHASES.APPOINT;
    this._log('انتهت الجولة - القبطان يعيّن فريقاً جديداً');
    this._checkPauseForCharacters('before_appoint');
    return { roundComplete: true };
  }

  _endGame(victory, reason = null) {
    this.phase = PHASES.GAME_OVER;
    this.winner = victory;
    this.winReason = reason || `وصلت السفينة إلى ${victory}`;
    this._log(`🏁 انتهت اللعبة: ${this.winReason}`);
    return { gameOver: true, winner: victory, factions: this.players.map(p => ({ name: p.name, faction: p.faction })) };
  }

  // ============ تفعيل بطاقات الشخصيات ============

  activateCharacter(playerId, payload = {}) {
    const p = this.player(playerId);
    if (!p || !p.alive) throw new Error('لاعب غير صالح');
    const ch = p.character;
    if (!ch || ch.revealed) throw new Error('البطاقة مكشوفة بالفعل');
    const def = CHARACTER_BY_ID[ch.id];
    const setLastActivated = (infoText = '') => {
      this.lastActivatedCharacter = {
        playerId: playerId,
        playerName: p.name,
        characterId: ch.id,
        characterNameAr: def.nameAr,
        targetText: infoText,
        timestamp: Date.now()
      };
    };

    // فحوصات التوقيت الأساسية (الراوي يستطيع التجاوز عبر override)
    const t = def.timing;
    const inAppoint = this.phase === PHASES.APPOINT;
    const inLoyalty = this.phase === PHASES.LOYALTY_COMMIT;
    // [C05] نافذة after_reveal تقتصر على POST_REVEAL فقط — لا تتسرب إلى MUTINY_TIE
    const afterReveal = this.phase === PHASES.POST_REVEAL;
    const beforeDraw = inLoyalty || inAppoint; // قبل سحب الأوراق فعلياً
    // [C09] النافذة الصفراء تقتصر على الورقة الصفراء المشغولة فقط — لا تمتد لطقس الطائفة المعلّق
    const yellowTurn = this.nav?.played?.color === 'yellow';

    const ok =
      (t === 'anytime') ||
      (t === 'before_appoint' && inAppoint && !this.lieutenantId) ||
      // [C16] after_appoint تُقيّد بالعلم العابر afterAppointWindow — يُضبط عند التعيين ويُلغى عند أول commitGuns
      //       (يُزيل الفرع الميت C13: inAppoint && this.lieutenantId غير قابل للتحقق لأن appointTeam يقلب المرحلة تزامنياً)
      (t === 'after_appoint' && !!this.afterAppointWindow) ||
      (t === 'before_draw' && (beforeDraw || (def.id === 'archivist' && (this.phase === PHASES.NAV_CAPTAIN || this.phase === PHASES.NAV_LIEUTENANT)))) ||
      (t === 'after_reveal' && afterReveal) ||
      (t === 'yellow_turn' && yellowTurn);
    if (!ok && !payload.narratorOverride) throw new Error(`توقيت غير صالح لبطاقة ${def.nameAr}`);

    // [C11] Validation-only preamble: لا تُغيّر أي حالة هنا قبل التحقق من النجاح.
    // costGun يُتحقق فقط من الكفاية؛ الدفع الفعلي يتم داخل الحالة gunsmith عند النجاح.
    if (def.costGun && p.guns < 1) throw new Error('تحتاج مسدساً لتفعيل هذه البطاقة');

    // انتقال الترتيب إلى: Validate → Execute → Reveal → Log (لكل حالة على حدة).
    switch (ch.id) {
      case 'kleptomaniac': {
        const t2 = this.player(payload.targetId);
        if (!t2 || !t2.alive || t2.eliminated) throw new Error('هدف غير صالح');
        // لا يمكن سرقة النفس — "اختر لاعباً" يعني لاعباً آخر
        if (t2.id === playerId) throw new Error('لا يمكن سرقة النفس');
        // [C03] القاعدة (Character_Cards.md:9 — "Steal one gun"): الهدف يجب أن يملك ≥1 مسدس.
        // لا يُسمح بالاستهلاك الصامت للبطاقة دون سرقة فعلية.
        if (t2.guns < 1) throw new Error('الهدف لا يملك مسدسات');
        t2.guns -= 1; p.guns += 1;
        ch.revealed = true;
        setLastActivated(`اللاعب المستهدف: ${t2.name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        return {};
      }
      case 'gunslinger': {
        // [إصلاح #14] "خذ مسدسين من الاحتياطي العام" - يفشل إن لم يكف الاحتياطي
        const gunsToTake = Math.min(2, this.generalSupply);
        if (gunsToTake < 1) throw new Error('لا مسدسات كافية في الاحتياطي العام');
        p.guns += gunsToTake; this.generalSupply -= gunsToTake;
        ch.revealed = true;
        setLastActivated(`تأثير القدرة: سحب مسدسين من الاحتياطي العام`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        return {};
      }
      case 'gunsmith': {
        // [C11] الدفع والكشف في كتلة ذرية واحدة عند النجاح (costGun الوحيد).
        p.guns -= 1; this.generalSupply += 1; // [إصلاح #14]
        ch.gunsmithActive = true;
        ch.revealed = true;
        setLastActivated(`تأثير القدرة: تجهيز وتذخير مسدس إضافي`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        return {};
      }
      case 'troublemaker': {
        if (!this.mutiny) throw new Error('لا مطيانة جارية');
        this.mutiny.doubledTarget = payload.targetId;
        ch.revealed = true;
        setLastActivated(`اللاعب المستهدف: ${this.player(payload.targetId).name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return {};
      }
      case 'peacemaker': {
        if (!this.mutiny) throw new Error('لا مطيانة جارية');
        this.mutiny.peacemakerTarget = payload.targetId;
        ch.revealed = true;
        setLastActivated(`اللاعب المستهدف: ${this.player(payload.targetId).name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return {};
      }
      case 'rabble_rouser': {
        if (!this.mutiny) throw new Error('لا مطيانة جارية');
        this.mutiny.halved = true;
        ch.revealed = true;
        setLastActivated('تأثير القدرة: تقليل متطلبات نجاح التمرد للنصف');
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return {};
      }
      case 'master_strategist': {
        if (!this.mutiny) throw new Error('لا مطيانة جارية');
        this.mutiny.strategists.add(playerId);
        ch.revealed = true;
        setLastActivated('تأثير القدرة: تأمين نجاح التمرد بمسدس إضافي');
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return {};
      }
      case 'minstrel': {
        const [a, b] = payload.targetIds || [];
        if (!a || !b) throw new Error('اختر لاعبَين');
        if (a === b) throw new Error('اختر لاعبَين مختلفين'); // [C07/C11] لا حاجة لفرد الكشف بعد الآن
        if (a === this.captainId || b === this.captainId) throw new Error('لا يمكن استبعاد القبطان');
        this.nextMutinyMods.excluded.add(a);
        this.nextMutinyMods.excluded.add(b);
        // [إصلاح #6] استبعاد المنشد يلغي إلزام المحرّض على نفس الهدف (قواعد ص16:
        // "اختيار لاعبي المنشد بلا تأثير") - يمنع تناقضاً يجعل الالتزام مستحيلاً
        this.nextMutinyMods.mustReveal.delete(a);
        this.nextMutinyMods.mustReveal.delete(b);
        ch.revealed = true;
        setLastActivated(`اللاعبين المستهدفين: ${this.player(a).name} و ${this.player(b).name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return {};
      }
      case 'agitator': {
        const [a, b] = payload.targetIds || [];
        if (!a || !b) throw new Error('اختر لاعبَين');
        if (a === b) throw new Error('اختر لاعبَين مختلفين'); // [C07/C11]
        // [إصلاح #6] اختيار القبطان أو مستبعدي المنشد بلا تأثير (لا يشاركون في المطيانة)
        const boundIds = [], skipped = [];
        for (const id of [a, b]) {
          if (id !== this.captainId && !this.nextMutinyMods.excluded.has(id)) {
            this.nextMutinyMods.mustReveal.add(id);
            boundIds.push(id);
          } else {
            const reason = (id === this.captainId) ? 'captain' : 'excluded';
            skipped.push({ id, reason });
          }
        }
        const parts = [];
        if (boundIds.length) parts.push(`مُلتزمون: ${boundIds.map(i=>this.player(i).name).join('، ')}`);
        if (skipped.length) {
          const sk = skipped.map(s => `${this.player(s.id).name} (${s.reason === 'captain' ? 'القبطان' : 'مستبعدٌ من المنشد'})`).join('، ');
          parts.push(`بلا تأثير: ${sk}`);
        }
        const summary = `المحرّض: ${parts.join(' — ') || 'لم يُلتزم أحد'}`;
        ch.revealed = true;
        setLastActivated(`اللاعبين المستهدفين: ${this.player(a).name} و ${this.player(b).name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}" — ${summary}`); // [C15] السجل الموحّد
        this._onCharacterActivated(playerId);
        return { notice: summary };
      }
      case 'equalizer':
        this.nextMutinyMods.equalizer = true;
        ch.revealed = true;
        setLastActivated('تأثير القدرة: المعادِل - حسم التعادل لصالح التمرد');
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return {};
      case 'smuggler': {
        // [غموض موثق 5.6.5] التثبيت على اللاعب لا الدور: "هذا اللاعب يسحب ثلاث أوراق".
        // إن فقد الدور قبل الملاحة (مثل Chief Cook) فلن يسحب أصلاً والتأثير يسقط بصمت.
        if (payload.targetId !== this.captainId && payload.targetId !== this.lieutenantId)
          throw new Error('اختر القبطان أو الـ Lieutenant');
        this.nextMutinyMods.smugglerTarget = payload.targetId;
        ch.revealed = true;
        setLastActivated(`اللاعب المستهدف: ${this.player(payload.targetId).name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return {};
      }
      case 'archivist': {
        if (this.phase !== PHASES.NAV_CAPTAIN && this.phase !== PHASES.NAV_LIEUTENANT)
          throw new Error('يُفعَّل الأرشيفي فقط أثناء مرحلة الملاحة');
        if (payload.targetId !== this.captainId && payload.targetId !== this.lieutenantId)
          throw new Error('اختر القبطان أو الـ Lieutenant');
        if (payload.targetId === playerId)
          throw new Error('لا يمكن اختيار النفس');
        this.archivistOffer = { targetId: payload.targetId, offeredById: playerId };
        ch.revealed = true;
        setLastActivated(`اللاعب المستهدف: ${this.player(payload.targetId).name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return { promptFor: payload.targetId, info: { type: 'archivist_offer', from: p.name, archivistId: p.id } };
      }
      case 'consultant': {
        const lt = this.player(payload.ltId);
        if (!lt || !lt.alive || lt.offDuty || payload.ltId === this.captainId)
          throw new Error('اختيار Lieutenant غير صالح');
        this.nextMutinyMods.consultantLtPick = payload.ltId;
        ch.revealed = true;
        setLastActivated(`اللاعب المستهدف: ${this.player(payload.ltId).name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return {};
      }
      case 'bosun': {
        if (!this.lieutenantId || !this.navigatorId) throw new Error('لا فريق ملاحة حالياً');
        [this.lieutenantId, this.navigatorId] = [this.navigatorId, this.lieutenantId];
        ch.revealed = true;
        setLastActivated('تأثير القدرة: مبادلة شارتي المساعد والملاح');
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}" — رئيس البحّارة بادل الشارتين`);
        this._onCharacterActivated(playerId);
        return {};
      }
      case 'herbalist': {
        const from = this.player(payload.fromId), to = this.player(payload.toId);
        if (!from?.offDuty || !to || !to.alive || to.offDuty) throw new Error('نقل غير صالح');
        from.offDuty = false; to.offDuty = true;
        ch.revealed = true;
        setLastActivated(`اللاعبين المستهدفين: ${from.name} و ${to.name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return {};
      }
      case 'lookout': {
        if (this.drawPile.length === 0) this._emergencyReshuffle();
        if (payload.decide === undefined) {
          // مرحلة 1: إظهار الورقة سراً للمفعّل (تُستكمل بطلب ثانٍ مع decide)
          // [إصلاح #7] نربط الورقة المعروضة؛ عمليات سحب الأوراق محجوبة حتى القرار
          // [C11] لا كشف في الخطوة 1 — البطاقة تبقى مقلوبة حتى القرار في الخطوة 2.
          if (this.lookoutPending && this.lookoutPending.playerId !== playerId)
            throw new Error('مراقب آخر لم يحسم قراره بعد');
          const top = this.drawPile[0];
          this.lookoutPending = { playerId, card: top };
          return { secretFor: playerId, info: { type: 'lookout', topCard: top }, needsDecision: true };
        }
        // مرحلة 2: القرار - يجب أن تكون الورقة هي نفسها التي عُرضت
        if (!this.lookoutPending || this.lookoutPending.playerId !== playerId)
          throw new Error('لا توجد معاينة معلقة - فعّل البطاقة أولاً');
        if (this.drawPile[0] !== this.lookoutPending.card) {
          this.lookoutPending = null;
          throw new Error('تغيّرت أعلى ورقة - أُلغيت المعاينة، فعّل البطاقة من جديد');
        }
        if (payload.decide === 'discard') {
          this.discardPile.push(this.drawPile.shift());
        }
        this.lookoutPending = null;
        ch.revealed = true; // [C11] الكشف فقط عند اكتمال القرار
        setLastActivated(`تأثير القدرة: معاينة وقرر ${payload.decide === 'discard' ? 'رمي' : 'إبقاء'} الورقة العلوية`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        return {};
      }
      case 'mentor': {
        const t2 = this.player(payload.targetId);
        if (!t2?.character?.revealed) throw new Error('بطاقة الهدف ليست مكشوفة');
        t2.character.revealed = false;
        t2.character.gunsmithActive = false;
        ch.revealed = true;
        setLastActivated(`اللاعب المستهدف: ${t2.name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        return {};
      }
      case 'spiritualist': {
        const [a, b] = payload.targetIds || [];
        const recv = this.player(payload.receiverId);
        if (!a || !b || !recv) throw new Error('اختر لاعبَين ومستلماً');
        if (a === b) throw new Error('اختر لاعبَين مختلفين'); // [C07/C11]
        // القاعدة (Character_Cards.md:77 — "Both players must give one gun"):
        // كلا المُختارَين بحاجة إلى ≥1 مسدس؛ لا يُسمح بالدفع الجزئي الصامت.
        const qa = this.player(a), qb = this.player(b);
        if (!qa?.alive || !qb?.alive || qa.guns < 1 || qb.guns < 1)
          throw new Error('كلا اللاعبَين يجب أن يملكا مسدساً واحداً على الأقل'); // [C06/C11]
        for (const id of [a, b]) {
          const q = this.player(id);
          if (q && q.guns > 0) { q.guns -= 1; recv.guns += 1; }
        }
        ch.revealed = true;
        setLastActivated(`اللاعبين المستهدفين: ${qa.name} و ${qb.name} (لصالح ${recv.name})`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}" — انتقل مسدس من ${qa.name} وآخر من ${qb.name} إلى ${recv.name}`);
        if (this.spiritualistWindowActive) {
          this.spiritualistWindowActive = false;
          this.pending = null;
          this._finishRound();
        }
        return {};
      }
      case 'debt_collector': {
        const t2 = this.player(payload.targetId);
        const team = [this.captainId, this.lieutenantId, this.navigatorId].filter(Boolean);
        if (!team.includes(payload.targetId)) throw new Error('الهدف ليس في فريق الملاحة');
        // [غموض موثق #16] عند عجز الهدف عن الدفع للجميع: التفسير المعتمد =
        // دفع جزئي بترتيب الأدوار (قبطان ثم Lieutenant ثم Navigator) حتى نفاد المسدسات
        for (const id of team) {
          if (id !== payload.targetId && t2.guns > 0) {
            t2.guns -= 1;
            this.player(id).guns += 1;
          }
        }
        ch.revealed = true;
        setLastActivated(`اللاعب المستهدف: ${t2.name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return {};
      }
      case 'chief_cook': {
        // [C08] كبير الطهاة يستثني القبطان الحالي من بحث أقل résumés — منطق _applyDrunk
        //       صحيح (p.id !== this.captainId في فلتر المؤهلين) ومطابق لقواعد بطاقة #15.
        // [غموض موثق #18] التفسير المعتمد: تُفعَّل بعد التعيين وقبل أن يبدأ أي لاعب
        // بوضع مسدساته - يمنع تصفير مطيانة جارية فعلياً
        if (this.mutiny && this.mutiny.commitments.size > 0)
          throw new Error('لا يمكن تفعيل كبير الطهاة بعد بدء سؤال الولاء');
        this._applyDrunk(); // نفس منطق أقل résumés مع عقارب الساعة
        // القبطان الجديد يعيّن فريقاً جديداً
        this.lieutenantId = null; this.navigatorId = null;
        this.phase = PHASES.APPOINT;
        this.mutiny = null;
        ch.revealed = true;
        setLastActivated('تأثير القدرة: كبير الطهاة - إلغاء وتغيير فريق الملاحة');
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}"`);
        this._onCharacterActivated(playerId);
        return {};
      }
      case 'instigator': {
        const target = this.player(payload.targetId);
        if (!target || !target.alive) throw new Error('هدف غير صالح');
        if (payload.targetId === this.captainId) throw new Error('لا يمكن اختيار القبطان');
        if (!this.mutiny) throw new Error('لا مطيانة جارية');
        
        const gunsToCommit = target.guns;
        const current = this.mutiny.commitments.get(payload.targetId) || 0;
        this.mutiny.commitments.set(payload.targetId, current + gunsToCommit);
        target.guns = 0;
        
        ch.revealed = true;
        setLastActivated(`اللاعب المستهدف: ${target.name}`);
        this._log(`${p.name} فعّل بطاقة "${def.nameAr}" على ${target.name}. أُجبر على وضع جميع مسدساته المتبقية (${gunsToCommit})`);
        
        this._onCharacterActivated(playerId);
        return {
          secretFor: payload.targetId,
          info: { type: 'instigator_forced', gunsTaken: gunsToCommit }
        };
      }
      default:
        // [C11] حالة غير معروفة: لا نكشف البطاقة من باب الأمان.
        throw new Error(`بطاقة غير مدعومة: ${def.nameAr}`);
    }
  }

  // الهدف يرد على عرض الـ Instigator
  instigatorResponse(instigatorId, targetId, accepted) {
    const inst = this.player(instigatorId);
    const target = this.player(targetId);
    if (!inst || !target) throw new Error('لاعب غير معروف');
    if (!this.mutiny) throw new Error('لا مطيانة');
    // [C10] منع overwrite خارج نافذة after_reveal — لا يُسمح بتغيير الالتزامات بعد حسم المطيانة
    this._assertPhase(PHASES.POST_REVEAL);
    if (inst.character?.id !== 'instigator' || !inst.character?.revealed)
      throw new Error('لم تُفعّل بطاقة المحرّك الخفي');
    if (accepted) {
      this.mutiny.commitments.set(targetId, target.guns);
      this._log(`${target.name} أضاف كل مسدساته للمطيانة!`);
    } else {
      // الرافض → بطاقة المحرّك الخفي تُقلب (قابلة للتفعيل لاحقاً)
      inst.character.revealed = false;
      this._log(`${target.name} رفض - بطاقة المحرّك الخفي تعود`);
    }
    return {};
  }

  // الهدف يرد على عرض الأرشيفي
  archivistRespond(targetId, accept) {
    if (!this.archivistOffer) throw new Error('لا يوجد عرض أرشيفي معلّق');
    if (this.archivistOffer.targetId !== targetId) throw new Error('لست المستهدف');
    if (accept) {
      this.archivistRedraw(targetId);
    }
    this.archivistOffer = null;
    return { ok: true, accepted: accept };
  }

  // ============ إيقاف اللعبة للشخصيات ============

  _checkPauseForCharacters(timing) {
    if (this.pausedForCharacters) return true;

    const pendingPlayers = this.players.filter(p => 
      p.alive && 
      p.connected && 
      p.character && 
      !p.character.revealed && 
      CHARACTER_BY_ID[p.character.id]?.timing === timing
    );

    let eligiblePlayers = pendingPlayers;
    if (timing === 'before_draw') {
      if (this.phase === PHASES.NAV_CAPTAIN || this.phase === PHASES.NAV_LIEUTENANT) {
        eligiblePlayers = pendingPlayers.filter(p => p.character.id === 'archivist');
      } else {
        eligiblePlayers = pendingPlayers.filter(p => p.character.id === 'smuggler');
      }
    }

    if (eligiblePlayers.length === 0) {
      return false;
    }

    const decisions = {};
    for (const p of eligiblePlayers) {
      decisions[p.id] = 'pending';
    }

    this.pausedForCharacters = {
      timing,
      decisions
    };

    this._log(`اللعبة متوقفة بانتظار قرارات الشخصيات (${timing})`);
    return true;
  }

  skipCharacterDecision(playerId) {
    if (!this.pausedForCharacters) throw new Error('اللعبة ليست متوقفة لقرار شخصية');
    if (this.pausedForCharacters.decisions[playerId] !== 'pending') {
      throw new Error('ليس لديك قرار معلق');
    }
    this.pausedForCharacters.decisions[playerId] = 'skipped';
    const p = this.player(playerId);
    this._log(`${p.name} تخطى فرصة استخدام بطاقته`);
    this._checkPauseResolution();
    return {};
  }

  _checkPauseResolution() {
    if (!this.pausedForCharacters) return;
    const hasPending = Object.values(this.pausedForCharacters.decisions).some(status => status === 'pending');
    if (!hasPending) {
      const timing = this.pausedForCharacters.timing;
      this.pausedForCharacters = null;
      this._log(`استئناف اللعبة بعد انتهاء قرارات الشخصيات (${timing})`);

      if (timing === 'before_draw' && this.phase !== PHASES.NAV_CAPTAIN && this.phase !== PHASES.NAV_LIEUTENANT) {
        this._startNavigation();
        if (this.fillPositionsRandomlyPending) {
          this.fillPositionsRandomlyPending = false;
          this._fillPositionsRandomly();
        }
      }
    }
  }

  _onCharacterActivated(playerId) {
    if (this.pausedForCharacters && this.pausedForCharacters.decisions[playerId] === 'pending') {
      this.pausedForCharacters.decisions[playerId] = 'activated';
      this._checkPauseResolution();
    }
  }

  triggerStartNavigation() {
    const isPaused = this._checkPauseForCharacters('before_draw');
    if (!isPaused) {
      this._startNavigation();
      if (this.fillPositionsRandomlyPending) {
        this.fillPositionsRandomlyPending = false;
        this._fillPositionsRandomly();
      }
    }
  }

  // ============ أدوات الراوي (Narrator Overrides) ============

  narratorOverride(action, payload = {}) {
    switch (action) {
      case 'set_phase': this.phase = payload.phase; break;
      case 'set_guns': { const p = this.player(payload.playerId); if (p) p.guns = payload.guns; break; }
      case 'set_captain': this.captainId = payload.playerId; break;
      case 'move_ship': this._applyLegalShipMove(payload.hexId); break;
      case 'eliminate': { const p = this.player(payload.playerId); if (p) { p.alive = false; p.eliminated = payload.reason || 'narrator'; } break; }
      case 'revive': { const p = this.player(payload.playerId); if (p) { p.alive = true; p.eliminated = null; } break; }
      case 'set_off_duty': { const p = this.player(payload.playerId); if (p) p.offDuty = !!payload.value; break; }
      case 'end_game': this._endGame(payload.victory, payload.reason || 'قرار الراوي'); break;
      case 'force_finish_round': this._finishRound(); break;
      case 'cancel_lookout': this.lookoutPending = null; break; // [إصلاح #7] إلغاء معاينة عالقة
      case 'reorder_seats': {
        payload.order.forEach((pid, i) => { const p = this.player(pid); if (p) p.seat = i; });
        this.players.sort((a, b) => a.seat - b.seat);
        break;
      }
      default: throw new Error('أمر راوٍ غير معروف');
    }
    this._log(`[راوي] ${action}`, true);
  }

  // ============ العروض (Views) ============

  // ما يراه الجميع
  publicState() {
    return {
      code: this.code,
      mode: this.mode,
      phase: this.phase,
      readyPlayerIds: Array.from(this.readyPlayers),
      hasNarrator: !!this.narratorId,
      shipHex: this.shipHex,
      lastPlayedCard: this.lastPlayedCard,
      lastActivatedCharacter: this.lastActivatedCharacter,
      // [قاعدة الحركة] المصدر الوحيد للحقيقة للأسهم في الراسم: نفس خريطة السيرفر.
      hexes: serializeMap(this.map),
      usedMapActions: [...this.usedMapActions],
      captainId: this.captainId,
      lieutenantId: this.lieutenantId,
      navigatorId: this.navigatorId,
      generalSupply: this.generalSupply,
      drawPileCount: this.drawPile.length,
      discardPileCount: this.discardPile.length,
      cultRitualsLeft: this.cultRitualDeck.length,
      supplyLineCrossed: this.supplyLineCrossed,
      pendingType: this.pending?.type || null,
      pendingAction: this.pending?.action || this.pending?.ritual || null,
      // [F08/C14] معاينة المراقب المعلقة: Boolean فقط للعموم (لا تسريب هوية المفعّل للجمهور/الشاشات)
      // الحامل يرى العلم الخاص به عبر privateState.yourLookoutPending (أنزل)
      // [C02] إعلام القبطان بأن المستعار عيّن الـ Lieutenant مسبقاً (قفل الاختيار)
      consultantLtPick: this.nextMutinyMods.consultantLtPick,
      lookoutPending: !!this.lookoutPending,
      pendingInstigator: !!this.pendingInstigator,
      pausedForCharacters: this.pausedForCharacters ? {
        timing: this.pausedForCharacters.timing,
        pendingPlayers: Object.entries(this.pausedForCharacters.decisions)
          .filter(([_, status]) => status === 'pending')
          .map(([pid, _]) => ({ id: pid, name: this.player(pid).name }))
      } : null,
      mutinyRevealed: this.mutiny?.revealed
        ? Object.fromEntries(this.mutiny.commitments)
        : null,
      troublemakerTarget: this.mutiny?.revealed ? this.mutiny.doubledTarget : null,
      mutinyCommittedIds: this.mutiny
        ? Array.from(this.mutiny.commitments.keys())
        : null,
      mutinyResolveDelayLeft: (this.phase === PHASES.POST_REVEAL && this.mutiny?.revealedAt)
        ? Math.max(0, Math.ceil((RESOLVE_DELAY_MS - (Date.now() - this.mutiny.revealedAt)) / 1000))
        : 0,
      mutinyCommitDelayLeft: (this.phase === PHASES.LOYALTY_COMMIT && this.mutiny?.startedAt)
        ? Math.max(0, Math.ceil((MUTINY_COMMIT_DELAY_MS - (Date.now() - this.mutiny.startedAt)) / 1000))
        : 0,
      mutinyTieQueue: this.mutiny?.tieQueue || null,
      mutinyTieChooser: this.mutiny?.tieChooser || null,
      winner: this.winner,
      winReason: this.winReason,
      players: this.players.map(p => ({
        id: p.id, name: p.name, seat: p.seat, alive: p.alive, eliminated: p.eliminated,
        guns: p.guns, // المسدسات معلومة عامة خارج المطيانة
        offDuty: p.offDuty, tongueCut: p.tongueCut,
        floggingResult: p.floggingResult,
        resumes: p.resumes,
        characterRevealed: p.character?.revealed ? p.character.id : null,
        connected: p.connected,
        // الفرق تُكشف فقط عند نهاية اللعبة
        faction: this.phase === PHASES.GAME_OVER ? p.faction : null,
      })),
      log: this.log.filter(l => !l.secret).slice(-50),
    };
  }

  // ما يراه لاعب معين فقط
  privateState(playerId) {
    const p = this.player(playerId);
    if (!p) return null;
    const priv = {
      yourId: p.id,
      faction: p.faction,
      character: p.character ? { id: p.character.id, revealed: p.character.revealed, ...CHARACTER_BY_ID[p.character.id] } : null,
      guns: p.guns,
      // [C14] الحامل وحده يعرف أن لديه قرار المراقب معلّقاً (لا تُبث الهوية للجمهور)
      yourLookoutPending: !!this.lookoutPending && this.lookoutPending.playerId === playerId,
      yourArchivistPending: !!this.archivistOffer && this.archivistOffer.targetId === playerId,
      archivistOfferedBy: (this.archivistOffer && this.archivistOffer.targetId === playerId) ? this.player(this.archivistOffer.offeredById)?.name : null,
      yourInstigatorPending: !!this.pendingInstigator && this.pendingInstigator.targetId === playerId,
      instigatorOfferedBy: (this.pendingInstigator && this.pendingInstigator.targetId === playerId) ? this.player(this.pendingInstigator.instigatorId)?.name : null,
      instigatorId: (this.pendingInstigator && this.pendingInstigator.targetId === playerId) ? this.pendingInstigator.instigatorId : null,
      yourCharacterPausePending: !!(this.pausedForCharacters && this.pausedForCharacters.decisions[playerId] === 'pending'),
    };

    // [C02] Persistent Cultist State hydration
    if (p.faction === C.FACTIONS.CULTIST && p.knownCultLeader) {
      priv.knownCultLeader = p.knownCultLeader;
    }
    if (p.faction === C.FACTIONS.CULT_LEADER && p.knownCultists) {
      priv.knownCultists = p.knownCultists;
    }

    // القراصنة يعرفون بعضهم (من التجمع السري)
    // [إصلاح #17] اللقطة المثبتة وقت التجمع، مع احتياط للحالة قبل التجمع
    if (p.originalFaction === C.FACTIONS.PIRATE) {
      priv.knownPirates = p.pirateCohort || this.players
        .filter(q => q.originalFaction === C.FACTIONS.PIRATE)
        .map(q => ({ id: q.id, name: q.name }));
    }
    // أوراق الملاحة في يد اللاعب حسب مرحلته أو عرض الأرشيفي المعلق
    const isTargetOfArchivist = this.archivistOffer && this.archivistOffer.targetId === playerId;
    if ((this.phase === PHASES.NAV_CAPTAIN && playerId === this.captainId) || (isTargetOfArchivist && playerId === this.captainId)) {
      priv.navCards = this.nav.captainCards;
    }
    if ((this.phase === PHASES.NAV_LIEUTENANT && playerId === this.lieutenantId) || (isTargetOfArchivist && playerId === this.lieutenantId)) {
      priv.navCards = this.nav.ltCards;
    }
    if (this.phase === PHASES.NAV_NAVIGATOR && playerId === this.navigatorId) {
      priv.navCards = this.nav.logbook;
    }
    return priv;
  }

  // الراوي يرى كل شيء
  narratorState() {
    return {
      ...this.publicState(),
      fullPlayers: this.players.map(p => ({
        id: p.id, name: p.name, faction: p.faction, originalFaction: p.originalFaction,
        guns: p.guns, alive: p.alive, examined: p.examined,
        character: p.character,
      })),
      // [F10] حدود الثقة: لا نُرجع ترتيب drawPile الخام لمنع شمّ الكومة (قواعد ص12:
      // "لا يُكشف ما في الكومة عند الخلط"). العدّ الكافي معرَّض في publicState.drawPileCount.
      drawPileCount: this.drawPile.length,
      discardPile: this.discardPile,
      cultRitualDeck: this.cultRitualDeck,
      mutinyCommitments: this.mutiny ? Object.fromEntries(this.mutiny.commitments) : null,
      navState: this.nav,
      pending: this.pending,
      fullLog: this.log,
    };
  }

  _assertPhase(phase) {
    if (this.phase !== phase) throw new Error(`غير متاح في المرحلة الحالية (${this.phase})`);
  }
}

module.exports = { GameRoom, PHASES };
