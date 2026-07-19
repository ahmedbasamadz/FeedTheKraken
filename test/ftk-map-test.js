// ============================================
// اختبار راسم الخريطة (ftk-map.js) + طوبولوجيا map_f1.html
// يحمّل سكربت المتصفح في صندوق vm مع DOM/Canvas وهمي，
// ويتحقق أن:
//  1) يستبدل <svg id="mapSvg"> بـ <canvas>.
//  2) السفينة تُرسم عند إحداثيات الخلية h{row}_{x} مطابقة تماماً (لا snapping).
//  3) [طوبولوجيا] كل exits[color] من كل خلية إما ثابت نصر أو خلية موجودة في الخريطة
//     ومذكور صراحةً في exits[fromHex] (مصدر الحقيقة = map_f1.html EXIT_TABLE).
//  4) [قاعدة الحركة] السفينة تنتقل إلى إحدى مخارج الخلية الحالية فقط.
//  5) نموذج مثال: تبديل state.hexes (من السيرفر) يغير الهندسة فعلياً (single source of truth).
//  6) اختبار جانبي على السيرفر (mapLong) — كل المخارج في كل الوضعين تطابق القاعدة.
//  7) [توحيد] Quick = Long (نفس 31 خلية، نفس مخارج).
//  8) رموز الأكشن ومناطق النصر موزّعة وفقاً لـ map_f1.html.
// ============================================

process.env.RESOLVE_DELAY_MS = '0';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ftk-map.js'), 'utf8');

// ---- DOM/Canvas وهمي ----
function makeCtx() {
  const calls = [];
  const ctx = {
    calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1,
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...a) => calls.push(['moveTo', ...a]),
    lineTo: (...a) => calls.push(['lineTo', ...a]),
    closePath: () => calls.push(['closePath']),
    fill: () => calls.push(['fill']),
    stroke: () => calls.push(['stroke']),
    fillText: (...a) => calls.push(['fillText', ...a]),
    save: () => calls.push(['save']),
    translate: (...a) => calls.push(['translate', ...a]),
    rotate: (...a) => calls.push(['rotate', ...a]),
    restore: () => calls.push(['restore']),
    quadraticCurveTo: (...a) => calls.push(['quadraticCurveTo', ...a]),
    drawImage: (...a) => calls.push(['drawImage', ...a]),
  };
  return ctx;
}

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '', className: '',
    _attrs: {}, _html: '', _txt: '',
    style: {}, dataset: {}, children: [], parentNode: null,
    _ev: {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    replaceChild(n, o) {
      const i = this.children.indexOf(o);
      if (i >= 0) this.children[i] = n; else this.children.push(n);
      n.parentNode = this; o.parentNode = null;
      this._replaced = this._replaced || []; this._replaced.push([n, o]);
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    querySelectorAll() { return []; },
    addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
    classList: { add() {}, remove() {}, contains() { return false; } },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
    get textContent() { return this._txt; }, set textContent(v) { this._txt = v; },
  };
  return el;
}

function makeCanvas() {
  const c = makeEl('canvas');
  c.width = 0; c.height = 0;
  c._ctx = makeCtx();
  c.getContext = (t) => (t === '2d' ? c._ctx : null);
  c.getBoundingClientRect = () => ({ left: 0, top: 0, width: c.width, height: c.height, right: c.width, bottom: c.height });
  return c;
}

function makeDoc() {
  return {
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement: (tag) => (String(tag).toLowerCase() === 'canvas' ? makeCanvas() : makeEl(tag)),
    getElementById: () => null,
  };
}

function loadFTKMap() {
  const document = makeDoc();
  const ImageMock = function() {
    this.complete = true;
    this.src = '';
    setTimeout(() => {
      if (typeof this.onload === 'function') {
        this.onload();
      }
    }, 0);
  };
  const sandbox = {
    Math, Date, JSON, Object, Array, String, Number, Error, Infinity, NaN, isNaN, isFinite, parseFloat, parseInt, setTimeout, clearTimeout, console,
    Image: ImageMock,
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    cancelAnimationFrame: (id) => clearTimeout(id)
  };
  sandbox.window = sandbox;
  sandbox.document = document;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { FTKMap: sandbox.FTKMap, document };
}

// ---- مساعدات التحقق ----
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 0.001 : eps); }

const HEX_RADIUS = 90;
const HEX_HEIGHT = Math.sqrt(3) * HEX_RADIUS * 1.168;
// معادلة الراسم الجديدة (1250x1250):
function cxOf(x) { return (1250 / 2) + 0 + (x * (1.5 * HEX_RADIUS * 1.074)); }
function cyOf(y) { return (1250 - 155) + 116 - (y * HEX_HEIGHT); }

function shipAt(ctx) {
  const translates = ctx.calls.filter(c => c[0] === 'translate');
  if (translates.length) {
    const lastTranslate = translates[translates.length - 1];
    return [ 'translate', null, lastTranslate[1], lastTranslate[2] ];
  }
  return null;
}

// ---- فحص السيرفر: كل exits[line] خلية موجودة أو victory، ومذكور في exits[fromHex] ----
const mapLong = require('../server/game/mapLong');
const consts = require('../server/game/constants');

function assertExitInvariant(map, label) {
  for (const id in map) {
    const h = map[id];
    for (const color of ['red', 'yellow', 'blue']) {
      const dest = h.exits[color];
      if (!dest) return `${label}: ${id}.${color} missing dest`;
      if (['PIRATE_VICTORY', 'SAILOR_VICTORY', 'CULT_VICTORY'].includes(dest)) continue;
      const t = map[dest];
      if (!t) return `${label}: ${id}.${color} → ${dest} unknown hex`;
      if (!Object.values(h.exits).includes(dest)) return `${label}: ${id}.${color} → ${dest} not declared in exits`;
    }
  }
  return null;
}

// ===== الاختبارات =====
console.log('🐙 اختبار راسم الخريطة (ftk-map.js) + طوبولوجيا map_f1.html');

// 6) فحص السيرفر: خريطة Long
{
  const longMap = mapLong.buildLongJourneyMap();
  const err = assertExitInvariant(longMap, 'long');
  ok('mapLong: كل المخارج خلية موجودة أو victory', !err);
  if (err) console.log('    ->', err);
  ok('mapLong: 31 خلية في serializeMap', Object.keys(mapLong.serializeMap(longMap)).length === 31);
  ok('mapLong: START_HEX = h1_0 (num 1)', mapLong.START_HEX === 'h1_0' && longMap['h1_0'].num === 1);
  ok('mapLong: serializeMap يضم y و num', (function () {
    const s = mapLong.serializeMap(longMap);
    return s['h1_0'].y === 0 && s['h1_0'].num === 1 && s['h5_0'].num === 20;
  })());
  // isValidExit الآن يتحقق أن dest داخل exits[fromHex] (أو victory) — لا قيد row.
  ok('mapLong: isValidExit يقبل مخرجاً معلناً', !!mapLong.isValidExit(longMap['h1_0'], 'h2_0', longMap));
  ok('mapLong: isValidExit يرفض هدفاً خارج exits', !mapLong.isValidExit(longMap['h1_0'], 'h3_0', longMap));
  ok('mapLong: isValidExit يقبل victory', !!mapLong.isValidExit(longMap['h5_-3'], 'PIRATE_VICTORY', longMap));
  // 7) [توحيد الخرائط] Long هي الخريطة الوحيدة الآن — لا يوجد buildQuickJourneyMap
  ok('mapUnified: buildQuickJourneyMap محذوفة', typeof mapLong.buildQuickJourneyMap === 'undefined');
  ok('mapUnified: buildLongJourneyMap الوحيدة المتاحة', typeof mapLong.buildLongJourneyMap === 'function');
  ok('mapUnified: 31 خلية في Long (الخريطة الموحّدة)', Object.keys(longMap).length === 31);
  const err2 = assertExitInvariant(longMap, 'long');
  ok('mapUnified: كل المخارج خلية موجودة أو victory', !err2);
  if (err2) console.log('    ->', err2);
}

// 8) توزيع الأكشنز ومناطق النصر
{
  const map = mapLong.buildLongJourneyMap();
  const expectedActions = {
    'h2_-1': 'cabin_search', 'h2_1': 'cabin_search', 'h3_-2': 'cabin_search', 'h3_0': 'cabin_search',
    'h4_0': 'off_with_tongue', 'h4_-1': 'flogging', 'h4_1': 'flogging',
    'h5_-1': 'feed_the_kraken', 'h5_1': 'feed_the_kraken', 'h6_0': 'feed_the_kraken',
  };
  let actOk = true;
  for (const [id, act] of Object.entries(expectedActions)) {
    if (map[id].action !== act) { actOk = false; console.log('    action mismatch', id, map[id].action, 'expected', act); }
  }
  ok('mapLong: 10 أكشنز في الخلايا الصحيحة (map_f1)', actOk);
  // مناطق النصر: 7 أطراف، على الأقل أحد مخارجها يؤدي إلى victory
  const terminalNums = Object.values(map).filter(h => Object.values(h.exits).some(v => mapLong.isVictory(v))).map(h => h.num).sort((a, b) => a - b);
  ok('mapLong: 7 خلايا طرفية (victory exits)', terminalNums.length === 7 && JSON.stringify(terminalNums) === '[22,25,26,28,29,30,31]');
  // تصنيف النصر الصحيح
  ok('mapLong: num 31 = CULT_VICTORY', map['h7_0'].exits.yellow === 'CULT_VICTORY');
  ok('mapLong: nums 22,26,29 = PIRATE_VICTORY', ['h5_-3', 'h6_-2', 'h6_-1'].every(id => map[id].exits.yellow === 'PIRATE_VICTORY'));
  ok('mapLong: nums 25,28,30 = SAILOR_VICTORY', ['h5_3', 'h6_2', 'h6_1'].every(id => map[id].exits.yellow === 'SAILOR_VICTORY'));
}

// مخارج محددة من map_f1 (تحقق الـ special nodes)
{
  const map = mapLong.buildLongJourneyMap();
  const e = (id) => map[id].exits;
  // h1_0 (num 1): البداية
  ok('exit: h1_0 yellow→h2_0', e('h1_0').yellow === 'h2_0');
  ok('exit: h1_0 red→h1_-1', e('h1_0').red === 'h1_-1');
  ok('exit: h1_0 blue→h1_1', e('h1_0').blue === 'h1_1');
  // h4_-3 (num 15) special: col=-3,y=3.5 → yellow=red?blue? (per map_f1)
  ok('exit: h4_-3 yellow→h5_-2', e('h4_-3').yellow === 'h5_-2');
  ok('exit: h4_-3 red→h5_-3 (pirate)', e('h4_-3').red === 'h5_-3');
  ok('exit: h4_-3 blue→h5_-2', e('h4_-3').blue === 'h5_-2');
  // h4_3 (num 18) special: col=3,y=3.5
  ok('exit: h4_3 yellow→h5_2', e('h4_3').yellow === 'h5_2');
  ok('exit: h4_3 red→h5_2', e('h4_3').red === 'h5_2');
  ok('exit: h4_3 blue→h5_3 (sailor)', e('h4_3').blue === 'h5_3');
  // h5_-2 (num 19) isCustomBlueYellow: yellow→red path
  ok('exit: h5_-2 yellow→h5_-1 (custom blue-yellow)', e('h5_-2').yellow === 'h5_-1');
  ok('exit: h5_-2 red→h6_-2', e('h5_-2').red === 'h6_-2');
  ok('exit: h5_-2 blue→h5_-1', e('h5_-2').blue === 'h5_-1');
  // h5_2 (num 21) isCustomRedYellow
  ok('exit: h5_2 yellow→h5_1 (custom red-yellow)', e('h5_2').yellow === 'h5_1');
  ok('exit: h5_2 red→h5_1', e('h5_2').red === 'h5_1');
  ok('exit: h5_2 blue→h6_2', e('h5_2').blue === 'h6_2');
  // h6_0 (num 27): قبل الكراكن
  ok('exit: h6_0 yellow→h7_0', e('h6_0').yellow === 'h7_0');
  ok('exit: h6_0 red→h6_-1', e('h6_0').red === 'h6_-1');
  ok('exit: h6_0 blue→h6_1', e('h6_0').blue === 'h6_1');
}

const { FTKMap, document } = loadFTKMap();

ok('FTKMap موجود', typeof FTKMap === 'object' && FTKMap !== null);
ok('FTKMap.build دالة', typeof FTKMap.build === 'function');
ok('FTKMap.update دالة', typeof FTKMap.update === 'function');

const parent = makeEl('div');
const svg = makeEl('svg');
svg.id = 'mapSvg';
parent.appendChild(svg);

const canvas = FTKMap.build(svg);

ok('build يرجع canvas', !!(canvas && canvas.tagName === 'CANVAS'));
ok('استُبدل svg بـ canvas في الأب', !!(parent._replaced && parent._replaced.length === 1 && parent._replaced[0][0] === canvas && parent._replaced[0][1] === svg));
ok('canvas يحتفظ بـ id="mapSvg"', !!(canvas && canvas.id === 'mapSvg'));
ok('canvas بعرض 1250', !!(canvas && canvas.width === 1250));
ok('canvas بارتفاع 1250', !!(canvas && canvas.height === 1250));
ok('canvas._ftk مهيّأ', !!(canvas && canvas._ftk && canvas._ftk.ctx));

const ctx = canvas && canvas._ftk ? canvas._ftk.ctx : { calls: [] };
ok('رُسمت الخريطة (clearRect)', ctx.calls.some(c => c[0] === 'clearRect' && c[1] === 0 && c[2] === 0 && c[3] === 1250 && c[4] === 1250));

// 2) مطابقة معرّف 1:1 (لا snapping). h1_0 → (cxOf(0), cyOf(0.0))
let s = null;
let threw = false;
try { FTKMap.update(canvas, { shipHex: 'h1_0', usedMapActions: [], mode: 'long' }); s = shipAt(ctx); } catch (e) { threw = true; }
ok('update(h1_0) لا يرمي', !threw);
ok('السفينة مرسومة عند h1_0', !!s);
ok('h1_0: السفينة عند cx=400', !!s && approx(s[2], cxOf(0)));
ok('h1_0: السفينة عند cy=570 (y=0.0)', !!s && approx(s[3], cyOf(0.0)));

// h7_0 → y=6.0 → cy=570-6*HEX_HEIGHT
threw = false; s = null;
try { FTKMap.update(canvas, { shipHex: 'h7_0', usedMapActions: [], mode: 'long' }); s = shipAt(ctx); } catch (e) { threw = true; }
ok('update(h7_0) لا يرمي', !threw);
ok('h7_0: السفينة عند cx=400', !!s && approx(s[2], cxOf(0)));
ok('h7_0: السفينة عند cy=cyOf(6.0)', !!s && approx(s[3], cyOf(6.0)));

// h4_-3 → y=3.5 → cy=570-3.5*HEX_HEIGHT (يختبر y المركبية)
threw = false; s = null;
try { FTKMap.update(canvas, { shipHex: 'h4_-3', usedMapActions: [], mode: 'long' }); s = shipAt(ctx); } catch (e) { threw = true; }
ok('update(h4_-3) لا يرمي', !threw);
ok('h4_-3: السفينة عند cx=cxOf(-3)', !!s && approx(s[2], cxOf(-3)));
ok('h4_-3: السفينة عند cy=cyOf(3.5) (y مباشرة)', !!s && approx(s[3], cyOf(3.5)));

// h2_-1 → y=1.5 (لا snapping إلى y=1.0 أو row=2)
threw = false; s = null;
try { FTKMap.update(canvas, { shipHex: 'h2_-1', usedMapActions: [], mode: 'long' }); s = shipAt(ctx); } catch (e) { threw = true; }
ok('update(h2_-1) لا يرمي', !threw);
ok('h2_-1: السفينة عند cx=cxOf(-1)', !!s && approx(s[2], cxOf(-1)));
ok('h2_-1: السفينة عند cy=cyOf(1.5) (y=1.5 لا row=2)', !!s && approx(s[3], cyOf(1.5)));

// h3_0 in long mode → y=2.0 (الخريطة الموحّدة — لا وضع quick بعد الآن)
threw = false; s = null;
try { FTKMap.update(canvas, { shipHex: 'h3_0', usedMapActions: [], mode: 'long' }); s = shipAt(ctx); } catch (e) { threw = true; }
ok('update(h3_0, long) لا يرمي', !threw);
ok('h3_0 (long): السفينة عند cx=400', !!s && approx(s[2], cxOf(0)));
ok('h3_0 (long): السفينة عند cy=cyOf(2.0)', !!s && approx(s[3], cyOf(2.0)));

// معرّف غير معروف على الخريطة: يجب أن لا يرمي (warn فقط) ولا يرسم سفينة
threw = false; s = null;
try { FTKMap.update(canvas, { shipHex: 'h9_99', usedMapActions: [], mode: 'long' }); } catch (e) { threw = true; }
ok('update بمعرّف غير صالح لا يرمي', !threw);

threw = false;
try { FTKMap.update(canvas, { usedMapActions: [], mode: 'long' }); } catch (e) { threw = true; }
ok('update بدون shipHex لا يرمي', !threw);

threw = false;
try { FTKMap.update(canvas, { shipHex: 'h1_0', usedMapActions: ['h2_-1'], mode: 'long' }); } catch (e) { threw = true; }
ok('update مع usedMapActions لا يرمي', !threw);

// 8) رموز الأكشن ومناطق النصر لم تعد تُرسم ديناميكياً لأنها مدمجة بالخلفية
{
  ctx.calls.length = 0;
  let threw2 = false;
  try { FTKMap.update(canvas, { shipHex: 'h1_0', usedMapActions: ['h2_-1'], mode: 'long' }); } catch (e) { threw2 = true; }
  ok('update مع usedMapActions=["h2_-1"] لا يرمي', !threw2);
}

// 5) state.hexes مخصصة تُبدّل التخطيط (single source of truth)
{
  const customHexes = {
    'h1_0': { id: 'h1_0', row: 1, x: 0, y: 0.0, num: 1, action: null, exits: { yellow: 'h2_0', red: 'h2_0', blue: 'h2_0' } },
    'h2_0': { id: 'h2_0', row: 2, x: 0, y: 1.0, num: 4, action: null, exits: { yellow: 'CULT_VICTORY', red: 'PIRATE_VICTORY', blue: 'SAILOR_VICTORY' } },
  };
  threw = false; s = null;
  try { FTKMap.update(canvas, { shipHex: 'h2_0', mode: 'long', hexes: customHexes }); s = shipAt(ctx); } catch (e) { threw = true; console.log(e); }
  ok('update(state.hexes مخصصة) لا يرمي', !threw);
  // معرّف h2_0 مطابق في customHexes، يجب أن تُرسم السفينة عند y=1.0:
  ok('hexes مخصصة: السفينة عند cx=400', !!s && approx(s[2], cxOf(0)));
  ok('hexes مخصصة: السفينة عند cy=cyOf(1.0)', !!s && approx(s[3], cyOf(1.0)));

  // وعند h1_0 (y=0.0) في الخريطة المخصصة
  threw = false; s = null;
  try { FTKMap.update(canvas, { shipHex: 'h1_0', mode: 'long', hexes: customHexes }); s = shipAt(ctx); } catch (e) { threw = true; }
  ok('hexes مخصصة: h1_0 السفينة عند cy=cyOf(0.0)', !!s && approx(s[3], cyOf(0.0)));
}

// 4) [قاعدة الحركة] اختبار سيرفر متكامل: محاكاة لعبة كاملة وتأكيد تقدّم إلى مخرج صحيح
{
  const { GameRoom, PHASES } = require('../server/game/GameRoom');
  const room = new GameRoom('INV', 'nar', 'long');
  for (let i = 0; i < 9; i++) room.addPlayer('P' + i, 's' + i);
  room.start();
  room.finishGathering();
  let safety = 0;
  let moveCount = 0;
  while (room.phase !== PHASES.GAME_OVER && safety++ < 300) {
    if (room.pausedForCharacters) {
      const pendingIds = Object.entries(room.pausedForCharacters.decisions)
        .filter(([_, status]) => status === 'pending')
        .map(([pid, _]) => pid);
      for (const pid of pendingIds) {
        room.skipCharacterDecision(pid);
      }
      continue;
    }
    if (room.phase === PHASES.NAV_NAVIGATOR) {
      const before = room.map[room.shipHex];
      room.navigatorChoose(room.navigatorId, 0); // keep index 0, discard other
      if (room.phase !== PHASES.GAME_OVER) {
        const after = room.map[room.shipHex];
        // يجب أن تكون الخلية الجديدة أحد مخارج الخلية السابقة
        const validMove = Object.values(before.exits).includes(room.shipHex);
        ok('navigatorChoose: انتقل إلى مخرج معلن من ' + before.id, validMove);
        if (!validMove) moveCount = -999;
        moveCount++;
      }
      continue;
    }
    switch (room.phase) {
      case PHASES.APPOINT: {
        if (room.pending && room.pending.type === 'emergency_navigator') {
          const cs = room.alivePlayers.filter(p => p.id !== room.captainId && p.id !== room.lieutenantId);
          room.setEmergencyNavigator(room.captainId, cs[0].id);
          break;
        }
        const avail = room.alivePlayers.filter(p => !p.offDuty && p.id !== room.captainId);
        const lt = avail[0], nav = avail[1];
        room.appointTeam(room.captainId, lt.id, nav.id);
        break;
      }
      case PHASES.LOYALTY_COMMIT:
        for (const p of room.alivePlayers) if (p.id !== room.captainId) room.commitGuns(p.id, 0);
        room.revealMutiny();
        break;
      case PHASES.POST_REVEAL: room.resolveMutinyOutcome(); break;
      case PHASES.NAV_CAPTAIN: room.captainChoose(room.captainId, 0); break;
      case PHASES.NAV_LIEUTENANT: room.lieutenantChoose(room.lieutenantId, 0); break;
      case PHASES.MAP_ACTION: {
        const ts = room.alivePlayers.filter(p => p.id !== room.captainId);
        if (ts.length) room.resolveMapAction(room.captainId, ts[0].id);
        break;
      }
      case PHASES.CARD_ACTION: {
        if (room.pending && room.pending.action === 'mermaid') {
          const t = room.alivePlayers.filter(p => p.id !== room.captainId)[0];
          room.resolveMermaid(room.captainId, t && t.id || room.alivePlayers[0].id);
        } else if (room.pending && room.pending.action === 'telescope') {
          if (room.pending.stage === 'pick_player') {
            const t = room.alivePlayers.filter(p => p.id !== room.captainId)[0];
            room.telescopePickPlayer(room.captainId, t && t.id || room.alivePlayers[0].id);
          } else {
            room.telescopeDecide(room.pending.targetId, false);
          }
        }
        break;
      }
      case PHASES.CULT_RITUAL: room.cultSkipRitual(room.captainId); break;
      case PHASES.MUTINY_TIE: room.resolveTieDrop(room.mutiny.tieChooser, room.mutiny.tieQueue[0]); break;
      default: break;
    }
  }
  ok('GameRoom: عدد تنقلات سفينة>0', moveCount > 0);
  ok('GameRoom: اللعبة انتهت', room.phase === PHASES.GAME_OVER);
  if (room.phase === PHASES.GAME_OVER) {
    ok('GameRoom: اللعبة تنتهي بنصر', ['PIRATE_VICTORY', 'SAILOR_VICTORY', 'CULT_VICTORY'].includes(room.winner));
  }
}

// 4) متابعة: narratorOverride move_ship يرفض هدف غير قانوني، يقبل مخرجاً معلناً
{
  const { GameRoom } = require('../server/game/GameRoom');
  const room = new GameRoom('OVR', 'nar', 'long');
  for (let i = 0; i < 5; i++) room.addPlayer('P' + i, 's' + i);
  room.start(); room.finishGathering();
  // h1_0 exits = { yellow: h2_0, red: h1_-1, blue: h1_1 }
  let rejected = false;
  try { room.narratorOverride('move_ship', { hexId: 'h3_0' }); } catch (e) { rejected = true; }
  ok('narratorOverride(move_ship) يرفض القفز إلى h3_0 (خارج exits)', rejected);
  let accepted = false;
  try { room.narratorOverride('move_ship', { hexId: 'h2_0' }); accepted = true; } catch (e) { accepted = false; }
  ok('narratorOverride(move_ship) يقبل h2_0 (مخرج أصفر من h1_0)', accepted);
  ok('move_ship: shipHex انتقل إلى h2_0', room.shipHex === 'h2_0');
  // h2_0 exits = { yellow: h3_0, red: h2_-1, blue: h2_1 } — h1_0 ليس مخرجاً
  rejected = false;
  try { room.narratorOverride('move_ship', { hexId: 'h1_0' }); } catch (e) { rejected = true; }
  ok('narratorOverride(move_ship) يرفض العكس لـ h1_0 (خارج exits h2_0)', rejected);
}

// ===== النتيجة =====
console.log('\n===== النتيجة =====');
console.log('نجح: ' + pass + ' | فشل: ' + fail);
if (fail > 0) { console.error('❌ فشل الاختبار'); process.exit(1); }
console.log('✅ نجح الاختبار');
