const fs = require('fs');
const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

// ---- 問題バンク（自動出題モード用） ----
let questionBank = [];
try {
  questionBank = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf-8'));
} catch (e) {
  console.error('questions.json の読み込みに失敗しました:', e.message);
}

let shuffledQueue = []; // 未出題の問題インデックス（1周するまで重複しない）

function drawNextQuestion() {
  if (questionBank.length === 0) return null;
  if (shuffledQueue.length === 0) {
    shuffledQueue = questionBank.map((_, i) => i);
    for (let i = shuffledQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledQueue[i], shuffledQueue[j]] = [shuffledQueue[j], shuffledQueue[i]];
    }
  }
  const idx = shuffledQueue.pop();
  return questionBank[idx];
}

// ---- ゲーム状態（シングルルーム） ----
const players = new Map(); // socketId -> { name, score }
let hostId = null;
let phase = 'idle'; // idle | open | buzzed
let buzzedId = null;
let question = '';
let answer = ''; // 出題者にのみ配信（自動出題モードの答え合わせ用）
let mode = 'manual'; // manual | auto
const lockedOut = new Set(); // このお題で誤答済みのplayerId

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
    questionCount: questionBank.length,
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
    mode = m;
    phase = 'idle';
    buzzedId = null;
    question = '';
    answer = '';
    lockedOut.clear();
    broadcastState();
  });

  socket.on('host:open', ({ question: q } = {}) => {
    if (socket.id !== hostId) return;
    if (mode === 'auto') {
      const picked = drawNextQuestion();
      question = picked ? picked.question : '';
      answer = picked ? picked.answer : '';
    } else {
      question = (q || '').toString().trim().slice(0, 300);
      answer = '';
    }
    phase = 'open';
    buzzedId = null;
    broadcastState();
  });

  socket.on('host:reset', () => {
    if (socket.id !== hostId) return;
    phase = 'idle';
    buzzedId = null;
    question = '';
    answer = '';
    lockedOut.clear();
    broadcastState();
  });

  socket.on('host:correct', () => {
    if (socket.id !== hostId || !buzzedId) return;
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
    if (socket.id !== hostId || !buzzedId) return;
    lockedOut.add(buzzedId);
    buzzedId = null;
    phase = 'open';
    broadcastState();
  });

  socket.on('player:buzz', () => {
    if (phase !== 'open') return;
    if (!players.has(socket.id)) return;
    if (lockedOut.has(socket.id)) return;
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
