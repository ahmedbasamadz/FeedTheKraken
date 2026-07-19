process.env.RESOLVE_DELAY_MS = '0';
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
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
  console.log('🐙 Testing player-created room and auto-ready-check starting...');

  // Start player 1 who creates the room
  const p1 = io(URL);
  let p1State = null;
  p1.on('state', s => { p1State = s; });
  await new Promise(r => p1.on('connect', r));

  const { code, playerId: p1Id } = await emit(p1, 'player:create_room', { name: 'القائد' });
  console.log(`✓ Room created by player: ${code}`);

  // Connect 4 more players to make it 5 players total
  const players = [{ sock: p1, playerId: p1Id }];
  for (let i = 1; i < 5; i++) {
    const sock = io(URL);
    await new Promise(r => sock.on('connect', r));
    const { playerId } = await emit(sock, 'player:join', { code, name: `لاعب ${i + 1}` });
    players.push({ sock, playerId });
  }
  console.log('✓ 5 players joined total');

  await sleep(100);
  console.log(`Current phase: ${p1State.phase} (expected: lobby)`);
  if (p1State.phase !== 'lobby') throw new Error('Expected phase to be lobby');

  // Verify room reports hasNarrator as false
  console.log(`Room has narrator: ${p1State.hasNarrator} (expected: false)`);
  if (p1State.hasNarrator) throw new Error('Expected hasNarrator to be false');

  // Toggle ready for 4 players
  for (let i = 0; i < 4; i++) {
    await emit(players[i].sock, 'player:toggle_ready');
  }
  await sleep(100);

  // Phase should still be lobby (waiting for 5th player)
  console.log(`Phase after 4 players ready: ${p1State.phase} (expected: lobby)`);
  if (p1State.phase !== 'lobby') throw new Error('Expected phase to stay lobby until all ready');
  console.log(`Ready players count: ${p1State.readyPlayerIds.length} / 5`);

  // Toggle ready for 5th player
  console.log('Toggling 5th player ready...');
  await emit(players[4].sock, 'player:toggle_ready');
  await sleep(150);

  // Phase should now be pirate_gathering
  console.log(`Phase after 5 players ready: ${p1State.phase} (expected: pirate_gathering)`);
  if (p1State.phase !== 'pirate_gathering') throw new Error('Expected phase to transition to pirate_gathering');

  // Now, toggle ready for gathering phase
  console.log('Ready check for pirate gathering...');
  for (let i = 0; i < 5; i++) {
    await emit(players[i].sock, 'player:toggle_ready');
  }
  await sleep(150);

  // Phase should now be appoint_team
  console.log(`Phase after gathering ready check: ${p1State.phase} (expected: appoint_team)`);
  if (p1State.phase !== 'appoint_team') throw new Error('Expected phase to transition to appoint_team');

  console.log('✅ Player ready check and auto-start test passed successfully');
  
  // Clean up
  players.forEach(p => p.sock.close());
  process.exit(0);
}

main().catch(e => {
  console.error('✗ Test failed:', e.message);
  process.exit(1);
});
