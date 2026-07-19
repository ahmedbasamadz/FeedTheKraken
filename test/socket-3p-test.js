process.env.RESOLVE_DELAY_MS = '0';
// ============================================
// اختبار Socket لأزرار الجولة الثانية + دوران مُختار التعادل
// (Round 2: زر "حسم المطيانة"، دوران مُختار التعادل)
//
// ⚠️ هذا الاختبار بشري/شبكي ومنفصل عن `npm test` (الذي يشغّل sim.js فقط).
// طريقة التشغيل (نافذتان):
//   1) npm start                 # شغّل السيرفر على :3000
//   2) node test/socket-3p-test.js
//
// يتحقق من المسارات التي تستدعيها الأزرار الجديدة عبر طبقة Socket.io الحقيقية:
// [R-MIN5] وضع 3 لاعبين محذوف — الحد الأدنى 5 لاعبين. اختبار [A] السابق أُزيل.
// [B] 7 لاعبين Long: تعادل ثلاثي — كل مُختار يرى دوره في حالته الخاصة
//     (publicState().mutinyTieChooser === yourId) بلا تدخّل الراوي.
// ============================================

const { io } = require('socket.io-client');
const URL = process.env.FTK_URL || 'http://localhost:3000';

function emit(s, e, p = {}) {
  return new Promise((res, rej) => s.emit(e, p, (r) => {
    (r && r.ok === false) ? rej(new Error(`${e}: ${r.error}`)) : res(r || {});
  }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 FAIL: ${name}`); }
}

async function makePlayer(code, name) {
  const s = io(URL); const st = { last: null };
  s.on('state', x => {
    st.last = x;
    if (x.you && x.you.yourCharacterPausePending) {
      s.emit('character:skip_decision');
    }
  });
  await new Promise(r => s.on('connect', r));
  const { playerId } = await emit(s, 'player:join', { code, name });
  return { s, st, id: playerId, name };
}

async function testRotatingTie() {
  console.log('\n[B] 7 \u0644\u0627\u0639\u0628\u064a\u0646 Long: \u062a\u0639\u0627\u062f\u0644 3 \u2014 \u0643\u0644 \u0645\u064f\u062e\u062a\u0627\u0631 \u064a\u0631\u0649 \u062f\u0648\u0631\u0647 \u0641\u064a \u062d\u0627\u0644\u062a\u0647 \u0627\u0644\u062e\u0627\u0635\u0629');
  const narr = io(URL); let nstate = null; narr.on('state', s => nstate = s);
  await new Promise(r => narr.on('connect', r));
  const { code } = await emit(narr, 'narrator:create_room', { mode: 'long' });
  const P = []; for (let i = 0; i < 7; i++) P.push(await makePlayer(code, 'P' + i));
  await sleep(200);
  await emit(narr, 'narrator:start_game');       // \u2192 pirate_gathering
  await sleep(120);
  await emit(narr, 'narrator:finish_gathering');  // \u2192 appoint_team
  await sleep(150);
  const capId = nstate.captainId;
  const cap = P.find(p => p.id === capId);
  const others = P.filter(p => p.id !== capId);
  await emit(cap.s, 'captain:appoint', { ltId: others[0].id, navId: others[1].id });
  await sleep(120);
  const big = others.slice(0, 3), zero = others.slice(3);
  for (const p of big) await emit(p.s, 'player:commit_guns', { count: 3 });
  for (const p of zero) await emit(p.s, 'player:commit_guns', { count: 0 });
  await sleep(120);
  await emit(cap.s, 'captain:reveal_mutiny');
  await sleep(120);
  await emit(cap.s, 'captain:resolve_mutiny');
  await sleep(150);
  check('phase = mutiny_tie', cap.st.last.phase === 'mutiny_tie');
  check('queue \u0637\u0648\u0644\u0647 3', (cap.st.last.mutinyTieQueue || []).length === 3);
  check('\u0623\u0648\u0644 \u0645\u064f\u062e\u062a\u0627\u0631 = \u0627\u0644\u0642\u0628\u0637\u0627\u0646', cap.st.last.mutinyTieChooser === capId);
  await emit(cap.s, 'captain:resolve_tie', { dropId: big[0].id });
  await sleep(150);
  check('\u0628\u0639\u062f \u0627\u0644\u0625\u0633\u0642\u0627\u0637: \u0627\u0644\u062f\u0648\u0631 \u0627\u0646\u062a\u0642\u0644 \u0644\u0644\u0645\u064f\u0633\u0642\u064e\u0637 big[0]', cap.st.last.mutinyTieChooser === big[0].id);
  check('big[0] \u062d\u0627\u0644\u062a\u0647 \u0627\u0644\u062e\u0627\u0635\u0629: mutinyTieChooser === yourId', big[0].st.last.mutinyTieChooser === big[0].st.last.you.yourId);
  check('queue \u0627\u0644\u0622\u0646 \u0637\u0648\u0644\u0647 2', (cap.st.last.mutinyTieQueue || []).length === 2);
  await emit(big[0].s, 'captain:resolve_tie', { dropId: big[1].id });
  await sleep(150);
  check('\u0627\u0646\u062a\u0647\u0649 \u0627\u0644\u062a\u0639\u0627\u062f\u0644 \u2192 appoint_team', cap.st.last.phase === 'appoint_team');
  check('\u0627\u0644\u0642\u0628\u0637\u0627\u0646 \u0627\u0644\u062c\u062f\u064a\u062f = big[2]', cap.st.last.captainId === big[2].id);
  narr.close(); P.forEach(p => p.s.close());
}

(async () => {
  try { await testRotatingTie(); }
  catch (e) { fail++; console.log('  \u2717 EXCEPTION:', e.message); }
  console.log(`\n===== ${pass} pass / ${fail} fail =====`);
  process.exit(fail ? 1 : 0);
})();
