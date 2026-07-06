// ============================================
// بطاقات الشخصيات الـ 22
// timing: متى يمكن تفعيلها
//   anytime        - أي وقت
//   before_appoint - قبل تعيين فريق الملاحة
//   after_appoint  - بعد تعيين فريق الملاحة
//   before_draw    - قبل سحب أوراق الملاحة
//   after_reveal   - فوراً بعد كشف المسدسات في المطيانة
//   yellow_turn    - خلال جولة لُعبت فيها ورقة صفراء
//   setup          - بداية اللعبة (Captain فقط)
// auto: هل النظام ينفذها آلياً بالكامل، أم تحتاج تأكيد الراوي
// ============================================

const CHARACTERS = [
  { id: 'captain',           nameAr: 'القبطان',          timing: 'setup',          auto: true,
    desc: 'تُكشف في بداية اللعبة. أنت أول قبطان. تُستبدل ببطاقة شخصية جديدة.' },
  { id: 'kleptomaniac',      nameAr: 'مهووس السرقة',     timing: 'anytime',        auto: true,
    desc: 'اختر لاعباً واسرق منه مسدساً واحداً.' },
  { id: 'troublemaker',      nameAr: 'مفتعل المشاكل',    timing: 'after_reveal',   auto: true,
    desc: 'اختر لاعباً: كل مسدس كشفه يُحسب كمسدسين في هذه المطيانة.' },
  { id: 'gunsmith',          nameAr: 'صانع الأسلحة',     timing: 'anytime',        auto: true, costGun: true,
    desc: 'تدفع مسدساً لتفعيلها. ما دامت مكشوفة: تسترجع مسدساً واحداً بعد كل مطيانة ناجحة شاركت فيها.' },
  { id: 'peacemaker',        nameAr: 'صانع السلام',      timing: 'after_reveal',   auto: true,
    desc: 'اختر لاعباً: تُعاد مسدساته المكشوفة لمخزونه ولا تُحسب في المطيانة.' },
  { id: 'gunslinger',        nameAr: 'المسلّح',          timing: 'anytime',        auto: true,
    desc: 'خذ مسدسين من الاحتياطي العام.' },
  { id: 'minstrel',          nameAr: 'المنشد',           timing: 'after_appoint',  auto: true,
    desc: 'اختر لاعبَين: لا يشاركان في المطيانة القادمة.' },
  // [غموض موثق #18] "قبل سحب أوراق الملاحة" يفترض وجود فريق معيّن؛
  // التوقيت after_appoint (= بعد التعيين وقبل السحب) هو النافذة الوحيدة ذات المعنى
  { id: 'bosun',             nameAr: 'رئيس البحّارة',    timing: 'after_appoint',  auto: true,
    desc: 'بادل شارة الـ Lieutenant مع شارة الـ Navigator في الفريق الحالي.' },
  { id: 'herbalist',         nameAr: 'العشّاب',          timing: 'before_appoint', auto: true,
    desc: 'انقل علامة Off-Duty من لاعب إلى لاعب آخر.' },
  { id: 'lookout',           nameAr: 'المراقب',          timing: 'anytime',        auto: true,
    desc: 'انظر سراً لأعلى ورقة ملاحة: أعدها أو ارمها في الـ Deep Sea.' },
  { id: 'master_strategist', nameAr: 'الاستراتيجي',      timing: 'after_reveal',   auto: true,
    desc: 'إن لم تصبح القبطان الجديد، تسترجع مسدساتك المكشوفة بعد المطيانة.' },
  { id: 'smuggler',          nameAr: 'المهرّب',          timing: 'before_draw',    auto: true,
    desc: 'اختر القبطان أو الـ Lieutenant: يسحب 3 أوراق بدلاً من 2.' },
  { id: 'agitator',          nameAr: 'المحرّض',          timing: 'after_appoint',  auto: true,
    desc: 'اختر لاعبَين: يجب أن يكشف كلٌ منهما مسدساً واحداً على الأقل في المطيانة القادمة.' },
  { id: 'consultant',        nameAr: 'المستشار',         timing: 'before_appoint', auto: true,
    desc: 'أنت تعيّن الـ Lieutenant القادم، ثم القبطان يعيّن الـ Navigator.' },
  { id: 'chief_cook',        nameAr: 'كبير الطهاة',      timing: 'after_appoint',  auto: true,
    desc: 'انقل القبطانية للاعب التالي (مع عقارب الساعة) صاحب أقل عدد résumés. القبطان الجديد يعيّن فريقاً جديداً.' },
  { id: 'rabble_rouser',     nameAr: 'مثير الشغب',       timing: 'after_reveal',   auto: true,
    desc: 'المطيانة الحالية تحتاج نصف العدد المطلوب (تقريب لأعلى).' },
  { id: 'archivist',         nameAr: 'الأرشيفي',         timing: 'before_draw',    auto: true,
    desc: 'اختر القبطان أو الـ Lieutenant: يجوز له رمي أوراقه المسحوبة وسحب ورقتين جديدتين.' },
  { id: 'mentor',            nameAr: 'الموجّه',          timing: 'anytime',        auto: true,
    desc: 'اقلب بطاقة شخصية لاعبٍ ما لوجهها السفلي: يمكن تفعيلها مرة ثانية.' },
  { id: 'spiritualist',      nameAr: 'الروحاني',         timing: 'yellow_turn',    auto: true,
    desc: 'في جولة ورقة صفراء: اختر لاعبَين، كلٌ منهما يعطي مسدساً للاعبٍ تختاره.' },
  { id: 'debt_collector',    nameAr: 'محصّل الديون',     timing: 'after_appoint',  auto: true,
    desc: 'اختر عضواً في فريق الملاحة: يعطي كل عضو آخر في الفريق مسدساً واحداً.' },
  { id: 'equalizer',         nameAr: 'المُعادِل',        timing: 'after_appoint',  auto: true,
    desc: 'المطيانة القادمة تنجح بمسدس واحد فقط، وكل لاعب يكشف مسدساً واحداً كحد أقصى.' },
  { id: 'instigator',        nameAr: 'المحرّك الخفي',    timing: 'after_reveal',   auto: true,
    desc: 'اختر لاعباً (ليس القبطان): تجبره على وضع جميع مسدساته المتبقية في المطيانة الحالية.' },
];

const byId = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));

module.exports = { CHARACTERS, CHARACTER_BY_ID: byId };
