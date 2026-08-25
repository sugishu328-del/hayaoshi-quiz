const fs = require('fs');
const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

// ---- 問題バンク（難易度A/B/C別、全問自動出題） ----
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

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 正解1つ＋同じ難易度バンクの他の答えからランダムに3つ選んで4択を作る
function buildChoices(bank, correctAnswer) {
  const pool = bank.map((q) => q.answer).filter((a) => a !== correctAnswer);
  const shuffledPool = shuffleArray(pool);
  const distractors = [];
  for (const a of shuffledPool) {
    if (distractors.length >= 3) break;
    if (!distractors.includes(a)) distractors.push(a);
  }
  return shuffleArray([correctAnswer, ...distractors]);
}

// ---- CPU対戦相手（参加は任意、正答率は難易度に応じる） ----
const CPU_ID = 'cpu';
const CPU_ACCURACY = { A: 0.9, B: 0.6, C: 0.3 };

// ---- ゲーム状態（シングルルーム、出題者なし・全員参加者） ----
const players = new Map(); // socketId -> { name, score }
let started = false;
let difficulty = 'A';
let phase = 'open'; // open | buzzed | reveal（started=falseの間は未使用）
let question = '';
let answer = ''; // サーバー内部のみで保持し、reveal時にrevealedAnswerとして公開する
let choices = [];
let wrongChoices = [];
let revealedAnswer = '';
let buzzedId = null;
const lockedOut = new Set(); // この問題で誤答済みのplayerId

let cpuTimer = null;
let noBuzzTimer = null;
let answerTimer = null;
let advanceTimer = null;

const NO_BUZZ_TIMEOUT_MS = 20000; // 誰も押さないまま経過したら諦めて次の問題へ
const ANSWER_TIMEOUT_MS = 12000; // 回答権を得た人が選ばないまま経過したら誤答扱い
const REVEAL_DELAY_MS = 3000; // 正解発表を表示しておく時間

function cancelCpuTimer() { if (cpuTimer) { clearTimeout(cpuTimer); cpuTimer = null; } }
function cancelNoBuzzTimer() { if (noBuzzTimer) { clearTimeout(noBuzzTimer); noBuzzTimer = null; } }
function cancelAnswerTimer() { if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; } }
function cancelAdvanceTimer() { if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; } }
function cancelAllTimers() {
  cancelCpuTimer();
  cancelNoBuzzTimer();
  cancelAnswerTimer();
  cancelAdvanceTimer();
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
  io.emit('state', {
    started,
    difficulty,
    phase,
    question,
    choices,
    wrongChoices,
    revealedAnswer,
    buzzedId,
    buzzedName: buzzedId ? players.get(buzzedId)?.name : null,
    players: publicPlayers(),
    questionCounts: { A: questionBanks.A.length, B: questionBanks.B.length, C: questionBanks.C.length },
  });
}

function scheduleNoBuzzTimer() {
  cancelNoBuzzTimer();
  const roundQuestion = question;
  noBuzzTimer = setTimeout(() => {
    noBuzzTimer = null;
    if (!started || phase !== 'open' || question !== roundQuestion) return;
    enterReveal();
  }, NO_BUZZ_TIMEOUT_MS);
}

function scheduleAnswerTimeout() {
  cancelAnswerTimer();
  const myBuzzedId = buzzedId;
  const roundQuestion = question;
  answerTimer = setTimeout(() => {
    answerTimer = null;
    if (!started || phase !== 'buzzed' || buzzedId !== myBuzzedId || question !== roundQuestion) return;
    resolveWrong();
  }, ANSWER_TIMEOUT_MS);
}

function scheduleCpuBuzzIfNeeded() {
  cancelCpuTimer();
  if (!players.has(CPU_ID) || !started || phase !== 'open' || !answer) return;
  if (lockedOut.has(CPU_ID)) return;

  const roundQuestion = question;
  const reactionDelay = 1000 + Math.random() * 3000; // 1〜4秒でランダムに早押し
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    if (!started || phase !== 'open' || question !== roundQuestion) return;
    if (!players.has(CPU_ID) || lockedOut.has(CPU_ID)) return;

    cancelNoBuzzTimer();
    buzzedId = CPU_ID;
    phase = 'buzzed';
    broadcastState();

    const thinkDelay = 800 + Math.random() * 700; // 「考え中」の間
    setTimeout(() => {
      if (buzzedId !== CPU_ID || phase !== 'buzzed') return;
      const correct = Math.random() < (CPU_ACCURACY[difficulty] ?? 0.5);
      if (correct) {
        resolveAnswer(answer);
      } else {
        const options = choices.filter((c) => c !== answer && !wrongChoices.includes(c));
        const pick = options.length > 0 ? options[Math.floor(Math.random() * options.length)] : choices.find((c) => c !== answer);
        resolveAnswer(pick);
      }
    }, thinkDelay);
  }, reactionDelay);
}

function resolveWrong() {
  if (buzzedId) lockedOut.add(buzzedId);
  buzzedId = null;
  if (lockedOut.size >= players.size) {
    enterReveal();
  } else {
    phase = 'open';
    broadcastState();
    scheduleCpuBuzzIfNeeded();
    scheduleNoBuzzTimer();
  }
}

function resolveAnswer(chosenText) {
  cancelAnswerTimer();
  if (chosenText === answer) {
    const p = players.get(buzzedId);
    if (p) p.score += 1;
    enterReveal();
  } else {
    if (chosenText && !wrongChoices.includes(chosenText)) wrongChoices.push(chosenText);
    resolveWrong();
  }
}

function enterReveal() {
  cancelAllTimers();
  phase = 'reveal';
  revealedAnswer = answer;
  buzzedId = null;
  broadcastState();
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    if (!started) return;
    drawAndOpenNextQuestion();
  }, REVEAL_DELAY_MS);
}

function drawAndOpenNextQuestion() {
  cancelAllTimers();
  const picked = drawNextQuestion(difficulty);
  question = picked ? picked.question : '';
  answer = picked ? picked.answer : '';
  choices = picked ? buildChoices(questionBanks[difficulty], picked.answer) : [];
  wrongChoices = [];
  revealedAnswer = '';
  buzzedId = null;
  lockedOut.clear();
  phase = 'open';
  broadcastState();
  scheduleCpuBuzzIfNeeded();
  scheduleNoBuzzTimer();
}

io.on('connection', (socket) => {
  socket.on('join', ({ name } = {}) => {
    const cleanName = (name || '').toString().trim().slice(0, 20) || `プレイヤー${socket.id.slice(0, 4)}`;
    players.set(socket.id, { name: cleanName, score: 0 });
    broadcastState();
  });

  socket.on('game:setDifficulty', ({ difficulty: d } = {}) => {
    if (!players.has(socket.id) || started) return;
    if (!DIFFICULTIES.includes(d)) return;
    difficulty = d;
    broadcastState();
  });

  socket.on('game:setCpu', ({ enabled } = {}) => {
    if (!players.has(socket.id) || started) return;
    if (enabled) {
      if (!players.has(CPU_ID)) players.set(CPU_ID, { name: 'CPU', score: 0 });
    } else {
      players.delete(CPU_ID);
    }
    broadcastState();
  });

  socket.on('game:start', () => {
    if (!players.has(socket.id) || started) return;
    started = true;
    lockedOut.clear();
    drawAndOpenNextQuestion();
  });

  socket.on('game:end', () => {
    if (!players.has(socket.id) || !started) return;
    cancelAllTimers();
    started = false;
    phase = 'open';
    question = '';
    answer = '';
    choices = [];
    wrongChoices = [];
    revealedAnswer = '';
    buzzedId = null;
    lockedOut.clear();
    broadcastState();
  });

  socket.on('player:buzz', () => {
    if (!started || phase !== 'open') return;
    if (!players.has(socket.id) || socket.id === CPU_ID) return;
    if (lockedOut.has(socket.id)) return;
    cancelCpuTimer();
    cancelNoBuzzTimer();
    buzzedId = socket.id;
    phase = 'buzzed';
    broadcastState();
    scheduleAnswerTimeout();
  });

  socket.on('player:answer', ({ choice } = {}) => {
    if (!started || phase !== 'buzzed' || socket.id !== buzzedId) return;
    if (typeof choice !== 'string' || !choices.includes(choice)) return;
    resolveAnswer(choice);
  });

  socket.on('disconnect', () => {
    if (!players.has(socket.id)) return;
    const wasBuzzed = buzzedId === socket.id;
    players.delete(socket.id);
    lockedOut.delete(socket.id);

    if (!started) {
      broadcastState();
      return;
    }

    if (wasBuzzed) {
      cancelAnswerTimer();
      buzzedId = null;
      if (players.size === 0) {
        phase = 'open';
        broadcastState();
        return;
      }
      if (lockedOut.size >= players.size) {
        enterReveal();
      } else {
        phase = 'open';
        broadcastState();
        scheduleCpuBuzzIfNeeded();
        scheduleNoBuzzTimer();
      }
    } else if (phase === 'open' && players.size > 0 && lockedOut.size >= players.size) {
      enterReveal();
    } else {
      broadcastState();
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`早押しクイズサーバー起動: http://localhost:${PORT}`);
});
