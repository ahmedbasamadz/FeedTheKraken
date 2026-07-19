// ============================================
// Feed the Kraken - Game Constants
// كل الجداول مأخوذة من كتيب القواعد Rulebook 1.0
// ============================================

const FACTIONS = {
  SAILOR: 'sailor',       // أزرق
  PIRATE: 'pirate',       // أحمر
  CULT_LEADER: 'cult_leader', // أصفر
  CULTIST: 'cultist',     // أخضر
};

// تركيبة الفرق حسب عدد اللاعبين (صفحة 5/7)
// لاحظ: 5 لاعبين لها قاعدة خاصة (تُعالج في GameRoom)
const TEAM_COMPOSITIONS = {
  5:  { sailor: null, pirate: null, cult_leader: 1, cultist: 0, special5: true },
  6:  { sailor: 3, pirate: 2, cult_leader: 1, cultist: 0 },
  7:  { sailor: 4, pirate: 2, cult_leader: 1, cultist: 0 },
  8:  { sailor: 4, pirate: 3, cult_leader: 1, cultist: 0 },
  9:  { sailor: 5, pirate: 3, cult_leader: 1, cultist: 0 },
  10: { sailor: 5, pirate: 4, cult_leader: 1, cultist: 0 },
  11: { sailor: 5, pirate: 4, cult_leader: 1, cultist: 1 },
};

// عتبة نجاح المطيانة (صفحة 9) — خريطة Long موحّدة، لا فروع للأوضاع
function mutinyThreshold(playerCount) {
  if (playerCount <= 7) return 3;
  if (playerCount <= 9) return 4;
  return 5;
}

// من يأخذ Off-Duty بعد الملاحة (صفحة 11) — خريطة Long موحّدة
function offDutyRoles(playerCount) {
  if (playerCount <= 6) return ['navigator'];
  if (playerCount <= 8) return ['lieutenant', 'navigator'];
  return ['captain', 'lieutenant', 'navigator'];
}

// ألوان أوراق الملاحة → الاتجاهات
// أصفر = شمال (Cult) | أزرق = شرق (Sailor) | أحمر = غرب (Pirate)
const COLORS = { YELLOW: 'yellow', BLUE: 'blue', RED: 'red' };

const NAV_ACTIONS = {
  DRUNK: 'drunk',
  MERMAID: 'mermaid',
  TELESCOPE: 'telescope',
  ARMED: 'armed',
  DISARMED: 'disarmed',
  CULT_UPRISING: 'cult_uprising',
};

// مجموعة أوراق Long Journey - كل الـ 23 ورقة (صفحة 6)
// [توحيد الخرائط] هذه المجموعة الوحيدة لكل الألعاب (5-11 لاعب)
function buildLongJourneyDeck() {
  const deck = [];
  const add = (n, color, action) => {
    for (let i = 0; i < n; i++) deck.push({ color, action });
  };
  // شمال (أصفر): 6x Cult Uprising
  add(6, COLORS.YELLOW, NAV_ACTIONS.CULT_UPRISING);
  // شرق (أزرق): 4x Drunk + 2x Disarmed
  add(4, COLORS.BLUE, NAV_ACTIONS.DRUNK);
  add(2, COLORS.BLUE, NAV_ACTIONS.DISARMED);
  // غرب (أحمر): 5x Drunk + 2x Mermaid + 2x Telescope + 2x Armed
  add(5, COLORS.RED, NAV_ACTIONS.DRUNK);
  add(2, COLORS.RED, NAV_ACTIONS.MERMAID);
  add(2, COLORS.RED, NAV_ACTIONS.TELESCOPE);
  add(2, COLORS.RED, NAV_ACTIONS.ARMED);
  return deck; // 23 ورقة
}

// أوراق طقوس الـ Cult الخمسة (صفحة 2/15)
const CULT_RITUALS = {
  CONVERSION: 'conversion',         // 3 نسخ
  GUNS_STASH: 'guns_stash',         // 1 نسخة
  CULT_CABIN_SEARCH: 'cult_cabin_search', // 1 نسخة
};

function buildCultRitualDeck() {
  return [
    CULT_RITUALS.CONVERSION,
    CULT_RITUALS.CONVERSION,
    CULT_RITUALS.CONVERSION,
    CULT_RITUALS.GUNS_STASH,
    CULT_RITUALS.CULT_CABIN_SEARCH,
  ];
}

// أنواع Map Actions
const MAP_ACTIONS = {
  CABIN_SEARCH: 'cabin_search',
  FLOGGING: 'flogging',
  OFF_WITH_TONGUE: 'off_with_tongue',
  FEED_THE_KRAKEN: 'feed_the_kraken',
};

const STARTING_GUNS = 3;
const TOTAL_GUNS = 40; // [إصلاح #14] الاحتياطي الفيزيائي الكامل (قواعد ص2)
const RESHUFFLE_THRESHOLD = 4; // أقل من 4 أوراق قبل الملاحة → إعادة خلط
const SUPPLY_REFILL_TO = 3;

module.exports = {
  FACTIONS, TEAM_COMPOSITIONS, COLORS, NAV_ACTIONS, CULT_RITUALS, MAP_ACTIONS,
  mutinyThreshold, offDutyRoles,
  buildLongJourneyDeck, buildCultRitualDeck,
  STARTING_GUNS, TOTAL_GUNS, RESHUFFLE_THRESHOLD, SUPPLY_REFILL_TO,
};
