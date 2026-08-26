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

// picked.shortAnswer（「ここまで打てば正解」の短縮文字列）が有効かを確認し、
// 有効ならその文字数を返す。answerの厳密な接頭辞でなければ無視して null を返す
// （letter-by-letterの仕組み上、shortAnswerはanswerの先頭一致でなければ整合が取れないため）。
function resolveShortAnswerLength(picked) {
  const shortAnswer = picked.shortAnswer;
  if (typeof shortAnswer !== 'string' || shortAnswer.length === 0) return null;
  if (!picked.answer.startsWith(shortAnswer) || shortAnswer.length >= picked.answer.length) {
    console.error(`questions.json: shortAnswerが不正なため無視します（question: "${picked.question}"）`);
    return null;
  }
  return shortAnswer.length;
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- 1文字ずつ選ばせる方式のための文字プール ----
// 「・」は選ばせず自動でスキップする。数字/ローマ字/ひらがな/カタカナ/漢字でダミー文字の種類を揃える
// （例：「ドラえもん」のようにカタカナとひらがなが混ざる答えでも、文字ごとに種類を合わせる）。
const SKIP_CHARS = new Set(['・']);

function classifyChar(ch) {
  if (/[0-9]/.test(ch)) return 'digit';
  if (/[A-Za-z]/.test(ch)) return 'latin';
  if (/[ぁ-ゟ]/.test(ch)) return 'hiragana';
  if (/[゠-ヿ･-ﾟ]/.test(ch)) return 'katakana';
  if (/[一-鿿㐀-䶿]/.test(ch)) return 'kanji';
  return 'kanji'; // 上記のどれにも当てはまらない稀な文字は漢字プール扱いにしておく
}

const HIRAGANA_FALLBACK = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん'.split('');
const KATAKANA_FALLBACK = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンー'.split('');
const KANJI_FALLBACK = '日一二三四五六七八九十百千万人大小上下左右中外国年月火水木金土曜生学校先子女男川山田村町気天空海風雪花草林森石岩道車話読書聞'.split('');

const charPools = { digit: [], latin: [], hiragana: [], katakana: [], kanji: [] };

function buildCharPools() {
  const seen = { digit: new Set(), latin: new Set(), hiragana: new Set(), katakana: new Set(), kanji: new Set() };
  for (const d of DIFFICULTIES) {
    for (const item of questionBanks[d]) {
      for (const ch of item.answer) {
        if (SKIP_CHARS.has(ch)) continue;
        seen[classifyChar(ch)].add(ch);
      }
    }
  }
  charPools.digit = seen.digit.size >= 4 ? [...seen.digit] : '0123456789'.split('');
  charPools.latin = seen.latin.size >= 4 ? [...seen.latin] : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  charPools.hiragana = seen.hiragana.size >= 4 ? [...seen.hiragana] : HIRAGANA_FALLBACK;
  charPools.katakana = seen.katakana.size >= 4 ? [...seen.katakana] : KATAKANA_FALLBACK;
  charPools.kanji = seen.kanji.size >= 4 ? [...seen.kanji] : KANJI_FALLBACK;
}
buildCharPools();

function buildLetterChoices(correctChar) {
  const cls = classifyChar(correctChar);
  const pool = charPools[cls].filter((c) => c !== correctChar);
  const shuffledPool = shuffleArray(pool);
  const decoys = [];
  for (const c of shuffledPool) {
    if (decoys.length >= 3) break;
    if (!decoys.includes(c)) decoys.push(c);
  }
  return shuffleArray([correctChar, ...decoys]);
}

// 1文字目だけは、ランダムな同種文字ではなく「もっともらしい誤答（distractors）」の
// 頭文字を選択肢にする。distractorsが足りない/重複する分は通常のプールで補う。
function buildFirstLetterChoices(correctChar, distractors) {
  const candidates = [correctChar];
  for (const d of distractors || []) {
    if (candidates.length >= 4) break;
    const firstChar = d ? d[0] : null;
    if (firstChar && !candidates.includes(firstChar)) candidates.push(firstChar);
  }
  if (candidates.length < 4) {
    const cls = classifyChar(correctChar);
    const pool = shuffleArray(charPools[cls].filter((c) => !candidates.includes(c)));
    for (const c of pool) {
      if (candidates.length >= 4) break;
      candidates.push(c);
    }
  }
  return shuffleArray(candidates);
}

function countGuessableChars(str) {
  return [...str].filter((ch) => !SKIP_CHARS.has(ch)).length;
}

// ---- CPU対戦相手（参加は任意、正答率は難易度に応じる） ----
const CPU_ID = 'cpu';
const CPU_ACCURACY = { A: 0.3, B: 0.6, C: 0.9 }; // A=むずかしい, C=かんたん

// ---- ゲーム状態（シングルルーム、出題者なし・全員参加者） ----
const players = new Map(); // socketId -> { name, score }
let started = false;
let difficulty = 'B';
let phase = 'open'; // announce | open | buzzed | wrong | correct | reveal（started=falseの間は未使用）
let question = '';
let questionNumber = 0; // 何問目か（game:startで1から始まる）
let answer = ''; // サーバー内部のみで保持し、reveal時にrevealedAnswerとして公開する
let currentDistractors = []; // 現在の問題のもっともらしい誤答（1文字目の選択肢作りに使う）
let currentShortAnswerLength = null; // ここまで打てば正解、という短縮文字数（未設定ならnull＝全文入力が必要）
let resolvedCount = 0; // answerの先頭から何文字確定したか（スキップ文字も含む）
let letterChoices = []; // 現在の文字位置の4択
let revealedAnswer = '';
let buzzedId = null;
let noBuzzDeadline = null; // 「誰も押さないまま自動で正解発表になる」時刻（クライアントのカウントダウン表示用）
let questionRevealedMs = 0; // この問題文がこれまでに表示され進んだ合計時間（誤答で中断された分は除く）
let questionTypingStartedAt = null; // 直近でopenフェーズに入った（表示が再開した）時刻
let questionOpenedAt = null; // この問題が最初にopenになった時刻（誤答での中断・再開では変わらない。反応時間の計測用）
let wrongLetterChoice = null; // 直前に誤答した文字（「✕不正解」表示用。タイムアウト時はnull）
let lastBuzzerId = null; // 直近に押した人（「○正解」「✕不正解」表示中はbuzzedIdがnullになるので別途保持）
let lastBuzzerReactionMs = null; // 問題文表示開始から押すまでにかかった時間（参加者バーの表示用）
const lockedOut = new Set(); // この問題で誤答済みのplayerId

let cpuTimer = null;
let cpuLetterTimer = null;
let noBuzzTimer = null;
let letterTimer = null;
let advanceTimer = null;
let wrongTimer = null;
let correctTimer = null;
let cpuWillSucceed = true;
let cpuMistakeAt = -1; // 何文字目（ガード対象文字のうち何番目）でわざと間違えるか
let cpuStepIndex = 0;
let isFirstLetterPick = true; // 早押し後、最初の1文字目だけ制限時間を長くする

const TYPEWRITER_SPEED_MS = 140; // client.jsの問題文タイプライター表示と同じ速さ（表示完了タイミングの計算に使う）
const CORRECT_REVEAL_SPEED_MS = 70; // 正解後、残りの問題文を続きから表示するときの速さ（client.jsと同じ値）
const NO_BUZZ_TIMEOUT_MS = 5000; // 問題文が表示され終わってから、誰も押さないまま経過したら諦めて次の問題へ
const FIRST_LETTER_TIMEOUT_MS = 5000; // 早押し直後、1文字目だけの制限時間
const LETTER_TIMEOUT_MS = 3000; // 2文字目以降、選ばないまま経過したら誤答扱い
const REVEAL_DELAY_MS = 3000; // 正解発表を表示しておく時間
const ANNOUNCE_DELAY_MS = 1500; // 「第N問」だけを表示しておく時間
const WRONG_ANSWER_DELAY_MS = 1500; // 文字を選んで誤答したときに「✕不正解」を表示しておく時間
const POST_CORRECT_REVEAL_DELAY_MS = 2000; // 「○正解」の後、残りの問題文＋A.答えを表示しておく時間
const CORRECT_ANSWER_DELAY_MS = 1500; // 正解し終わったときに「○正解」を表示しておく時間

function cancelCpuTimer() { if (cpuTimer) { clearTimeout(cpuTimer); cpuTimer = null; } }
function cancelCpuLetterTimer() { if (cpuLetterTimer) { clearTimeout(cpuLetterTimer); cpuLetterTimer = null; } }
function cancelNoBuzzTimer() { if (noBuzzTimer) { clearTimeout(noBuzzTimer); noBuzzTimer = null; } noBuzzDeadline = null; }

// 早押しされてopenフェーズが中断される瞬間に呼ぶ。ここまでに問題文が表示された時間を
// questionRevealedMsに積み増しておき、後でopenに戻ったときに続きから計算できるようにする。
function pauseQuestionTyping() {
  if (questionTypingStartedAt !== null) {
    const totalTypingMs = question.length * TYPEWRITER_SPEED_MS;
    questionRevealedMs = Math.min(totalTypingMs, questionRevealedMs + (Date.now() - questionTypingStartedAt));
    questionTypingStartedAt = null;
  }
}
function cancelLetterTimer() { if (letterTimer) { clearTimeout(letterTimer); letterTimer = null; } }
function cancelAdvanceTimer() { if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; } }
function cancelWrongTimer() { if (wrongTimer) { clearTimeout(wrongTimer); wrongTimer = null; } }
function cancelCorrectTimer() { if (correctTimer) { clearTimeout(correctTimer); correctTimer = null; } }
function cancelAllTimers() {
  cancelCpuTimer();
  cancelCpuLetterTimer();
  cancelNoBuzzTimer();
  cancelLetterTimer();
  cancelAdvanceTimer();
  cancelWrongTimer();
  cancelCorrectTimer();
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
  const isBuzzedSelf = (socketId) => buzzedId === socketId;
  const base = {
    started,
    difficulty,
    phase,
    question,
    questionNumber,
    revealedAnswer,
    noBuzzDeadline,
    wrongLetterChoice,
    buzzedId,
    buzzedName: buzzedId ? players.get(buzzedId)?.name : null,
    lastBuzzerId,
    lastBuzzerReactionMs,
    players: publicPlayers(),
    questionCounts: { A: questionBanks.A.length, B: questionBanks.B.length, C: questionBanks.C.length },
  };
  // answerProgress（確定した文字）は全員に見せる。letterChoices（次の文字の4択）は本人にだけ送る。
  const answerProgress = answer.slice(0, resolvedCount);
  for (const [id, socket] of io.sockets.sockets) {
    socket.emit('state', {
      ...base,
      answerProgress,
      letterChoices: isBuzzedSelf(id) ? letterChoices : [],
    });
  }
}

// 問題文の表示（タイプライター）の残りが終わるまでの時間 + NO_BUZZ_TIMEOUT_MS 待ってから
// 誰も押さなければ諦めて次の問題へ。誤答で中断されていた場合は、その時点までの
// 表示済み時間（questionRevealedMs）を差し引いた残りだけ待つ。
function scheduleNoBuzzTimer() {
  cancelNoBuzzTimer();
  const roundQuestion = question;
  const totalTypingMs = roundQuestion.length * TYPEWRITER_SPEED_MS;
  const remainingTypingMs = Math.max(0, totalTypingMs - questionRevealedMs);
  questionTypingStartedAt = Date.now();
  const totalDelay = remainingTypingMs + NO_BUZZ_TIMEOUT_MS;
  noBuzzDeadline = Date.now() + totalDelay;
  noBuzzTimer = setTimeout(() => {
    noBuzzTimer = null;
    if (!started || phase !== 'open' || question !== roundQuestion) return;
    enterReveal();
  }, totalDelay);
}

function scheduleLetterTimeout(timeoutMs) {
  cancelLetterTimer();
  const myBuzzedId = buzzedId;
  const myResolvedCount = resolvedCount;
  letterTimer = setTimeout(() => {
    letterTimer = null;
    if (!started || phase !== 'buzzed' || buzzedId !== myBuzzedId || resolvedCount !== myResolvedCount) return;
    resolveWrong();
  }, timeoutMs);
}

// 現在のresolvedCountから次に選ばせる文字を用意する。スキップ文字は自動で読み飛ばし、
// 最後まで到達したら正解確定。CPUの番なら次の一手もスケジュールする。
function advanceLetterOrFinish() {
  while (resolvedCount < answer.length && SKIP_CHARS.has(answer[resolvedCount])) {
    resolvedCount++;
  }
  if (currentShortAnswerLength !== null && resolvedCount >= currentShortAnswerLength) {
    finishCorrectAnswer();
    return;
  }
  if (resolvedCount >= answer.length) {
    finishCorrectAnswer();
    return;
  }
  letterChoices = resolvedCount === 0
    ? buildFirstLetterChoices(answer[resolvedCount], currentDistractors)
    : buildLetterChoices(answer[resolvedCount]);
  broadcastState();
  scheduleLetterTimeout(isFirstLetterPick ? FIRST_LETTER_TIMEOUT_MS : LETTER_TIMEOUT_MS);
  isFirstLetterPick = false;
  if (buzzedId === CPU_ID) scheduleCpuLetterPick();
}

// 正解し終わったら「○正解」をCORRECT_ANSWER_DELAY_MSだけ表示し、その後
// 残りの問題文を（誤答で止まっていた続きから）CORRECT_REVEAL_SPEED_MSで表示しきってから
// さらにPOST_CORRECT_REVEAL_DELAY_MSだけ間を置いて次の問題へ（'correctReveal'フェーズ）。
function finishCorrectAnswer() {
  cancelAllTimers();
  const p = players.get(buzzedId);
  if (p) p.score += 1;
  revealedAnswer = answer;
  buzzedId = null;
  resolvedCount = 0;
  letterChoices = [];
  phase = 'correct';
  broadcastState();
  correctTimer = setTimeout(() => {
    correctTimer = null;
    if (!started) return;
    phase = 'correctReveal';
    broadcastState();
    const alreadyShownChars = Math.round(questionRevealedMs / TYPEWRITER_SPEED_MS);
    const remainingChars = Math.max(0, question.length - alreadyShownChars);
    const fastTypingMs = remainingChars * CORRECT_REVEAL_SPEED_MS;
    advanceTimer = setTimeout(() => {
      advanceTimer = null;
      if (!started) return;
      drawAndOpenNextQuestion();
    }, fastTypingMs + POST_CORRECT_REVEAL_DELAY_MS);
  }, CORRECT_ANSWER_DELAY_MS);
}

function resolveLetterChoice(choice) {
  cancelLetterTimer();
  const correctChar = answer[resolvedCount];
  if (choice === correctChar) {
    resolvedCount++;
    advanceLetterOrFinish();
  } else {
    resolveWrong(choice);
  }
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
    pauseQuestionTyping();
    buzzedId = CPU_ID;
    lastBuzzerId = CPU_ID;
    lastBuzzerReactionMs = questionOpenedAt !== null ? Date.now() - questionOpenedAt : null;
    resolvedCount = 0;
    isFirstLetterPick = true;
    cpuStepIndex = 0;
    cpuWillSucceed = Math.random() < (CPU_ACCURACY[difficulty] ?? 0.5);
    const guessableCount = countGuessableChars(answer);
    cpuMistakeAt = cpuWillSucceed ? -1 : Math.floor(Math.random() * Math.max(guessableCount, 1));
    phase = 'buzzed';
    advanceLetterOrFinish();
  }, reactionDelay);
}

function scheduleCpuLetterPick() {
  cancelCpuLetterTimer();
  const thinkDelay = 600 + Math.random() * 900;
  cpuLetterTimer = setTimeout(() => {
    cpuLetterTimer = null;
    if (buzzedId !== CPU_ID || phase !== 'buzzed') return;
    const correctChar = answer[resolvedCount];
    const shouldFailNow = !cpuWillSucceed && cpuStepIndex === cpuMistakeAt;
    const pick = shouldFailNow ? (letterChoices.find((c) => c !== correctChar) || letterChoices[0]) : correctChar;
    cpuStepIndex++;
    resolveLetterChoice(pick);
  }, thinkDelay);
}

// choiceを渡した場合（文字を選んでの誤答）は「✕不正解」をWRONG_ANSWER_DELAY_MSだけ
// 表示してから次に進む。タイムアウト（何も選ばず時間切れ）の場合はchoiceを渡さず、
// これまで通り即座に次へ進む。
function resolveWrong(choice) {
  cancelLetterTimer();
  cancelCpuLetterTimer();
  if (buzzedId) lockedOut.add(buzzedId);
  buzzedId = null;

  if (choice) {
    // 「✕不正解」には、今回の解答でここまで選んだ文字を全部つなげて見せる
    // （それまで正解していた分＝answerの確定済み部分 + 今回誤答した1文字）。
    wrongLetterChoice = answer.slice(0, resolvedCount) + choice;
    resolvedCount = 0;
    letterChoices = [];
    phase = 'wrong';
    broadcastState();
    wrongTimer = setTimeout(() => {
      wrongTimer = null;
      proceedAfterWrong();
    }, WRONG_ANSWER_DELAY_MS);
  } else {
    resolvedCount = 0;
    letterChoices = [];
    proceedAfterWrong();
  }
}

function proceedAfterWrong() {
  wrongLetterChoice = null;
  if (lockedOut.size >= players.size) {
    enterReveal();
  } else {
    phase = 'open';
    scheduleNoBuzzTimer();
    broadcastState();
    scheduleCpuBuzzIfNeeded();
  }
}

function enterReveal() {
  cancelAllTimers();
  phase = 'reveal';
  revealedAnswer = answer;
  buzzedId = null;
  resolvedCount = 0;
  letterChoices = [];
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
  questionNumber++;
  answer = picked ? picked.answer : '';
  currentDistractors = picked && Array.isArray(picked.distractors) ? picked.distractors : [];
  currentShortAnswerLength = picked ? resolveShortAnswerLength(picked) : null;
  resolvedCount = 0;
  letterChoices = [];
  revealedAnswer = '';
  buzzedId = null;
  wrongLetterChoice = null;
  lastBuzzerId = null;
  lastBuzzerReactionMs = null;
  questionRevealedMs = 0;
  questionTypingStartedAt = null;
  questionOpenedAt = null;
  lockedOut.clear();
  phase = 'announce';
  broadcastState();
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    if (!started) return;
    phase = 'open';
    questionOpenedAt = Date.now();
    scheduleNoBuzzTimer();
    broadcastState();
    scheduleCpuBuzzIfNeeded();
  }, ANNOUNCE_DELAY_MS);
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
    questionNumber = 0;
    answer = '';
    resolvedCount = 0;
    letterChoices = [];
    revealedAnswer = '';
    buzzedId = null;
    wrongLetterChoice = null;
    lastBuzzerId = null;
    lastBuzzerReactionMs = null;
    questionRevealedMs = 0;
    questionTypingStartedAt = null;
    questionOpenedAt = null;
    lockedOut.clear();
    broadcastState();
  });

  socket.on('player:buzz', () => {
    if (!started || phase !== 'open') return;
    if (!players.has(socket.id) || socket.id === CPU_ID) return;
    if (lockedOut.has(socket.id)) return;
    cancelCpuTimer();
    cancelNoBuzzTimer();
    pauseQuestionTyping();
    buzzedId = socket.id;
    lastBuzzerId = socket.id;
    lastBuzzerReactionMs = questionOpenedAt !== null ? Date.now() - questionOpenedAt : null;
    resolvedCount = 0;
    isFirstLetterPick = true;
    phase = 'buzzed';
    advanceLetterOrFinish();
  });

  socket.on('player:answer', ({ choice } = {}) => {
    if (!started || phase !== 'buzzed' || socket.id !== buzzedId) return;
    if (typeof choice !== 'string' || !letterChoices.includes(choice)) return;
    resolveLetterChoice(choice);
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
      cancelLetterTimer();
      buzzedId = null;
      resolvedCount = 0;
      letterChoices = [];
      if (players.size === 0) {
        phase = 'open';
        broadcastState();
        return;
      }
      if (lockedOut.size >= players.size) {
        enterReveal();
      } else {
        phase = 'open';
        scheduleNoBuzzTimer();
        broadcastState();
        scheduleCpuBuzzIfNeeded();
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
