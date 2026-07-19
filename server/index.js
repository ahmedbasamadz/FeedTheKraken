// ============================================
// Feed the Kraken - Server
// Express + Socket.io
// ============================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { GameRoom } = require('./game/GameRoom');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));
app.get('/health', (_, res) => res.json({ ok: true }));

const rooms = new Map(); // code -> GameRoom

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// إرسال الحالة لكل من في الغرفة (كل واحد حسب صلاحياته)
function broadcast(room) {
  const pub = room.publicState();
  io.to(`narrator:${room.code}`).emit('state', { ...pub, narrator: room.narratorState() });
  io.to(`display:${room.code}`).emit('state', pub); // شاشات العرض: الحالة العامة فقط
  for (const p of room.players) {
    if (p.socketId) {
      io.to(p.socketId).emit('state', { ...pub, you: room.privateState(p.id) });
    }
  }
}

// تسليم نتيجة فيها معلومات سرية للشخص المعني فقط
function deliverResult(room, result) {
  if (!result) return;
  // [F06/Floging] بثّ الأحداث العامة (نتائج Map Actions العامة) كإشعار لكل الأطراف
  if (result.public) {
    io.to(`narrator:${room.code}`).emit('public_toast', {
      title: 'حدث هام على ظهر السفينة! ⚠️',
      message: result.public.message || JSON.stringify(result.public),
    });
    io.to(`display:${room.code}`).emit('public_toast', {
      title: 'حدث هام على ظهر السفينة! ⚠️',
      message: result.public.message || JSON.stringify(result.public),
    });
    for (const p of room.players) {
      if (p.socketId) {
        io.to(p.socketId).emit('public_toast', {
          title: 'حدث هام على ظهر السفينة! ⚠️',
          message: result.public.message || JSON.stringify(result.public),
        });
      }
    }
  }
  if (result.secretFor) {
    const target = room.player(result.secretFor);
    if (target?.socketId) io.to(target.socketId).emit('secret', result.info);
    io.to(`narrator:${room.code}`).emit('secret_log', { for: target?.name, info: result.info });
  }
  if (result.promptFor) {
    const target = room.player(result.promptFor);
    if (target?.socketId) io.to(target.socketId).emit('prompt', result.info);
  }
}

io.on('connection', (socket) => {
  let myRoom = null;
  let myPlayerId = null;
  let isNarrator = false;

  const safe = (handler) => (payload = {}, ack) => {
    try {
      const result = handler(payload);
      if (myRoom) broadcast(myRoom);
      if (ack) ack({ ok: true, ...((result && typeof result === 'object') ? result : {}) });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
      else socket.emit('error_msg', e.message);
    }
  };

  // ===== إنشاء/دخول الغرف =====

  socket.on('narrator:create_room', safe(({ mode } = {}) => {
    const code = genCode();
    const room = new GameRoom(code, socket.id, mode); // [توحيد الخرائط] Long فقط (mode يُتجاهل داخلياً)
    rooms.set(code, room);
    myRoom = room; isNarrator = true;
    socket.join(`narrator:${code}`);
    return { code };
  }));

  socket.on('player:create_room', safe(({ name } = {}) => {
    if (!name || name.trim().length < 1) throw new Error('أدخل اسماً');
    const code = genCode();
    const room = new GameRoom(code, null, 'long'); // narratorId is null
    rooms.set(code, room);
    const player = room.addPlayer(name.trim(), socket.id);
    myRoom = room; myPlayerId = player.id;
    socket.join(room.code);
    return { playerId: player.id, code: room.code };
  }));

  socket.on('narrator:reclaim', safe(({ code }) => {
    const room = rooms.get(code);
    if (!room) throw new Error('غرفة غير موجودة');
    if (room.narratorId === null) {
      throw new Error('هذه الغرفة بدون راوي وتلعب تلقائياً');
    }
    room.narratorId = socket.id;
    myRoom = room; isNarrator = true;
    socket.join(`narrator:${code}`);
    return { code };
  }));

  socket.on('player:join', safe(({ code, name }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) throw new Error('كود الغرفة غير صحيح');
    if (!name || name.trim().length < 1) throw new Error('أدخل اسماً');
    const player = room.addPlayer(name.trim(), socket.id);
    myRoom = room; myPlayerId = player.id;
    socket.join(room.code);
    return { playerId: player.id, code: room.code };
  }));

  socket.on('player:rejoin', safe(({ code, playerId }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) throw new Error('غرفة غير موجودة');
    const p = room.player(playerId);
    if (!p) throw new Error('لاعب غير موجود');
    p.socketId = socket.id;
    p.connected = true;
    myRoom = room; myPlayerId = playerId;
    socket.join(room.code);
    // [C04] إعادة بث سر المراقب عند إعادة الاتصال — ينجو من تحديث الصفحة
    if (room.lookoutPending && room.lookoutPending.playerId === playerId) {
      const top = room.drawPile[0];
      if (top && room.lookoutPending.card === top) {
        io.to(socket.id).emit('secret', { type: 'lookout', topCard: top });
      }
    }
    // إعادة بث عرض الأرشيفي عند إعادة الاتصال — ينجو من تحديث الصفحة
    if (room.archivistOffer && room.archivistOffer.targetId === playerId) {
      const offerer = room.player(room.archivistOffer.offeredById);
      io.to(socket.id).emit('prompt', {
        type: 'archivist_offer',
        from: offerer?.name || '؟',
        archivistId: room.archivistOffer.offeredById
      });
    }
    return { playerId };
  }));

  // شاشة عرض مشتركة (تلفزيون/شاشة كبيرة) - ترى الحالة العامة فقط
  socket.on('display:join', safe(({ code }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) throw new Error('كود الغرفة غير صحيح');
    myRoom = room;
    socket.join(`display:${room.code}`);
    return { code: room.code };
  }));

  // ===== سير اللعبة =====

  const requireNarrator = () => { if (!isNarrator) throw new Error('للراوي فقط'); };
  const requireRoom = () => { if (!myRoom) throw new Error('لست في غرفة'); return myRoom; };

  socket.on('narrator:start_game', safe(() => { requireNarrator(); requireRoom().start(); }));
  socket.on('narrator:finish_gathering', safe(() => { requireNarrator(); requireRoom().finishGathering(); }));

  socket.on('player:toggle_ready', safe(() => {
    const room = requireRoom();
    room.toggleReady(myPlayerId);
    broadcast(room);
  }));

  socket.on('captain:appoint', safe(({ ltId, navId }) =>
    requireRoom().appointTeam(myPlayerId, ltId, navId)));

  socket.on('player:commit_guns', safe(({ count }) =>
    requireRoom().commitGuns(myPlayerId, count)));

  socket.on('captain:reveal_mutiny', safe(() => {
    const room = requireRoom();
    if (myPlayerId !== room.captainId && !isNarrator) throw new Error('فقط القبطان أو الراوي');
    return room.revealMutiny();
  }));

  socket.on('captain:resolve_mutiny', safe(() => {
    const room = requireRoom();
    if (myPlayerId !== room.captainId && !isNarrator) throw new Error('فقط القبطان أو الراوي');
    return room.resolveMutinyOutcome();
  }));

  socket.on('captain:resolve_tie', safe(({ dropId }) =>
    requireRoom().resolveTieDrop(myPlayerId, dropId)));

  socket.on('captain:choose_card', safe(({ keepIndex }) =>
    requireRoom().captainChoose(myPlayerId, keepIndex)));

  socket.on('lt:choose_card', safe(({ keepIndex }) =>
    requireRoom().lieutenantChoose(myPlayerId, keepIndex)));

  socket.on('navigator:choose_card', safe((payload) => {
    const room = requireRoom();
    const keepIndex = payload.keepIndex !== undefined ? payload.keepIndex : (1 - payload.discardIndex);
    const result = room.navigatorChoose(myPlayerId, keepIndex);
    deliverResult(room, result);
    return result;
  }));

  socket.on('navigator:deny_command', safe(() =>
    requireRoom().denyCommand(myPlayerId)));

  socket.on('captain:emergency_navigator', safe(({ navId }) =>
    requireRoom().setEmergencyNavigator(myPlayerId, navId)));

  socket.on('captain:map_action', safe(({ targetId }) => {
    const room = requireRoom();
    const result = room.resolveMapAction(myPlayerId, targetId);
    deliverResult(room, result);
    return result;
  }));

  socket.on('captain:mermaid', safe(({ targetId }) => {
    const room = requireRoom();
    const result = room.resolveMermaid(myPlayerId, targetId);
    deliverResult(room, result);
    return result;
  }));

  socket.on('captain:telescope_pick', safe(({ targetId }) => {
    const room = requireRoom();
    const result = room.telescopePickPlayer(myPlayerId, targetId);
    deliverResult(room, result);
    return result;
  }));

  socket.on('player:telescope_decide', safe(({ discard }) =>
    requireRoom().telescopeDecide(myPlayerId, discard)));

  socket.on('cult:distribute_guns', safe(({ allocations }) =>
    requireRoom().cultDistributeGuns(myPlayerId, allocations)));

  socket.on('cult:convert', safe(({ targetId }) => {
    const room = requireRoom();
    const result = room.cultConvert(myPlayerId, targetId);
    deliverResult(room, result);
    return result;
  }));

  socket.on('cult:ack', safe(() => requireRoom().cultAckCabinSearch(myPlayerId))); // [إصلاح #11]

  socket.on('cult:skip', safe(() => requireRoom().cultSkipRitual(myPlayerId)));

  socket.on('character:activate', safe((payload) => {
    const room = requireRoom();
    const result = room.activateCharacter(myPlayerId, payload);
    deliverResult(room, result);
    return result;
  }));

  socket.on('character:skip_decision', safe(() => {
    const room = requireRoom();
    const result = room.skipCharacterDecision(myPlayerId);
    deliverResult(room, result);
    return result;
  }));

  socket.on('character:skip_spiritualist', safe(() =>
    requireRoom().skipSpiritualist(myPlayerId)));

  socket.on('character:instigator_response', safe(({ instigatorId, accepted }) =>
    requireRoom().instigatorResponse(instigatorId, myPlayerId, accepted)));

  socket.on('archivist:respond', safe(({ accept }) =>
    requireRoom().archivistRespond(myPlayerId, !!accept)));

  // ===== أدوات الراوي =====

  socket.on('narrator:override', safe(({ action, payload }) => {
    requireNarrator();
    requireRoom().narratorOverride(action, payload);
  }));

  socket.on('disconnect', () => {
    if (myRoom && myPlayerId) {
      const p = myRoom.player(myPlayerId);
      if (p) { p.connected = false; broadcast(myRoom); }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🐙 Feed the Kraken server on :${PORT}`));
