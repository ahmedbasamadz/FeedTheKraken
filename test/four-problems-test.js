process.env.RESOLVE_DELAY_MS = '0';
const { GameRoom } = require('../server/game/GameRoom');
const C = require('../server/game/constants');

async function testGunsClamping() {
  console.log('🐙 Testing player guns clamping and safety protections...');

  // Create a room with 6 players
  const room = new GameRoom('TEST', 'narrator', 'long');
  const players = [];
  for (let i = 0; i < 6; i++) {
    players.push(room.addPlayer(`Player${i + 1}`, `sock${i}`));
  }
  
  // Start the game
  room.start();

  function skipAllPending() {
    if (room.pausedForCharacters) {
      const pendingIds = Object.entries(room.pausedForCharacters.decisions)
        .filter(([_, status]) => status === 'pending')
        .map(([pid, _]) => pid);
      for (const pid of pendingIds) {
        room.skipCharacterDecision(pid);
      }
    }
  }

  room.finishGathering();
  skipAllPending();

  const captain = room.players.find(p => p.id === room.captainId);
  const nonCaptains = room.players.filter(p => p.id !== room.captainId);
  const player1 = nonCaptains[0];
  const player2 = nonCaptains[1];

  console.log(`Captain identified: ${captain.name}`);
  console.log(`Test players identified: ${player1.name}, ${player2.name}`);

  // 1. Verify initial guns count
  console.log(`Initial guns: ${player1.name} has ${player1.guns} guns.`);
  if (player1.guns !== C.STARTING_GUNS) {
    throw new Error(`Expected starting guns to be ${C.STARTING_GUNS}, got ${player1.guns}`);
  }

  // 2. Simulate mutiny commitment and theft scenario (Problem 1)
  console.log('\n--- Test Case: Mutiny + Theft Target Validation & Clamping ---');
  room.appointTeam(room.captainId, nonCaptains[2].id, nonCaptains[3].id);
  skipAllPending();
  
  // Players commit guns
  // Let player1 commit 2 guns
  player1.guns = 2;
  room.commitGuns(player1.id, 2);

  // Let player2 commit 1 gun
  room.commitGuns(player2.id, 1);

  // Other players commit 0
  for (const p of room.players) {
    if (p.id !== room.captainId && p.id !== player1.id && p.id !== player2.id) {
      room.commitGuns(p.id, 0);
    }
  }

  // Verify player1 uncommitted guns is 0 (he had 2 and committed 2)
  const uncommitted = room._getUncommittedGuns(player1);
  console.log(`Player1 uncommitted guns: ${uncommitted} (Expected: 0)`);
  if (uncommitted !== 0) {
    throw new Error(`Expected uncommitted guns to be 0, got ${uncommitted}`);
  }

  // Try to use Kleptomaniac to steal 1 gun from player1 BEFORE mutiny is resolved
  // This should throw an error since player1 has 0 uncommitted guns.
  player2.character = { id: 'kleptomaniac', revealed: false };
  
  let didThrow = false;
  try {
    room.activateCharacter(player2.id, { targetId: player1.id });
  } catch (e) {
    didThrow = true;
    console.log(`✓ Got expected target validation error when stealing committed guns: "${e.message}"`);
  }

  if (!didThrow) {
    throw new Error('Expected Kleptomaniac activation to be blocked and throw an error when stealing committed guns!');
  }

  // Now, let's test successful stealing when the player actually has uncommitted guns.
  // Give player1 1 extra gun (total = 3, committed = 2, uncommitted = 1)
  player1.guns = 3;
  console.log(`\nBefore Kleptomaniac (with 1 uncommitted gun): ${player1.name} has ${player1.guns} guns.`);
  
  room.activateCharacter(player2.id, { targetId: player1.id });
  console.log(`After Kleptomaniac: ${player1.name} has ${player1.guns} guns (committed: 2).`);
  if (player1.guns !== 2) {
    throw new Error(`Expected player1 guns to be 2 after theft of 1 uncommitted gun, got ${player1.guns}`);
  }

  // Reveal and resolve mutiny (this will deduct the 2 committed guns from player1)
  room.revealMutiny();
  skipAllPending();
  room.resolveMutinyOutcome(); // Deduct 2 from player1 (2 - 2 = 0)

  console.log(`After Mutiny resolved: ${player1.name} has ${player1.guns} guns.`);
  if (player1.guns !== 0) {
    throw new Error(`Expected player1 guns to be 0, got ${player1.guns}`);
  }
  console.log('✓ Successfully resolved mutiny and clamped guns correctly!');

  // 3. Test DISARMED clamping
  console.log('\n--- Test Case: Disarmed clamping ---');
  player1.guns = 0;
  room.navigatorId = player1.id;
  room._executeCardAction({ color: 'red', action: C.NAV_ACTIONS.DISARMED }); // Should disarm navigator
  
  if (player1.guns !== 0) {
    throw new Error(`Expected navigator guns to stay at 0, got ${player1.guns}`);
  }
  console.log('✓ Successfully clamped navigator guns to 0 on disarmed action!');

  // 4. Test Narrator Override negative input clamping
  console.log('\n--- Test Case: Narrator set_guns negative input clamping ---');
  room.narratorOverride('set_guns', { playerId: player1.id, guns: -5 });
  if (player1.guns !== 0) {
    throw new Error(`Expected narrator override set_guns negative value to clamp to 0, got ${player1.guns}`);
  }
  console.log('✓ Successfully clamped negative narrator set_guns inputs to 0!');

  console.log('\n✅ All gun safety and validation tests passed successfully!');
  process.exit(0);
}

testGunsClamping().catch(e => {
  console.error('✗ Test failed:', e.stack);
  process.exit(1);
});
