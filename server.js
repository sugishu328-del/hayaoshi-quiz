require('dotenv').config();
const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { questionBanks, DIFFICULTIES, CPU_ID, DISCONNECT_GRACE_MS, ICON_CHOICES } = require('./gameData');
const Room = require('./room');
const { upsertPlayer, submitReport, addBlock, removeBlock, getBlockList, deleteAccount, uploadIcon } = require('./supabase');

// アップロード画像アイコンの公開URLはこのプレフィックス配下のものだけを受け付ける
// （他ドメインの画像URLを自由に送りつけられて表示させられてしまうのを防ぐため）。
const ICON_URL_PREFIX = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/storage/v1/object/public/avatars/` : null;
function isValidIcon(icon) {
  if (typeof icon !== 'string') return false;
  if (ICON_CHOICES.includes(icon)) return true;
  return !!ICON_URL_PREFIX && icon.startsWith(ICON_URL_PREFIX);
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

// ---- 部屋(Room)管理 ----
// トレーニング部屋は`training:${clientId}`、フレンド部屋は`friend:${合言葉}`をキーにして
// 動的に作る（起動時に部屋を作っておく必要はない）。
const rooms = new Map();

// トレーニング部屋・フレンド部屋はどちらも誰でも作れてしまうため、無制限に増え続けて
// メモリを圧迫できないよう、同時に存在できる数の上限を設ける。あくまで異常事態向けの
// 緊急ブレーキであり、正常な利用者数を制限する値ではない（Room 1つのメモリ消費はごく小さいため
// 大きめに取ってある）。
const MAX_DYNAMIC_ROOMS = 5000;

// 同一IPからの部屋「新規作成」だけを対象にした頻度制限（既存部屋への再参加・合言葉での
// 参加は対象外）。学校や家庭など同じIPを複数人で共有している状況でも困らないよう、
// 余裕を持った値にしてある。
const ROOM_CREATION_WINDOW_MS = 60000;
const ROOM_CREATION_MAX_PER_WINDOW = 20;
const roomCreationTimestamps = new Map(); // ip -> 直近の作成時刻の配列

// フレンド部屋の合言葉に使う文字。0/O、1/I/Lのような紛らわしい文字は誤入力を防ぐため除外する。
const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 4;
function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(`friend:${code}`)); // 衝突（既に使われている合言葉）を避ける
  return code;
}

function getClientIp(socket) {
  // Renderなどのリバースプロキシ配下では実際の接続元IPがX-Forwarded-Forに入る。
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return socket.handshake.address;
}

function canCreateRoom(ip) {
  const now = Date.now();
  const timestamps = (roomCreationTimestamps.get(ip) || []).filter(
    (t) => now - t < ROOM_CREATION_WINDOW_MS
  );
  if (timestamps.length >= ROOM_CREATION_MAX_PER_WINDOW) {
    roomCreationTimestamps.set(ip, timestamps);
    return false;
  }
  timestamps.push(now);
  roomCreationTimestamps.set(ip, timestamps);
  return true;
}

function getRoomForSocket(socket) {
  return rooms.get(socket.data.roomId);
}

// hostIdが設定されている部屋（フレンド部屋）では、そのclientId以外は設定操作を拒否する。
// hostIdが未設定（何らかの理由で不在）の場合は、誰も操作できなくならないよう全員に開放する。
function isHost(room, socket) {
  return !room.hostId || room.hostId === socket.data.clientId;
}

// ホストが部屋からいなくなったら、残っている中で一番早く入室した人（Mapの挿入順で先頭）に
// ホストを引き継ぐ。誰も残っていなければnullに戻す。
function reassignHostIfNeeded(room, departedClientId) {
  if (room.hostId !== departedClientId) return;
  const next = [...room.players.keys()].find((k) => k !== CPU_ID);
  room.hostId = next || null;
}

// 同じ部屋の中で表示名が誰かとかぶったら「名前2」「名前3」のように連番を振って区別できるようにする
// （ゲストは全員「ゲスト」になるため、フレンド対戦で複数人ゲストが揃うと見分けがつかなくなる対策）。
// 自分自身の既存エントリ（再接続・名前変更なし）は衝突相手として数えない。
function dedupePlayerName(room, clientId, name) {
  const taken = new Set(
    [...room.players.entries()].filter(([id]) => id !== clientId).map(([, p]) => p.name)
  );
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name}${n}`)) n++;
  return `${name}${n}`;
}

// プレイヤーを部屋から取り除く共通処理（切断猶予切れ・明示的な離脱・モード切替のどれからも呼ぶ）。
// 呼び出し元は返り値のwasBuzzedをhandlePlayerDeparture()に渡すこと。
function removePlayer(room, clientId) {
  const p = room.players.get(clientId);
  if (p && p.disconnectTimer) clearTimeout(p.disconnectTimer);
  const wasBuzzed = room.buzzedId === clientId;
  room.players.delete(clientId);
  room.socketIdByClientId.delete(clientId);
  reassignHostIfNeeded(room, clientId);
  return wasBuzzed;
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

// 動的に作られた部屋（トレーニング・フレンドどちらも）が空になったら、作りっぱなしにせず消す。
function destroyRoomIfEmpty(room) {
  if (room.hasConnectedHuman()) return;
  room.cancelAllTimers();
  rooms.delete(room.id);
}

io.on('connection', (socket) => {
  // 接続直後（＝まだjoinイベントを送っていない間）はどの部屋にも属さない。
  // 参加画面で名前・モードを選んでjoinを送るまでは、何も配信する必要がないため。

  // 1接続からのイベント連打で同じ部屋の全員に負荷をかけられないよう、簡易的なレート制限をかける。
  const eventTimestamps = [];
  const RATE_LIMIT_WINDOW_MS = 1000;
  const RATE_LIMIT_MAX_EVENTS = 20;
  function isRateLimited() {
    const now = Date.now();
    while (eventTimestamps.length > 0 && now - eventTimestamps[0] >= RATE_LIMIT_WINDOW_MS) {
      eventTimestamps.shift();
    }
    eventTimestamps.push(now);
    return eventTimestamps.length > RATE_LIMIT_MAX_EVENTS;
  }
  function onLimited(event, handler) {
    socket.on(event, (...args) => {
      if (isRateLimited()) return;
      handler(...args);
    });
  }

  // clientIdはブラウザ（localStorage）に保存された永続的な識別子。名前ではなくこれで
  // 同一人物を判定するので、再接続（画面ロック・電波切れ等でのsocket再接続）してもスコアを
  // 引き継げる。socket.idは接続のたびに変わるため、識別には使わない。
  onLimited('join', (payload) => {
    const { name, clientId, mode, icon, code } = payload || {};
    const id = (typeof clientId === 'string' && clientId.trim()) ? clientId.trim().slice(0, 100) : null;
    if (!id || id === CPU_ID) return; // clientIdを送ってこない不正なクライアント、CPU用の予約IDは参加させない
    // アイコンは決められた絵文字一覧、またはicon:uploadで発行した自分のアップロード画像URL
    // のみ受け付ける（自由な文字列や他ドメインの画像URLを表示させられてしまうのを防ぐため）。
    // ゲスト参加時などはnullのまま（=名前の頭文字を表示）。
    const cleanIcon = isValidIcon(icon) ? icon : null;
    const cleanCode = typeof code === 'string' ? code.trim().toUpperCase().slice(0, 8) : '';

    // トレーニングモードは「持ち主(clientId)専用の部屋」。フレンド対戦モードは合言葉ごとの部屋で、
    // 合言葉を指定すれば既存の部屋に参加、指定しなければ新しい部屋（新しい合言葉）を作る。
    let targetRoomId;
    if (mode === 'training') {
      targetRoomId = `training:${id}`;
    } else if (mode === 'friend' && cleanCode) {
      targetRoomId = `friend:${cleanCode}`;
      if (!rooms.has(targetRoomId)) {
        socket.emit('join:error', { reason: 'not_found' }); // その合言葉の部屋が存在しない
        return;
      }
    } else if (mode === 'friend' && !cleanCode) {
      if (rooms.size > MAX_DYNAMIC_ROOMS) return; // 同時部屋数の上限に達している（緊急ブレーキ）
      if (!canCreateRoom(getClientIp(socket))) return; // 同一IPからの新規作成が頻度制限を超えている
      targetRoomId = `friend:${generateRoomCode()}`;
    } else {
      return; // 不正なmode
    }

    if (socket.data.roomId !== targetRoomId) {
      // leaveを経由せずモードを切り替えられた場合に備え、元の部屋に残っている
      // 自分のプレイヤー情報を先に片付けておく（幽霊プレイヤーとして残さない）。
      const oldRoom = getRoomForSocket(socket);
      const oldClientId = socket.data.clientId;
      if (oldRoom && oldClientId && oldRoom.players.has(oldClientId) && oldRoom.socketIdByClientId.get(oldClientId) === socket.id) {
        const wasBuzzed = removePlayer(oldRoom, oldClientId);
        handlePlayerDeparture(oldRoom, wasBuzzed);
        destroyRoomIfEmpty(oldRoom);
      }

      if (socket.data.roomId) socket.leave(socket.data.roomId);
      if (!rooms.has(targetRoomId)) {
        const newRoom = new Room(targetRoomId, io);
        if (mode === 'training') newRoom.isTraining = true;
        else newRoom.code = targetRoomId.slice('friend:'.length);
        rooms.set(targetRoomId, newRoom);
      }
      socket.data.roomId = targetRoomId;
      socket.join(targetRoomId);
    }

    const room = getRoomForSocket(socket);
    if (!room) return;

    socket.data.clientId = id;
    room.socketIdByClientId.set(id, socket.id);

    const rawName = (name || '').toString().trim().slice(0, 20) || `プレイヤー${id.slice(0, 4)}`;
    const cleanName = dedupePlayerName(room, id, rawName);
    const existing = room.players.get(id);
    if (existing) {
      existing.name = cleanName;
      existing.icon = cleanIcon;
      existing.connected = true;
      if (existing.disconnectTimer) {
        clearTimeout(existing.disconnectTimer);
        existing.disconnectTimer = null;
      }
    } else {
      room.players.set(id, { name: cleanName, icon: cleanIcon, score: 0, connected: true, disconnectTimer: null, wrongCount: 0 });
      if (!room.hostId) room.hostId = id; // 部屋に最初に入った人（作成者）がホストになる
    }
    room.broadcastState();
    upsertPlayer(id, cleanName, cleanIcon).catch(() => {});
  });

  // 「モード選択に戻る」で明示的に部屋を離れる。画面ロック等の一時切断とは違い、
  // 猶予時間を待たずすぐにプレイヤーを消し、トレーニング部屋なら空になり次第すぐ破棄する。
  onLimited('leave', () => {
    const room = getRoomForSocket(socket);
    if (room) {
      const clientId = socket.data.clientId;
      socket.leave(room.id);
      if (clientId && room.players.has(clientId)) {
        const wasBuzzed = removePlayer(room, clientId);
        handlePlayerDeparture(room, wasBuzzed);
      }
      destroyRoomIfEmpty(room);
    }
    socket.data.clientId = null;
    socket.data.roomId = null;
  });

  onLimited('game:setDifficulty', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { difficulty: d } = payload || {};
    if (!room.players.has(socket.data.clientId) || room.started || !isHost(room, socket)) return;
    if (!DIFFICULTIES.includes(d)) return;
    room.difficulty = d;
    room.broadcastState();
  });

  onLimited('game:setCpu', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { enabled } = payload || {};
    if (!room.players.has(socket.data.clientId) || room.started || !isHost(room, socket)) return;
    if (enabled) {
      if (!room.players.has(CPU_ID)) room.players.set(CPU_ID, { name: 'CPU', score: 0, connected: true, wrongCount: 0 });
    } else {
      room.players.delete(CPU_ID);
    }
    room.broadcastState();
  });

  onLimited('game:setWinScore', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { winScore } = payload || {};
    if (!room.players.has(socket.data.clientId) || room.started || !isHost(room, socket)) return;
    const n = Number(winScore);
    if (!Number.isInteger(n) || n < 0 || n > 99) return;
    room.winScore = n;
    room.broadcastState();
  });

  onLimited('game:setQuestionLimit', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { questionLimit } = payload || {};
    if (!room.players.has(socket.data.clientId) || room.started || !isHost(room, socket)) return;
    const n = Number(questionLimit);
    if (!Number.isInteger(n) || n < 0 || n > 99) return;
    room.questionLimit = n;
    room.broadcastState();
  });

  onLimited('game:setWrongPenalty', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { wrongPenalty } = payload || {};
    if (!room.players.has(socket.data.clientId) || room.started || !isHost(room, socket)) return;
    const n = Number(wrongPenalty);
    if (!Number.isInteger(n) || n < 0 || n > 99) return;
    room.wrongPenalty = n;
    room.broadcastState();
  });

  onLimited('game:setWrongLimit', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { wrongLimit } = payload || {};
    if (!room.players.has(socket.data.clientId) || room.started || !isHost(room, socket)) return;
    const n = Number(wrongLimit);
    if (!Number.isInteger(n) || n < 0 || n > 99) return;
    room.wrongLimit = n;
    room.broadcastState();
  });

  onLimited('game:start', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (!room.players.has(socket.data.clientId) || room.started || !isHost(room, socket)) return;
    if (questionBanks[room.difficulty].length === 0) return; // 問題が1問もない難易度では開始できない
    room.started = true;
    room.lockedOut.clear();
    room.disqualified.clear();
    for (const p of room.players.values()) p.wrongCount = 0;
    room.drawAndOpenNextQuestion();
  });

  onLimited('game:end', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (!room.players.has(socket.data.clientId) || !room.started || !isHost(room, socket)) return;
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
    room.disqualified.clear();
    for (const p of room.players.values()) { p.score = 0; p.wrongCount = 0; } // 次に始めるときは0からにする
    room.shuffledQueues.A = [];
    room.shuffledQueues.B = [];
    room.shuffledQueues.C = []; // 出題履歴もリセットして、次回また1からシャッフルし直す
    room.broadcastState();
  });

  onLimited('player:buzz', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (!room.started || room.phase !== 'open') return;
    const clientId = socket.data.clientId;
    if (!clientId || !room.players.has(clientId)) return;
    if (room.lockedOut.has(clientId) || room.disqualified.has(clientId)) return;
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

  onLimited('player:answer', (payload) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const { choice } = payload || {};
    if (!room.started || room.phase !== 'buzzed' || socket.data.clientId !== room.buzzedId) return;
    if (typeof choice !== 'string' || !room.letterChoices.includes(choice)) return;
    room.resolveLetterChoice(choice);
  });

  // 通報・ブロック・アカウント削除はclientIdをpayloadで明示的に受け取る（部屋に参加していない
  // 状態＝設定画面からのブロックリスト管理などでも使えるようにするため、socket.data.clientId
  // 〈=join済みの証〉には依存しない）。
  function cleanClientIdField(value) {
    return (typeof value === 'string' && value.trim()) ? value.trim().slice(0, 100) : null;
  }

  onLimited('report:submit', (payload) => {
    const { clientId, reportedClientId, reportedName, reason } = payload || {};
    const reporterId = cleanClientIdField(clientId);
    const targetId = cleanClientIdField(reportedClientId);
    if (!reporterId || !targetId || reporterId === targetId) return;
    const cleanName = (typeof reportedName === 'string' ? reportedName : '').slice(0, 20);
    const cleanReason = (typeof reason === 'string' ? reason : '').slice(0, 50);
    submitReport(reporterId, targetId, cleanName, socket.data.roomId || null, cleanReason).catch(() => {});
  });

  onLimited('block:add', (payload, ack) => {
    const { clientId, blockedClientId, blockedName } = payload || {};
    const blockerId = cleanClientIdField(clientId);
    const targetId = cleanClientIdField(blockedClientId);
    if (!blockerId || !targetId || blockerId === targetId) return;
    const cleanName = (typeof blockedName === 'string' ? blockedName : '').slice(0, 20);
    addBlock(blockerId, targetId, cleanName)
      .then(() => { if (typeof ack === 'function') ack({ ok: true }); })
      .catch(() => { if (typeof ack === 'function') ack({ ok: false }); });
  });

  onLimited('block:remove', (payload, ack) => {
    const { clientId, blockedClientId } = payload || {};
    const blockerId = cleanClientIdField(clientId);
    const targetId = cleanClientIdField(blockedClientId);
    if (!blockerId || !targetId) return;
    removeBlock(blockerId, targetId)
      .then(() => { if (typeof ack === 'function') ack({ ok: true }); })
      .catch(() => { if (typeof ack === 'function') ack({ ok: false }); });
  });

  onLimited('block:list', (payload, ack) => {
    const id = cleanClientIdField((payload || {}).clientId);
    if (!id || typeof ack !== 'function') return;
    getBlockList(id).then((list) => ack(list)).catch(() => ack([]));
  });

  onLimited('account:delete', (payload, ack) => {
    const id = cleanClientIdField((payload || {}).clientId);
    if (!id) return;
    // 削除と同時に、今いる部屋からも退出させる（leaveと同じ後片付け）。
    const room = getRoomForSocket(socket);
    if (room && room.players.has(id)) {
      const wasBuzzed = removePlayer(room, id);
      handlePlayerDeparture(room, wasBuzzed);
      destroyRoomIfEmpty(room);
      socket.leave(room.id);
    }
    socket.data.clientId = null;
    socket.data.roomId = null;
    deleteAccount(id)
      .then(() => { if (typeof ack === 'function') ack({ ok: true }); })
      .catch(() => { if (typeof ack === 'function') ack({ ok: false }); });
  });

  // プレイヤーが自分でアップロードするアイコン画像。事前審査はせず、既存の通報・ブロック
  // 機能による事後対応の運用にしている(ユーザーの選択、project_gacha_feature_backlog等と
  // 同様に景品性のない純粋なコスメティック機能)。base64データはブラウザ側で既に256x256の
  // 正方形JPEGへ縮小・圧縮済みだが、念のためサーバー側でも形式とサイズを検証する。
  onLimited('icon:upload', (payload, ack) => {
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    const id = cleanClientIdField((payload || {}).clientId);
    const dataUrl = (payload || {}).imageBase64;
    if (!id || typeof dataUrl !== 'string') { reply({ ok: false, error: '不正なリクエストです' }); return; }
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
    if (!match) { reply({ ok: false, error: '画像形式が正しくありません' }); return; }
    const [, mimeType, base64Data] = match;
    let buffer;
    try {
      buffer = Buffer.from(base64Data, 'base64');
    } catch (e) {
      reply({ ok: false, error: '画像データが正しくありません' });
      return;
    }
    if (buffer.length === 0 || buffer.length > 2 * 1024 * 1024) {
      reply({ ok: false, error: '画像サイズが大きすぎます' });
      return;
    }
    uploadIcon(id, buffer, mimeType)
      .then((url) => {
        if (!url) { reply({ ok: false, error: 'アップロードに失敗しました' }); return; }
        reply({ ok: true, url });
      })
      .catch(() => reply({ ok: false, error: 'アップロードに失敗しました' }));
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
        reassignHostIfNeeded(room, clientId);
        room.broadcastState();
        destroyRoomIfEmpty(room);
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
