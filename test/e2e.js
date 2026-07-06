process.env.RESOLVE_DELAY_MS = '0';
// ============================================
// اختبار E2E: راوٍ + 8 لاعبين عبر Socket.io حقيقي
// يلعب جولات كاملة عبر الشبكة ويتحقق من سلامة التدفق
// ============================================

const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const rand = a => a[Math.floor(Math.random() * a.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function emit(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (r) => {
      if (r && r.ok === false) reject(new Error(`${event}: ${r.error}`));
      else resolve(r || {});
    });
  });
}

async function main() {
  console.log('🐙 اختبار E2E عبر الشبكة...');

  // الراوي
  const narrator = io(URL);
  let narratorState = null;
  narrator.on('state', s => { narratorState = s; });
  await new Promise(r => narrator.on('connect', r));
  const { code } = await emit(narrator, 'narrator:create_room');
  console.log(`✓ غرفة: ${code}`);

  // 8 لاعبين
  const players = [];
  for (let i = 0; i < 8; i++) {
    const sock = io(URL);
    await new Promise(r => sock.on('connect', r));
    const states = { latest: null };
    sock.on('state', s => {
      states.latest = s;
      if (s.you && s.you.yourCharacterPausePending) {
        sock.emit('character:skip_decision');
      }
    });
    sock.on('secret', info => { /* معلومات سرية تصل */ });
    sock.on('error_msg', m => {});
    const { playerId } = await emit(sock, 'player:join', { code, name: `لاعب${i + 1}` });
    players.push({ sock, playerId, states });
  }
  console.log('✓ انضم 8 لاعبين');

  await emit(narrator, 'narrator:start_game');
  await emit(narrator, 'narrator:finish_gathering');
  await sleep(150);
  console.log('✓ بدأت اللعبة');

  const byId = id => players.find(p => p.playerId === id);
  const pub = () => narratorState;

  let rounds = 0;
  let safety = 0;
  while (pub().phase !== 'game_over' && safety++ < 400) {
    await sleep(30);
    const s = pub();
    const alive = s.players.filter(p => p.alive);

    try {
      switch (s.phase) {
        case 'appoint_team': {
          const cap = byId(s.captainId);
          if (s.pendingType === 'emergency_navigator') {
            const cands = alive.filter(p => p.id !== s.captainId && p.id !== s.lieutenantId);
            await emit(cap.sock, 'captain:emergency_navigator', { navId: rand(cands).id });
            break;
          }
          let pool = alive.filter(p => !p.offDuty && p.id !== s.captainId);
          if (pool.length < 2) pool = alive.filter(p => p.id !== s.captainId);
          if (pool.length < 2) { await emit(narrator, 'narrator:override', { action: 'end_game', payload: { victory: 'SAILOR_VICTORY', reason: 'e2e' } }); break; }
          const lt = rand(pool);
          const nav = rand(pool.filter(p => p.id !== lt.id));
          await emit(cap.sock, 'captain:appoint', { ltId: lt.id, navId: nav.id });
          rounds++;
          break;
        }
        case 'loyalty_commit': {
          for (const p of alive) {
            if (p.id === s.captainId) continue;
            if ((s.mutinyCommittedIds || []).includes(p.id)) continue;
            const n = Math.random() < 0.1 ? Math.min(p.guns, 1) : 0;
            await emit(byId(p.id).sock, 'player:commit_guns', { count: n });
          }
          await sleep(50);
          await emit(byId(pub().captainId).sock, 'captain:reveal_mutiny');
          break;
        }
        case 'post_reveal': {
          // [إصلاح #1] نافذة بطاقات after_reveal - الاختبار يحسم مباشرة
          await emit(byId(pub().captainId).sock, 'captain:resolve_mutiny');
          break;
        }
        case 'mutiny_tie': {
          // [إصلاح #2] من له حق الإسقاط: القبطان أولاً ثم آخر مُسقَط
          const chooser = byId(s.mutinyTieChooser || s.captainId);
          await emit(chooser.sock, 'captain:resolve_tie', { dropId: rand(s.mutinyTieQueue) });
          break;
        }
        case 'nav_captain': {
          const cap = byId(s.captainId);
          const cards = cap.states.latest?.you?.navCards || [];
          await emit(cap.sock, 'captain:choose_card', { keepIndex: Math.floor(Math.random() * Math.max(cards.length, 2)) });
          break;
        }
        case 'nav_lieutenant': {
          const lt = byId(s.lieutenantId);
          const cards = lt.states.latest?.you?.navCards || [];
          await emit(lt.sock, 'lt:choose_card', { keepIndex: Math.floor(Math.random() * Math.max(cards.length, 2)) });
          break;
        }
        case 'nav_navigator': {
          const nav = byId(s.navigatorId);
          await emit(nav.sock, 'navigator:choose_card', { discardIndex: Math.floor(Math.random() * 2) });
          break;
        }
        case 'map_action': {
          const cap = byId(s.captainId);
          const targets = alive.filter(p => p.id !== s.captainId);
          await emit(cap.sock, 'captain:map_action', { targetId: rand(targets).id });
          break;
        }
        case 'card_action': {
          const cap = byId(s.captainId);
          const nonCap = alive.filter(p => p.id !== s.captainId); // [إصلاح #4]
          if (s.pendingAction === 'mermaid') {
            await emit(cap.sock, 'captain:mermaid', { targetId: rand(nonCap).id });
          } else if (s.pendingAction === 'telescope') {
            const t = rand(nonCap);
            await emit(cap.sock, 'captain:telescope_pick', { targetId: t.id });
            await sleep(30);
            await emit(byId(t.id).sock, 'player:telescope_decide', { discard: Math.random() < 0.5 });
          }
          break;
        }
        case 'cult_ritual': {
          // الراوي يعرف من قائد الطائفة من narratorState
          const full = s.narrator.fullPlayers;
          const leader = full.find(p => p.faction === 'cult_leader');
          const leaderSock = leader && byId(leader.id)?.sock;
          if (s.pendingAction === 'conversion' && leaderSock && leader.alive) {
            const conv = full.filter(p => {
              const pp = s.players.find(q => q.id === p.id);
              return pp?.alive && !p.examined && p.faction !== 'cult_leader' && p.faction !== 'cultist';
            });
            if (conv.length) await emit(leaderSock, 'cult:convert', { targetId: rand(conv).id });
            else await emit(leaderSock, 'cult:skip');
          } else if (s.pendingAction === 'guns_stash' && leaderSock) {
            await emit(leaderSock, 'cult:distribute_guns', { allocations: { [rand(alive).id]: Math.min(3, s.generalSupply) } }); // [إصلاح #14]
          } else if (s.pendingAction === 'cult_cabin_search' && leaderSock) {
            await emit(leaderSock, 'cult:ack'); // [إصلاح #11]
          } else {
            if (leaderSock) await emit(leaderSock, 'cult:skip').catch(() => {});
          }
          break;
        }
      }
    } catch (e) {
      // أخطاء سباق الحالة مقبولة (الحالة تتغير بين القراءة والإرسال) - نتجاهل ونعيد
      if (!/المرحلة|دورك|متاح/.test(e.message)) throw e;
    }
  }

  if (pub().phase !== 'game_over') throw new Error('لم تنته اللعبة!');
  console.log(`✓ انتهت اللعبة بعد ${rounds} جولة | الفائز: ${pub().winner}`);
  console.log('✅ اختبار E2E نجح بالكامل');

  narrator.close();
  players.forEach(p => p.sock.close());
  process.exit(0);
}

main().catch(e => { console.error('✗ فشل:', e.message); process.exit(1); });
