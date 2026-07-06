process.env.RESOLVE_DELAY_MS = '0';
const { GameRoom } = require('../server/game/GameRoom');
const C = require('../server/game/constants');

async function testAppointAndCharacters() {
  console.log('Running comprehensive crash diagnosis test...');
  
  // Create a room with 6 players
  const room = new GameRoom('TEST', 'narrator', 'long');
  const players = [];
  for (let i = 0; i < 6; i++) {
    players.push(room.addPlayer(`Player${i + 1}`, `sock${i}`));
  }
  
  // Start the game
  room.start();

  // Force factions and characters for testing
  players[0].character = { id: 'minstrel', revealed: false };
  players[1].character = { id: 'agitator', revealed: false };
  players[2].character = { id: 'spiritualist', revealed: false };
  players[3].character = { id: 'instigator', revealed: false };

  function skipAllPendingExcept(exceptIds = []) {
    if (room.pausedForCharacters) {
      const pendingIds = Object.entries(room.pausedForCharacters.decisions)
        .filter(([_, status]) => status === 'pending')
        .map(([pid, _]) => pid);
      for (const pid of pendingIds) {
        if (!exceptIds.includes(pid)) {
          room.skipCharacterDecision(pid);
        }
      }
    }
  }

  room.finishGathering();
  skipAllPendingExcept();
  
  console.log('✓ Game started. Phase:', room.phase);
  
  // Appoint team
  const capId = room.captainId;
  const otherPlayers = players.filter(p => p.id !== capId);
  const ltId = otherPlayers[0].id;
  const navId = otherPlayers[1].id;
  room.appointTeam(capId, ltId, navId);
  skipAllPendingExcept([players[0].id, players[1].id]);
  console.log('✓ Team appointed. Phase:', room.phase);
  
  // Get active non-captain targets
  const nonCapTargets = players.filter(p => p.id !== capId);

  // Test Minstrel after appointing team
  console.log('Activating Minstrel...');
  room.activateCharacter(players[0].id, { targetIds: [nonCapTargets[0].id, nonCapTargets[1].id] });
  console.log('✓ Minstrel activated successfully');

  // Test Agitator
  console.log('Activating Agitator...');
  room.activateCharacter(players[1].id, { targetIds: [nonCapTargets[0].id, nonCapTargets[1].id] });
  console.log('✓ Agitator activated successfully');

  // Commit guns to transition phase
  console.log('Committing guns for players...');
  for (const p of nonCapTargets) {
    p.guns = 2;
    room.commitGuns(p.id, 0); // commit 0 for simplicity
  }
  room.revealMutiny();
  console.log('✓ Mutiny revealed. Phase:', room.phase);

  // Test Instigator
  console.log('Activating Instigator...');
  const instigatorPlayer = players[3];
  const target = nonCapTargets[2];
  target.guns = 3;
  const instigatorResult = room.activateCharacter(instigatorPlayer.id, { targetId: target.id });
  console.log('✓ Instigator activated successfully. Result:', instigatorResult);
  console.log('Target guns remaining:', target.guns); // should be 0
  if (target.guns !== 0) throw new Error('Target guns not reduced to 0');
  if (instigatorResult.secretFor !== target.id) throw new Error('Result secretFor must match target id');

  // Simulate yellow card drawn and played for Spiritualist
  room.nav = {
    played: { color: 'yellow', action: 'mermaid' }
  };
  console.log('Activating Spiritualist...');
  room.activateCharacter(players[2].id, { targetIds: [nonCapTargets[0].id, nonCapTargets[1].id], receiverId: capId });
  console.log('✓ Spiritualist activated successfully');

  console.log('All simulated actions completed without crashes!');
}

testAppointAndCharacters().catch(e => {
  console.error('Crash detected:', e.stack);
  process.exit(1);
});
