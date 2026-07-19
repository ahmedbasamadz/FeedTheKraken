process.env.RESOLVE_DELAY_MS = '0';
// ============================================
// اختبار محاكاة: يلعب ألعاباً كاملة بقرارات عشوائية
// للتأكد أن المحرك لا ينهار وأن اللعبة تنتهي دائماً
// ============================================

const { GameRoom, PHASES } = require('../server/game/GameRoom');

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function playOneGame(numPlayers, verbose = false) {
  // [توحيد الخرائط] Long Journey فقط — خريطة الـ 31 خلية + 23 ورقة لكل عدد لاعبين 5..11
  const mode = 'long';
  const room = new GameRoom('TEST', 'narrator', mode);
  for (let i = 0; i < numPlayers; i++) room.addPlayer(`P${i + 1}`, `sock${i}`);
  room.start();
  room.finishGathering();

  let safety = 0;
  while (room.phase !== PHASES.GAME_OVER && safety++ < 500) {
    if (room.pausedForCharacters) {
      const pendingIds = Object.entries(room.pausedForCharacters.decisions)
        .filter(([_, status]) => status === 'pending')
        .map(([pid, _]) => pid);
      for (const pid of pendingIds) {
        room.skipCharacterDecision(pid);
      }
      continue;
    }
    switch (room.phase) {
      case PHASES.APPOINT: {
        if (room.pending?.type === 'emergency_navigator') {
          const candidates = room.alivePlayers.filter(p => p.id !== room.captainId && p.id !== room.lieutenantId);
          room.setEmergencyNavigator(room.captainId, rand(candidates).id);
          break;
        }
        const avail = room.alivePlayers.filter(p => !p.offDuty && p.id !== room.captainId);
        let pool = avail.length >= 2 ? avail : room.alivePlayers.filter(p => p.id !== room.captainId);
        if (pool.length < 2) {
          // أقل من 3 على السفينة - ننهي بقرار راوي (الحالة الاستثنائية)
          room.narratorOverride('end_game', { victory: 'SAILOR_VICTORY', reason: 'محاكاة: لاعبون غير كافين' });
          break;
        }
        const lt = rand(pool);
        const nav = rand(pool.filter(p => p.id !== lt.id));
        room.appointTeam(room.captainId, lt.id, nav.id);
        break;
      }
      case PHASES.LOYALTY_COMMIT: {
        // 15% من الجولات فيها محاولة مطيانة
        const tryMutiny = Math.random() < 0.15;
        for (const p of room.alivePlayers) {
          if (p.id === room.captainId) continue;
          let n = 0;
          if (tryMutiny && p.guns > 0 && Math.random() < 0.5) n = Math.min(p.guns, 1 + Math.floor(Math.random() * 2));
          if (room.nextMutinyMods.excluded.has(p.id)) n = 0;
          if (room.nextMutinyMods.mustReveal.has(p.id) && p.guns > 0) n = Math.max(1, n);
          if (room.nextMutinyMods.equalizer) n = Math.min(1, n);
          room.commitGuns(p.id, n);
        }
        room.revealMutiny();
        break;
      }
      case PHASES.POST_REVEAL: {
        // نافذة بطاقات after_reveal - المحاكاة لا تفعّل بطاقات، تحسم مباشرة
        room.resolveMutinyOutcome();
        break;
      }
      case PHASES.MUTINY_TIE: {
        room.resolveTieDrop(room.mutiny.tieChooser, rand(room.mutiny.tieQueue));
        break;
      }
      case PHASES.NAV_CAPTAIN:
        room.captainChoose(room.captainId, Math.floor(Math.random() * room.nav.captainCards.length));
        break;
      case PHASES.NAV_LIEUTENANT:
        room.lieutenantChoose(room.lieutenantId, Math.floor(Math.random() * room.nav.ltCards.length));
        break;
      case PHASES.NAV_NAVIGATOR: {
        // 3% فرصة رفض الأوامر
        if (Math.random() < 0.03 && room.alivePlayers.length > 4) {
          room.denyCommand(room.navigatorId);
        } else {
          room.navigatorChoose(room.navigatorId, Math.floor(Math.random() * 2));
        }
        break;
      }
      case PHASES.MAP_ACTION: {
        const targets = room.alivePlayers.filter(p => p.id !== room.captainId);
        room.resolveMapAction(room.captainId, rand(targets).id);
        break;
      }
      case PHASES.CARD_ACTION: {
        if (room.pending.action === 'mermaid') {
          const t = rand(room.alivePlayers.filter(p => p.id !== room.captainId));
          room.resolveMermaid(room.captainId, t.id);
        } else if (room.pending.action === 'telescope') {
          if (room.pending.stage === 'pick_player') {
            const t = rand(room.alivePlayers.filter(p => p.id !== room.captainId));
            room.telescopePickPlayer(room.captainId, t.id);
          } else {
            room.telescopeDecide(room.pending.targetId, Math.random() < 0.5);
          }
        }
        break;
      }
      case PHASES.CULT_RITUAL: {
        const leader = room.players.find(p => p.faction === 'cult_leader');
        const ritual = room.pending?.ritual;
        if (!ritual) break;
        if (ritual === 'guns_stash' && leader) {
          const t = rand(room.alivePlayers);
          room.cultDistributeGuns(leader.id, { [t.id]: Math.min(3, room.generalSupply) });
        } else if (ritual === 'cult_cabin_search' && leader) {
          room.cultAckCabinSearch(leader.id);
        } else if (ritual === 'conversion' && leader && leader.alive) {
          const convertible = room.alivePlayers.filter(p =>
            !p.examined && p.faction !== 'cult_leader' && p.faction !== 'cultist');
          if (convertible.length > 0) room.cultConvert(leader.id, rand(convertible).id);
          else room.cultSkipRitual(leader.id);
        } else {
          // cult_cabin_search يُحل تلقائياً، أو لا قائد حي
          if (room.pending) room.cultSkipRitual(leader?.id || room.captainId);
        }
        break;
      }
      default:
        throw new Error(`مرحلة غير متوقعة: ${room.phase}`);
    }
  }

  if (room.phase !== PHASES.GAME_OVER) {
    throw new Error(`اللعبة لم تنته بعد 500 خطوة! المرحلة: ${room.phase}`);
  }
  if (verbose) {
    console.log(`  ✓ ${numPlayers} لاعبين | الفائز: ${room.winner} | ${room.winReason}`);
  }
  return room.winner;
}

// ===== التشغيل =====
console.log('🐙 بدء اختبار المحاكاة...\n');

const stats = {};
let failures = 0;
const GAMES_PER_COUNT = 30;

for (let n = 5; n <= 11; n++) {
  for (let g = 0; g < GAMES_PER_COUNT; g++) {
    try {
      const winner = playOneGame(n, g === 0);
      stats[winner] = (stats[winner] || 0) + 1;
    } catch (e) {
      failures++;
      console.error(`  ✗ فشل (${n} لاعبين):`, e.message);
      if (failures > 5) { console.error('فشل كثير - توقف'); process.exit(1); }
    }
  }
}

console.log('\n===== النتائج =====');
console.log(`ألعاب ناجحة: ${7 * GAMES_PER_COUNT - failures}/${7 * GAMES_PER_COUNT}`);
console.log('توزيع الفوز:', stats);
console.log(failures === 0 ? '\n✅ كل الاختبارات نجحت!' : `\n⚠️ ${failures} فشل`);
process.exit(failures === 0 ? 0 : 1);
