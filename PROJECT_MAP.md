# PROJECT_MAP — Feed the Kraken Online

خريطة المشروع الحالية (State Sync). تُحدَّث عند كل تغيير معماري.

## البنية

```
server/
  index.js              السيرفر - Express + Socket.io (يخدم public/ ساكنة على المنفذ 3000)
  game/
    GameRoom.js         محرك اللعبة - State Machine كامل
    constants.js        الجداول: تركيبة الفرق، عتبات المطيانة، مجموعات الأوراق
    mapLong.js          خريطة Feed the Kraken (31 خلية + 7 وجهات نصر)
                         مصدر الحقيقة: map_f1.html (topology + navigation + actions + victory)
                         نظام الإحداثيات: h{row}_{x} (row = floor(y)+1، 1..7 جنوب→شمال، x إزاحة أفقية)
    characters.js       بطاقات الشخصيات الـ 22
public/
  index.html            الصفحة الرئيسية - اختيار لاعب / شاشة عرض / راوٍ
  player.html           واجهة اللاعب (موبايل)
  display.html          شاشة العرض المشتركة (تلفزيون)
  narrator.html         لوحة الراوي
  ftk-map.js            ★ راسم الخريطة المشترك (Canvas) — الطبقة المشتركة/Core
test/
  sim.js                اختبار محاكاة شامل (210 لعبة) - npm test
  e2e.js                اختبار E2E شبكي (يحتاج سيرفر)
  socket-3p-test.js     اختبار سيناريو 3 لاعبين
  ftk-map-test.js       ★ اختبار راسم الخريطة (TDD، vm + Canvas وهمي)
```

## الطبقة المشتركة/Core: `public/ftk-map.js`

وحدة `window.FTKMap` تكشف عقدة ثابتة:
- `FTKMap.build(el, opts?)` — `el` هو `<svg id="mapSvg">`؛ تُستبدل بـ `<canvas>`
  في مكانها (نفس المعرف) فتبقى الصفحات تعمل دون تعديل. `opts.onHexClick` اختياري.
- `FTKMap.update(el, state)` — `state` من `publicState()`: `{shipHex, usedMapActions, mode, ...}`.

المستهلكون (نفس الاستدعاء حرفياً):
- `display.html:137,164`  — `FTKMap.build($('mapSvg'))` / `FTKMap.update($('mapSvg'),S)`
- `player.html:203,288`   — نفسه
- `narrator.html:249,345` — نفسه (مراقب فقط)

منطق الرسم (المسدسات + الأسهم المزدوجة + السفينة ⛵) مأخوذ من ملف HTML المرفق
(Feed the Kraken hexagonal map) ويعمل على Canvas 800×650 بـ 31 عقدة بنظام `{col,y}`.

## طبقة الترجمة: `num` ↔ `h{row}_{x}`

`map_f1.html` يرقّم الخلايا بـ `num` (1..31) ويحدد موقعها بـ `{col, y}` (y ∈ {0.0, 0.5, …, 6.0}).
السيرفر يستخدم `h{row}_{x}` حيث:
- `row = Math.floor(y) + 1` (صفوف 1..7؛ يبقي `SUPPLY_LINE_AFTER_ROW = 4` وكل فحوص `row > 4`
  في `GameRoom.js` تعمل دون تعديل — الانتقال y ≤ 3.5 → y ≥ 4.0 يعادل row 4 → row 5).
- `x = col` (سالب = غرب/قراصنة، موجب = شرق/بحّارة).

`mapLong.js → NODES` يعرّف العلاقة 1:1 (`num ↔ {col, y} ↔ h{row}_{x}`)، و`EXIT_TABLE[num]`
يحوي الأهداف بأرقام `num` أو ثوابت `VICTORY.*`. `computeExits(num)` يحوّلها إلى `h{row}_{x}`
عند بناء الخريطة. `serializeMap(map)` يُرسل `y` و`num` للعميل كي يرسم الموضع والرموز.

## مناطق النصر (7 خلايا طرفية — كل exits → VICTORY ثابت)

| num | hexId   | الفصيل | اللون |
|---|---|---|---|
| 31 | h7_0    | الكراكن 🦑   | `CULT_VICTORY`   |
| 22 | h5_-3   | القراصنة 🏴‍☠️ | `PIRATE_VICTORY` |
| 26 | h6_-2   | القراصنة 🏴‍☠️ | `PIRATE_VICTORY` |
| 29 | h6_-1   | القراصنة 🏴‍☠️ | `PIRATE_VICTORY` |
| 25 | h5_3    | البحّارة ⚓   | `SAILOR_VICTORY` |
| 28 | h6_2    | البحّارة ⚓   | `SAILOR_VICTORY` |
| 30 | h6_1    | البحّارة ⚓   | `SAILOR_VICTORY` |

## التغيير الأخير: إعادة كتابة كاملة للخريطة — map_f1.html كمصدر وحيد للحقيقة

**السياق:** محاولة سابقة لتعديل جراحي على `ftk-map.js` فشلت لافتراضات خاطئة عن الطوبولوجيا.
الحل الصحيح: `map_f1.html` هو المصدر الكنسي للطوبولوجيا، الملاحة، توزيع الأكشنز، وشروط النصر.

**التغييرات:**
- `server/game/mapLong.js`:
  - `ROW_X` جديد بأحجام [3, 3, 5, 7, 7, 5, 1] = 31 خلية (مطابق لـ map_f1).
  - `NODES` (31 إدخال `{num, col, y}`) + `EXIT_TABLE[num]` محسوب مسبقاً من `getNextNode` في map_f1.
  - `computeExits(num)` يحوّل أرقام num إلى `h{row}_{x}` (أو يمرّر `VICTORY.*`).
  - `ACTION_PLACEMENT` جديد (10 أكشنز: cabin_search 4x، off_with_tongue 1x، flogging 2x، feed_the_kraken 3x).
  - `isValidExit(fromHex, dest, map)` جديد: يتحقق أن `dest` داخل `fromHex.exits` (أو victory) — لا قيد `row+1` صارم.
  - `serializeMap(map)` يُضيف `y` و`num` للعميل.
  - **توحيد الخرائط:** `buildQuickJourneyMap()` ترجع نفس 31 خلية كـ `buildLongJourneyMap()`.
    أُلغي `ROW_X_QUICK` و`ACTION_PLACEMENT_QUICK` (Quick = Long طوبولوجياً).
- `public/ftk-map.js`:
  - `NODES` (31 إدخال) + `EXIT_TABLE` مطابقة للسيرفر.
  - `pixelOf(hex)`: `cy = (height - 80) - hex.y * hexHeight` — مباشرة من `y` (لا من `row`) لتفادي الانسطاح البصري.
  - رموز الأكشن (🔍🗡️📖🐙) من `hex.action`، مع تعتيم `globalAlpha = 0.35` عند `usedMapActions`.
  - مناطق النصر ملونة (🦑 حدّ أصفر / 🏴‍☠️ حدّ أحمر / ⚓ حدّ أزرق).
  - تخطيط واحد لكل الأوضاع (لا mode switching) بعد توحيد Quick = Long.
- `test/ftk-map-test.js`: تأكيدات جديدة على الطوبولوجيا، المخارج، الأكشنز، مناطق النصر،
  وتكامل GameRoom (92/92 GREEN).
- `test/sim.js`: لم يُمَسّ — 210/210 GREEN مع الخريطة الموحدة (Quick = Long).

## الدين التقني (Technical Debt)

| المعرف | الوصف | تأثير | التسجيل |
|---|---|---|---|
| ~~TD-1~~ | ~~`usedMapActions` غير مرسوم بصرياً~~ ✓ مُعالَج: رموز الأكشن (🔍🗡️📖🐙) مرسومة من `hex.action` مع تعتيم `globalAlpha=0.35` عند `usedMapActions`. | — | — |
| ~~TD-2~~ | ~~`mode` (quick/long) لا يغيّر التخطيط~~ ✓ مُعالَج: توحيد كامل — `buildQuickJourneyMap()` ترجع نفس 31 خلية كـ Long. Quick و Long طوبولوجياً متطابقتان. | — | — |

## فجوات القواعد (Rule Gaps)

| المعرف | الوصف | الحالة |
|---|---|---|
| ~~R64~~ | ~~قلة اللاعبين (دون 3) لا تُملأ عشوائياً — `appointTeam()` تتجمد~~ ✓ مُعالَج: `appointTeam()` يكتشف `< 2` لاعب مؤهل ويستدعي `_fillPositionsRandomly()` لسحب ورقتين عشوائياً لكل مركز شاغر (Lieutenant/Navigator) وتنفيذ ورقة الملاحة مباشرةً. تمت إضافة `_drawTwoAndPick()` وحماية بحث `ltCount` في `_startNavigation()` ضد `null`. | مُغلَق |

## سجل التغييرات (Changelog)

### v0.10 — R64: ملء المراكز الشاغرة عشوائياً عند قلة اللاعبين
- **المشكلة:** عند انخفاض عدد اللاعبين على السفينة دون 3، كان `appointTeam()` في `server/game/GameRoom.js` يطرح خطأً (أو يتجمد) لعدم وجود لاعبَين مؤهلَين لـ Lieutenant و Navigator، دون مسار تعافٍ.
- **الإصلاح (قواعد R64):** إن قلّ عدد اللاعبين الأحياء غير القبطان وغير Off-duty عن اثنين، يتحول المحرك إلى ملء عشوائي:
  - `appointTeam()` يكتشر الحالة مبكراً ويستدعي `_startNavigation()` ثم `_fillPositionsRandomly()`.
  - `_fillPositionsRandomly()`: يُبقي ورقة القبطان عشوائياً، ثم يسحب ورقتين لكل مركز شاغر (عبر `_drawTwoAndPick()`) ويُبقي واحدة في الـ Logbook ويرمي الأخرى، ثم يخلط الـ Logbook وينفّذ ورقة عشوائية.
  - `_startNavigation()`: حماية `ltCount` ضد `null` (`this.lieutenantId ? … : 0`) وإضافة علمَي `ltFilledRandomly`/`navFilledRandomly` لحالة `this.nav`.
- **التحقق:** سيناريو 7 لاعبين → إقصاء 5 → قبطان + لاعب واحد → `appointTeam()` يملأ عشوائياً ويُكمل دون تجميد. `npm test` (210/210) و `node test/ftk-map-test.js` (90/90) GREEN بلا تغيير على المسار الطبيعي.

## التحقق (Verification)

- `node test/ftk-map-test.js` — 92/92 (طوبولوجيا map_f1 + المخارج + الأكشنز + مناطق النصر + تكامل GameRoom + أداة الراوي move_ship).
- `npm test` (sim.js) — 210/210 بلا تغيير (الراسم غير متورط في المحاكاة؛ الخريطة الموحدة Quick=Long تعمل لكل عدد لاعبين 5..11).
- استدعاءات الصفحات الثلاث (`FTKMap.build($('mapSvg'))` / `update`) لم تُمَسّ.

## التشغيل

```bash
npm install
npm start        # السيرفر على المنفذ 3000
npm test         # sim.js (210 لعبة)
node test/ftk-map-test.js   # اختبار الراسم
```
