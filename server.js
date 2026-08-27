const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { questionBanks, DIFFICULTIES, CPU_ID, DISCONNECT_GRACE_MS } = require('./gameData');
const Room = require('./room');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

// ---- 部屋(Room)管理 ----
// 今はまだ複数部屋のUIがないため、起動時に1つだけ既定の部屋を作り、接続してきた
// ソケットは全員この部屋に入れる（今までと同じ「サーバー全体で1ゲーム」の挙動）。
// 将来、部屋の作成・選択機能を追加する際はここ（server.js）だけを変更すればよい。
const DEFAULT_ROOM_ID = 'default';
const rooms = new Map();
rooms.set(DEFAULT_ROOM_ID, new Room(DEFAULT_ROOM_ID, io));

function getRoomForSocket(socket) {
  return rooms.get(socket.data.roomId);
}

// プレイヤーが部屋からいなくなった直後（切断の猶予切れ、または明示的な離脱）に
// 進行中のラウンドを止めないための共通処理。「部屋の設定画面に戻る」場合はそのまま
// broadcastStateするだけでよい。
function handlePlayerDeparture(room, wasBuzzed) {
  if (!room.started) {
    room.broadcastState();
    return;
  }
  if (wasBuzzed) {
    room.cancelLetterTimer();
    room.buzzedId = null;
    room.resolvedCount = 0;
    room.letterChoices = [];
    if (room.lockedOut.size >= room.connectedPlayerCount()) {
      room.enterReveal();
    } else {
      room.phase = 'open';
      room.scheduleNoBuzzTimer();
      room.broadcastState();
      room.scheduleCpuBuzzIfNeeded();
    }
  } else if (room.phase === 'open' && room.connectedPlayerCount() > 0 && room.lockedOut.size >= room.connectedPlayerCount()) {
    room.enterReveal();
  } else {
    room.broadcastState();
  }
}

// トレーニング部屋（持ち主1人＋CPU専用）が空になったら、作りっぱなしにせず消す。
function destroyTrainingRoomIfEmpty(room) {
  if (!room.isTraining || room.hasConnectedHuman()) return;
  room.cancelAllTimers();
  rooms.delete(room.id);
}

io.on('connection', (socket) => {
  // 接続した瞬間に（joinイベントを送るより前でも）部屋に入れておく。これは今までの
  // 「サーバーに繋がっている全ソケットに配信する」という挙動を厳密に保つため。
  socket.data.roomId = DEFAULT_ROOM_ID;
  socket.join(DEFAULT_ROOM_ID);

  // clientIdはブラウザ（localStorage）に保存された永続的な識別子。名前ではなくこれで
  // 同一人物を判定するので、再接続（画面ロック・電波切れ等でのsocket再接続）してもスコアを
  // 引き継げる。socket.idは接続のたびに変わるため、識別には使わない。
  socket.on('join', (payload) => {
    const { name, clientId, mode } = payload || {};
    const id = (typeof clientId === 'string' && clientId.trim()) ? clientId.trim().slice(0, 100) : null;
    if (!id) return; // clientIdを送ってこない不正なクライアントは参加させない

    // トレーニングモードは「持ち主(clientId)専用の部屋」に入れる。まだ無ければここで作る。
    // フレンド対戦モードは今まで通り全員が入る既定の部屋のまま。
    const targetRoomId = mode === 'training' ? `training:${id}` : DEFAULT_ROOM_ID;
    if (socket.data.roomId !== targetRoomId) {
      socket.leave(socket.data.roomId);
      if (mode === 'training' && !rooms.has(targetRoomId)) {
        const trainingRoom = new Room(targetRoomId, io);
        trainingRoom.isTraining = true;
        rooms.set(targetRoomId, trainingRoom);
      }
      socket.data.roomId = targetRoomId;
      socket.join(targetRoomId);
    }

    const room = getRoomForSocket(socket);
    if (!room) return;

    socket.data.clientId = id;
    room.socketIdByClientId.set(id, socket.id);

    const cleanName = (name || '').toString().trim().slice(0, 20) || `プレイヤー${id.slice(0, 4)}`;
    const existing = room.players.get(id);
    if (existing) {
      existing.name = cleanName;
      existing.connected = true;
      if (existing.disconnectTimer) {
        clearTimeout(existing.disconnectTimer);
        existing.disconnectTimer = null;
      }
    } else {
      room.players.set(id, { name: cleanName, score: 0, connected: true, disconnectTimer: null });
    }
    room.broadcastState();
  });

  // 「モード選択に戻る」で明示的に部屋を離れる。画面ロック等の一時切断とは違い、
  // 猶予時間を待たずすぐにプレイヤーを消し、トレーニング部屋なら空になり次第すぐ破棄する。
  socket.on('leave', () => {
    const room = getRoomForSocket(socket);
    if (room) {
      const clientId = socket.data.clientId;
      socket.leave(room.id);
      if (clientId && room.players.has(clientId)) {
        const p = room.players.get(clientId);
        if (p && p.disconnectTimer) clearTimeout(p.disconnectTimer);
        const wasBuzzed = room.buzzedId === clientId;
        room.players.delete(clientId);
        room.socketIdByClientId.delete(clientId);
        handlePlayerDeparture(room, wasBuzzed);
      }
      destroyTrainingRoomIfEmpty(room);
    }
    socket.data.clientId = null;
    socket.data.roomId = DEFAULT_ROOM_ID;
    socket.join(DEFAULT_ROOM_ID);
  });

  socket.on('game:setDifficulty', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { difficulty: d } = payload || {};
    if (!room.players.has(socket.data.clientId) || room.started) return;
    if (!DIFFICULTIES.includes(d)) return;
    room.difficulty = d;
    room.broadcastState();
  });

  socket.on('game:setCpu', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { enabled } = payload || {};
    if (!room.players.has(socket.data.clientId) || room.started) return;
    if (enabled) {
      if (!room.players.has(CPU_ID)) room.players.set(CPU_ID, { name: 'CPU', score: 0, connected: true });
    } else {
      room.players.delete(CPU_ID);
    }
    room.broadcastState();
  });

  socket.on('game:setWinScore', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { winScore } = payload || {};
    if (!room.players.has(socket.data.clientId) || room.started) return;
    const n = Number(winScore);
    if (!Number.isInteger(n) || n < 0 || n > 99) return;
    room.winScore = n;
    room.broadcastState();
  });

  socket.on('game:setQuestionLimit', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { questionLimit } = payload || {};
    if (!room.players.has(socket.data.clientId) || room.started) return;
    const n = Number(questionLimit);
    if (!Number.isInteger(n) || n < 0 || n > 99) return;
    room.questionLimit = n;
    room.broadcastState();
  });

  socket.on('game:start', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (!room.players.has(socket.data.clientId) || room.started) return;
    if (questionBanks[room.difficulty].length === 0) return; // 問題が1問もない難易度では開始できない
    room.started = true;
    room.lockedOut.clear();
    room.drawAndOpenNextQuestion();
  });

  socket.on('game:end', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (!room.players.has(socket.data.clientId) || !room.started) return;
    room.cancelAllTimers();
    room.started = false;
    room.phase = 'open';
    room.question = '';
    room.questionNumber = 0;
    room.answer = '';
    room.displayAnswer = '';
    room.currentDistractors = [];
    room.resolvedCount = 0;
    room.letterChoices = [];
    room.revealedAnswer = '';
    room.revealedInput = '';
    room.buzzedId = null;
    room.wrongLetterChoice = null;
    room.wrongTimedOut = false;
    room.lastBuzzerId = null;
    room.lastBuzzerReactionMs = null;
    room.questionRevealedMs = 0;
    room.questionTypingStartedAt = null;
    room.questionOpenedAt = null;
    room.lockedOut.clear();
    for (const p of room.players.values()) p.score = 0; // 次に始めるときはスコア0からにする
    room.shuffledQueues.A = [];
    room.shuffledQueues.B = [];
    room.shuffledQueues.C = []; // 出題履歴もリセットして、次回また1からシャッフルし直す
    room.broadcastState();
  });

  socket.on('player:buzz', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (!room.started || room.phase !== 'open') return;
    const clientId = socket.data.clientId;
    if (!clientId || !room.players.has(clientId)) return;
    if (room.lockedOut.has(clientId)) return;
    room.cancelCpuTimer();
    room.cancelNoBuzzTimer();
    room.pauseQuestionTyping();
    room.buzzedId = clientId;
    room.lastBuzzerId = clientId;
    room.lastBuzzerReactionMs = room.questionOpenedAt !== null ? Date.now() - room.questionOpenedAt : null;
    room.resolvedCount = 0;
    room.isFirstLetterPick = true;
    room.phase = 'buzzed';
    room.advanceLetterOrFinish();
  });

  socket.on('player:answer', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { choice } = payload || {};
    if (!room.started || room.phase !== 'buzzed' || socket.data.clientId !== room.buzzedId) return;
    if (typeof choice !== 'string' || !room.letterChoices.includes(choice)) return;
    room.resolveLetterChoice(choice);
  });

  socket.on('disconnect', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const clientId = socket.data.clientId;
    if (!clientId || !room.players.has(clientId)) return;
    // 既に同じclientIdで新しいソケットが繋ぎ直していたら（再接続が先に完了していたら）、
    // この古いソケットの切断イベントは無視する（誤ってプレイヤーを消してしまわないように）。
    if (room.socketIdByClientId.get(clientId) !== socket.id) return;
    room.socketIdByClientId.delete(clientId);

    const wasBuzzed = room.buzzedId === clientId;

    // プレイヤーはすぐには削除せず、DISCONNECT_GRACE_MSだけ猶予を持たせる。
    // その間に同じclientIdで再参加（join）すればスコアを維持したまま復帰できる。
    const p = room.players.get(clientId);
    if (p) {
      p.connected = false;
      p.disconnectTimer = setTimeout(() => {
        room.players.delete(clientId);
        room.broadcastState();
        destroyTrainingRoomIfEmpty(room);
      }, DISCONNECT_GRACE_MS);
    }

    // connectedPlayerCount()が0のときはlockedOut.size(0以上)が必ずそれ以上になるので、
    // 自然にenterReveal()に入る（＝誰もいなくても自動進行し続け、後で誰か参加/再接続
    // したときに止まったままにならない。以前はここで無条件にopenへ戻すだけの特別扱いを
    // していて、そのままだと再開後の自動進行タイマーが一切スケジュールされず、
    // ラウンドが永久に止まってしまうバグがあった）。
    handlePlayerDeparture(room, wasBuzzed);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`早押しクイズサーバー起動: http://localhost:${PORT}`);
});
