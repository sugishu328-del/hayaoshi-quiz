const fs = require('fs');
const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

// ---- 問題バンク（自動出題モード用、難易度A/B/C別） ----
const DIFFICULTIES = ['A', 'B', 'C'];
let questionBanks = { A: [], B: [], C: [] };
try {
  const loaded = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf-8'));
  for (const d of DIFFICULTIES) {
    questionBanks[d] = Array.isArray(loaded[d]) ? loaded[d] : [];
  }
} catch (e) {
  console.error('questions.json の読み込みに失敗しました:', e.message);
}

const shuffledQueues = { A: [], B: [], C: [] }; // 難易度ごとの未出題インデックス（1周するまで重複しない）

function drawNextQuestion(difficulty) {
  const bank = questionBanks[difficulty] || [];
  if (bank.length === 0) return null;
  if (shuffledQueues[difficulty].length === 0) {
    const queue = bank.map((_, i) => i);
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    shuffledQueues[difficulty] = queue;
  }
  const idx = shuffledQueues[difficulty].pop();
  return bank[idx];
}

// ---- ゲーム状態（シングルルーム） ----
const players = new Map(); // socketId -> { name, score }
let hostId = null;
let phase = 'idle'; // idle | open | buzzed
let buzzedId = null;
let question = '';
let answer = ''; // 出題者にのみ配信（自動出題モードの答え合わせ用）
let mode = 'manual'; // manual | auto
let difficulty = 'A'; // A | B | C（自動出題モード用）
let autoStarted = false; // 自動出題モードで難易度を選んでスタート済みか
const lockedOut = new Set(); // このお題で誤答済みのplayerId

// ---- CPU対戦相手（自動出題モードでスタート後のみ参加） ----
const CPU_ID = 'cpu';
const CPU_ACCURACY = { A: 0.9, B: 0.6, C: 0.3 }; // 難易度ごとの正答率
let cpuTimer = null;

function cancelCpuTimer() {
  if (cpuTimer) {
    clearTimeout(cpuTimer);
    cpuTimer = null;
  }
}

function scheduleCpuBuzzIfNeeded() {
  cancelCpuTimer();
  if (!players.has(CPU_ID)) return;
  if (mode !== 'auto' || !autoStarted) return;
  if (phase !== 'open' || !answer) return;
  if (lockedOut.has(CPU_ID)) return;

  const roundQuestion = question;
  const reactionDelay = 1000 + Math.random() * 3000; // 1〜4秒でランダムに早押し
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    if (phase !== 'open' || question !== roundQuestion) return; // 状況が変わっていたら何もしない
    if (!players.has(CPU_ID) || lockedOut.has(CPU_ID)) return;

    buzzedId = CPU_ID;
    phase = 'buzzed';
    broadcastState();

    const thinkDelay = 800 + Math.random() * 700; // 「考え中」の間
    setTimeout(() => {
      if (buzzedId !== CPU_ID || phase !== 'buzzed') return;
      const correct = Math.random() < (CPU_ACCURACY[difficulty] ?? 0.5);
      if (correct) {
        const p = players.get(CPU_ID);
        if (p) p.score += 1;
        phase = 'idle';
        buzzedId = null;
        question = '';
        answer = '';
        lockedOut.clear();
      } else {
        lockedOut.add(CPU_ID);
        buzzedId = null;
        phase = 'open';
      }
      broadcastState();
    }, thinkDelay);
  }, reactionDelay);
}

function publicPlayers() {
  return [...players.entries()].map(([id, p]) => ({
    id,
    name: p.name,
    score: p.score,
    locked: lockedOut.has(id),
  }));
}

function broadcastState() {
  const base = {
    phase,
    players: publicPlayers(),
    buzzedId,
    buzzedName: buzzedId ? players.get(buzzedId)?.name : null,
    hasHost: hostId !== null,
    question,
    mode,
    difficulty,
    autoStarted,
    questionCounts: { A: questionBanks.A.length, B: questionBanks.B.length, C: questionBanks.C.length },
  };
  io.except('host').emit('state', base);
  io.to('host').emit('state', { ...base, answer });
}

io.on('connection', (socket) => {
  socket.on('join', ({ name, role }) => {
    if (role === 'host') {
      hostId = socket.id;
      socket.data.role = 'host';
      socket.join('host');
    } else {
      const cleanName = (name || '').toString().trim().slice(0, 20) || `プレイヤー${socket.id.slice(0, 4)}`;
      players.set(socket.id, { name: cleanName, score: 0 });
      socket.data.role = 'player';
    }
    broadcastState();
  });

  socket.on('host:setMode', ({ mode: m } = {}) => {
    if (socket.id !== hostId) return;
    if (m !== 'manual' && m !== 'auto') return;
    cancelCpuTimer();
    mode = m;
    autoStarted = false;
    phase = 'idle';
    buzzedId = null;
    question = '';
    answer = '';
    lockedOut.clear();
    broadcastState();
  });

  socket.on('host:setDifficulty', ({ difficulty: d } = {}) => {
    if (socket.id !== hostId || mode !== 'auto' || autoStarted) return;
    if (!DIFFICULTIES.includes(d)) return;
    difficulty = d;
    broadcastState();
  });

  socket.on('host:startAuto', () => {
    if (socket.id !== hostId || mode !== 'auto') return;
    cancelCpuTimer();
    autoStarted = true;
    phase = 'idle';
    buzzedId = null;
    question = '';
    answer = '';
    lockedOut.clear();
    broadcastState();
  });

  socket.on('host:changeDifficulty', () => {
    if (socket.id !== hostId || mode !== 'auto') return;
    cancelCpuTimer();
    autoStarted = false;
    phase = 'idle';
    buzzedId = null;
    question = '';
    answer = '';
    lockedOut.clear();
    broadcastState();
  });

  socket.on('host:setCpu', ({ enabled } = {}) => {
    if (socket.id !== hostId) return;
    if (enabled) {
      if (!players.has(CPU_ID)) players.set(CPU_ID, { name: 'CPU', score: 0 });
    } else {
      cancelCpuTimer();
      players.delete(CPU_ID);
      lockedOut.delete(CPU_ID);
      if (buzzedId === CPU_ID) {
        buzzedId = null;
        phase = 'idle';
        question = '';
        answer = '';
        lockedOut.clear();
      }
    }
    broadcastState();
  });

  socket.on('host:open', ({ question: q } = {}) => {
    if (socket.id !== hostId) return;
    cancelCpuTimer();
    if (mode === 'auto') {
      if (!autoStarted) return;
      const picked = drawNextQuestion(difficulty);
      question = picked ? picked.question : '';
      answer = picked ? picked.answer : '';
    } else {
      question = (q || '').toString().trim().slice(0, 300);
      answer = '';
    }
    phase = 'open';
    buzzedId = null;
    broadcastState();
    scheduleCpuBuzzIfNeeded();
  });

  socket.on('host:reset', () => {
    if (socket.id !== hostId) return;
    cancelCpuTimer();
    phase = 'idle';
    buzzedId = null;
    question = '';
    answer = '';
    lockedOut.clear();
    broadcastState();
  });

  socket.on('host:correct', () => {
    if (socket.id !== hostId || !buzzedId || buzzedId === CPU_ID) return;
    cancelCpuTimer();
    const p = players.get(buzzedId);
    if (p) p.score += 1;
    phase = 'idle';
    buzzedId = null;
    question = '';
    answer = '';
    lockedOut.clear();
    broadcastState();
  });

  socket.on('host:wrong', () => {
    if (socket.id !== hostId || !buzzedId || buzzedId === CPU_ID) return;
    lockedOut.add(buzzedId);
    buzzedId = null;
    phase = 'open';
    broadcastState();
    scheduleCpuBuzzIfNeeded();
  });

  socket.on('player:buzz', () => {
    if (phase !== 'open') return;
    if (!players.has(socket.id)) return;
    if (lockedOut.has(socket.id)) return;
    cancelCpuTimer();
    phase = 'buzzed';
    buzzedId = socket.id;
    broadcastState();
  });

  socket.on('disconnect', () => {
    if (socket.id === hostId) {
      hostId = null;
    }
    if (players.has(socket.id)) {
      players.delete(socket.id);
      lockedOut.delete(socket.id);
      if (buzzedId === socket.id) {
        buzzedId = null;
        phase = 'idle';
      }
    }
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`早押しクイズサーバー起動: http://localhost:${PORT}`);
});
