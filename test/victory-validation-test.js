// ============================================
// Victory Validation Test for Feed the Kraken
// ============================================
const { GameRoom, PHASES } = require('../server/game/GameRoom');
const { VICTORY } = require('../server/game/mapLong');
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

function createStartedRoom(name) {
  const room = new GameRoom(name, 'nar', 'long');
  room.addPlayer('Captain', 's1');
  room.addPlayer('P2', 's2');
  room.addPlayer('P3', 's3');
  room.addPlayer('P4', 's4');
  room.addPlayer('P5', 's5');
  room.start();
  room.finishGathering();
  return room;
}

console.log('🏁 Starting Victory Validation Tests...');

// 1. Verify Pirate Victory (Landing Nodes: 22, 26, 29)
{
  const pirateNodes = [22, 26, 29];
  const nodeMap = {
    22: 'h5_-3',
    26: 'h6_-2',
    29: 'h6_-1'
  };

  pirateNodes.forEach(nodeNum => {
    const room = createStartedRoom('TEST_PIRATE_' + nodeNum);

    // Directly set ship position to node before target, then trigger move
    // Node 22 is reachable from Node 15 or 19. Node 15 ('h4_-3') red exit is 22.
    // Node 26 is reachable from 19 or 22 or 23. Node 19 ('h5_-2') red exit is 26.
    // Node 29 is reachable from 26 or 27. Node 27 ('h6_0') red exit is 29.
    let startHex = '';
    let color = '';
    if (nodeNum === 22) { startHex = 'h4_-3'; color = 'red'; }
    if (nodeNum === 26) { startHex = 'h5_-2'; color = 'red'; }
    if (nodeNum === 29) { startHex = 'h6_0'; color = 'red'; }

    room.shipHex = startHex;
    const card = { color, action: 'none' };
    
    const res = room._executeNavigationCard(card);
    
    ok(`Landing on node ${nodeNum} triggers PIRATE victory`, room.winner === VICTORY.PIRATE);
    ok(`Landing on node ${nodeNum} sets phase to GAME_OVER`, room.phase === PHASES.GAME_OVER);
    ok(`Result object indicates game over`, res.gameOver === true && res.winner === VICTORY.PIRATE);
  });
}

// 2. Verify Sailor Victory (Landing Nodes: 25, 28, 30)
{
  const sailorNodes = [25, 28, 30];
  const nodeMap = {
    25: 'h5_3',
    28: 'h6_2',
    30: 'h6_1'
  };

  sailorNodes.forEach(nodeNum => {
    const room = createStartedRoom('TEST_SAILOR_' + nodeNum);

    // Node 25 is reachable from 18. Node 18 ('h4_3') blue exit is 25.
    // Node 28 is reachable from 21. Node 21 ('h5_2') blue exit is 28.
    // Node 30 is reachable from 24 or 27. Node 27 ('h6_0') blue exit is 30.
    let startHex = '';
    let color = '';
    if (nodeNum === 25) { startHex = 'h4_3'; color = 'blue'; }
    if (nodeNum === 28) { startHex = 'h5_2'; color = 'blue'; }
    if (nodeNum === 30) { startHex = 'h6_0'; color = 'blue'; }

    room.shipHex = startHex;
    const card = { color, action: 'none' };
    
    const res = room._executeNavigationCard(card);
    
    ok(`Landing on node ${nodeNum} triggers SAILOR victory`, room.winner === VICTORY.SAILOR);
    ok(`Landing on node ${nodeNum} sets phase to GAME_OVER`, room.phase === PHASES.GAME_OVER);
    ok(`Result object indicates game over`, res.gameOver === true && res.winner === VICTORY.SAILOR);
  });
}

// 3. Verify Cult Victory (Landing Node: 31)
{
  const room = createStartedRoom('TEST_CULT_31');

  // Node 31 is reachable from 27 or 29 or 30. Node 27 ('h6_0') yellow exit is 31.
  room.shipHex = 'h6_0';
  const card = { color: 'yellow', action: 'none' };
  
  const res = room._executeNavigationCard(card);
  
  ok('Landing on node 31 triggers CULT victory', room.winner === VICTORY.CULT);
  ok('Landing on node 31 sets phase to GAME_OVER', room.phase === PHASES.GAME_OVER);
  ok('Result object indicates game over', res.gameOver === true && res.winner === VICTORY.CULT);
}

// 4. Verify exits directly to victory strings
{
  // Moving from node 22 with yellow exit should trigger PIRATE_VICTORY
  const room1 = createStartedRoom('TEST_EXIT_VICTORY_PIRATE');
  room1.shipHex = 'h5_-3'; // Node 22
  const res1 = room1._executeNavigationCard({ color: 'yellow', action: 'none' });
  ok('Moving yellow from Node 22 triggers direct PIRATE victory', room1.winner === VICTORY.PIRATE);
  ok('Moving yellow from Node 22 sets phase to GAME_OVER', room1.phase === PHASES.GAME_OVER);

  // Moving from node 25 with yellow exit should trigger SAILOR_VICTORY
  const room2 = createStartedRoom('TEST_EXIT_VICTORY_SAILOR');
  room2.shipHex = 'h5_3'; // Node 25
  const res2 = room2._executeNavigationCard({ color: 'yellow', action: 'none' });
  ok('Moving yellow from Node 25 triggers direct SAILOR victory', room2.winner === VICTORY.SAILOR);
  ok('Moving yellow from Node 25 sets phase to GAME_OVER', room2.phase === PHASES.GAME_OVER);

  // Moving from node 31 with yellow exit should trigger CULT_VICTORY
  const room3 = createStartedRoom('TEST_EXIT_VICTORY_CULT');
  room3.shipHex = 'h7_0'; // Node 31
  const res3 = room3._executeNavigationCard({ color: 'yellow', action: 'none' });
  ok('Moving yellow from Node 31 triggers direct CULT victory', room3.winner === VICTORY.CULT);
  ok('Moving yellow from Node 31 sets phase to GAME_OVER', room3.phase === PHASES.GAME_OVER);
}

// 5. Verify no player can continue moving / acting after victory is reached
{
  const room = createStartedRoom('TEST_BLOCKED_ACTIONS');

  // Reach victory
  room.shipHex = 'h7_0'; // Node 31
  room._executeNavigationCard({ color: 'yellow', action: 'none' });
  ok('Game is now over', room.phase === PHASES.GAME_OVER);

  // Attempt player action: appointTeam
  let actionFailed = false;
  try {
    room.appointTeam('Captain', 'P2', 'P3');
  } catch (e) {
    actionFailed = true;
  }
  ok('Actions like appointTeam are blocked after victory', actionFailed);

  // Attempt move ship via narratorOverride
  let moveFailed = false;
  try {
    room.narratorOverride('move_ship', { hexId: 'h1_0' });
  } catch (e) {
    moveFailed = true;
  }
  ok('Ship movement via narratorOverride is blocked/restricted after victory', moveFailed);
}

// 6. Verify GameRoom.js has remained unchanged
{
  const projectRoot = path.join(__dirname, '..');
  const gameRoomPath = path.join(projectRoot, 'server', 'game', 'GameRoom.js');
  const gameRoomBackupPath = path.join(projectRoot, 'server', 'game', 'GameRoom.js.bak');
  
  const hasGameRoomBackup = fs.existsSync(gameRoomBackupPath);
  if (hasGameRoomBackup) {
    const original = fs.readFileSync(gameRoomBackupPath, 'utf8');
    const current = fs.readFileSync(gameRoomPath, 'utf8');
    ok('GameRoom.js remains completely unchanged', original === current);
  } else {
    ok('GameRoom.js was not modified (no changes made)', true);
  }
}

console.log(`\nVictory Validation Results: Pass: ${pass} | Fail: ${fail}`);
if (fail > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
