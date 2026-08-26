const socket = io();

const joinScreen = document.getElementById('join-screen');
const gameScreen = document.getElementById('game-screen');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');

joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }
  socket.emit('join', { name });
  joinScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
});

// ---- セットアップパネル（誰でも操作可） ----
const gameTitle = document.getElementById('game-title');
const setupPanel = document.getElementById('setup-panel');
const playPanel = document.getElementById('play-panel');
const difficultyButtons = document.querySelectorAll('.difficulty-btn');
const cpuToggle = document.getElementById('cpu-toggle-checkbox');
const startGameBtn = document.getElementById('start-game-btn');
const endGameBtn = document.getElementById('end-game-btn');
const activeDifficultyLabel = document.getElementById('active-difficulty-label');

difficultyButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.emit('game:setDifficulty', { difficulty: btn.dataset.difficulty });
  });
});

cpuToggle.addEventListener('change', () => {
  socket.emit('game:setCpu', { enabled: cpuToggle.checked });
});

startGameBtn.addEventListener('click', () => socket.emit('game:start'));
endGameBtn.addEventListener('click', () => socket.emit('game:end'));

// ---- プレイ画面 ----
// 出たり消えたりする要素は display ではなく visibility を切り替える（invisibleクラス）。
// こうすることで、非表示になっても場所は確保されたままになり、下にあるボタンなどの
// 位置がフェーズの切り替わりで動かない（画面の上下が固定される）。
const statusBanner = document.getElementById('status-banner');
const buzzBtn = document.getElementById('buzz-btn');
const playerList = document.getElementById('player-list');
const questionNumberEl = document.getElementById('question-number');
const questionDisplay = document.getElementById('question-display');
const letterTimerEl = document.getElementById('letter-timer');

// 誰かが解答中（buzzed）、または誤答直後（wrong）は、問題文の上に
// 半透明の背景つきポップアップで表示する。
const buzzOverlay = document.getElementById('buzz-overlay');
const buzzLive = document.getElementById('buzz-live');
const buzzAvatar = document.getElementById('buzz-avatar');
const buzzCardStatus = document.getElementById('buzz-card-status');
const choicesContainer = document.getElementById('choices');
const choiceButtons = document.querySelectorAll('.choice-btn');
const answerProgressText = document.getElementById('answer-progress-text');
const wrongResult = document.getElementById('wrong-result');
const wrongResultLetter = document.getElementById('wrong-result-letter');

buzzBtn.addEventListener('click', () => {
  socket.emit('player:buzz');
});

choiceButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    socket.emit('player:answer', { choice: btn.textContent });
  });
});

// 1文字ごとの制限時間を見た目でカウントダウン表示する（実際の判定はサーバー側で行う）。
// 早押し直後の1文字目だけ5秒、2文字目以降は3秒。
const FIRST_LETTER_TIMEOUT_SECONDS = 5;
const LETTER_TIMEOUT_SECONDS = 3;
const letterCountdown = { key: null, timer: null, remaining: 0 };

function stopLetterCountdown() {
  if (letterCountdown.timer) {
    clearInterval(letterCountdown.timer);
    letterCountdown.timer = null;
  }
  letterCountdown.key = null;
  letterTimerEl.textContent = '';
}

function updateLetterCountdown(active, key, isFirstLetter) {
  if (!active) {
    stopLetterCountdown();
    return;
  }
  if (letterCountdown.key === key) return;
  stopLetterCountdown();
  letterCountdown.key = key;
  letterCountdown.remaining = isFirstLetter ? FIRST_LETTER_TIMEOUT_SECONDS : LETTER_TIMEOUT_SECONDS;
  letterTimerEl.textContent = String(letterCountdown.remaining);
  letterCountdown.timer = setInterval(() => {
    letterCountdown.remaining--;
    letterTimerEl.textContent = String(Math.max(letterCountdown.remaining, 0));
    if (letterCountdown.remaining <= 0) {
      clearInterval(letterCountdown.timer);
      letterCountdown.timer = null;
    }
  }, 1000);
}

// 上部の参加者バーは横並びの小さいチップ表示（人数が増えても1行に収まるよう縮む）。
function renderPlayerList(container, players, buzzedId) {
  container.innerHTML = '';
  players
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach((p) => {
      const li = document.createElement('li');
      li.textContent = `${p.name} ${p.score}点`;
      li.title = `${p.name}（${p.score}点）`;
      if (p.locked) li.classList.add('locked');
      if (p.id === buzzedId) li.classList.add('buzzed');
      container.appendChild(li);
    });
}

const TYPEWRITER_SPEED_MS = 140;
const revealState = { text: null, index: 0, timer: null };

// 早押しクイズなので問題文を1文字ずつ表示する。誰かが押している間は表示を止め、
// 誤答でopenに戻ったら続きから再開する。正解して発表(reveal)に入ったら全文を表示する。
function updateQuestionReveal(el, text, phase) {
  if (text !== revealState.text) {
    if (revealState.timer) clearInterval(revealState.timer);
    revealState.timer = null;
    revealState.text = text;
    revealState.index = 0;
    el.textContent = '';
    el.classList.remove('revealing');
    if (!text) return;
  }

  if (phase === 'reveal') {
    if (revealState.timer) {
      clearInterval(revealState.timer);
      revealState.timer = null;
    }
    revealState.index = revealState.text.length;
    el.textContent = revealState.text;
    el.classList.remove('revealing');
    return;
  }

  if (phase !== 'open') {
    if (revealState.timer) {
      clearInterval(revealState.timer);
      revealState.timer = null;
      el.classList.remove('revealing');
    }
    return;
  }

  if (revealState.index >= revealState.text.length || revealState.timer) return;

  el.classList.add('revealing');
  revealState.timer = setInterval(() => {
    revealState.index++;
    el.textContent = revealState.text.slice(0, revealState.index);
    if (revealState.index >= revealState.text.length) {
      clearInterval(revealState.timer);
      revealState.timer = null;
      el.classList.remove('revealing');
    }
  }, TYPEWRITER_SPEED_MS);
}

// 問題文の表示が終わったのに誰も押さないままだと、サーバーが一定時間後に
// 自動で正解発表へ進む。その残り秒数をここでカウントダウン表示する。
// （表示が終わったかどうかはこのクライアント自身のタイプライター表示の完了で判断する）
let currentPhase = null;
let currentNoBuzzDeadline = null;

function tickNoBuzzCountdown() {
  if (currentPhase !== 'open' || !currentNoBuzzDeadline) return;
  const isTypingDone = revealState.text !== null && revealState.index >= revealState.text.length;
  if (!isTypingDone) return;
  const remaining = Math.max(0, Math.ceil((currentNoBuzzDeadline - Date.now()) / 1000));
  statusBanner.textContent = `あと${remaining}秒で自動的に正解発表します`;
  statusBanner.className = 'status-banner countdown';
  statusBanner.classList.remove('invisible');
}
setInterval(tickNoBuzzCountdown, 250);

socket.on('state', (state) => {
  const {
    started,
    difficulty,
    phase,
    question,
    questionNumber,
    answerProgress,
    letterChoices,
    revealedAnswer,
    noBuzzDeadline,
    wrongLetterChoice,
    buzzedId,
    buzzedName,
    players,
  } = state;

  currentPhase = started ? phase : null;
  currentNoBuzzDeadline = noBuzzDeadline;

  renderPlayerList(playerList, players, buzzedId);

  gameTitle.classList.toggle('hidden', started);
  setupPanel.classList.toggle('hidden', started);
  playPanel.classList.toggle('hidden', !started);
  difficultyButtons.forEach((b) => b.classList.toggle('active', b.dataset.difficulty === difficulty));
  cpuToggle.checked = players.some((p) => p.id === 'cpu');
  activeDifficultyLabel.textContent = difficulty;

  if (!started) return;

  // 正解発表の後、次の問題文が出る前に「第N問」だけを一瞬表示する。
  // question-number と question-display は同じ枠に重ねて表示し、
  // 入れ替わってもレイアウトの高さが変わらないようにする。
  questionNumberEl.textContent = `第${questionNumber}問`;
  questionNumberEl.classList.toggle('invisible', phase !== 'announce');
  questionDisplay.classList.toggle('invisible', phase === 'announce');
  updateQuestionReveal(questionDisplay, question, phase);

  const me = players.find((p) => p.id === socket.id);
  const isSelfBuzzed = buzzedId === socket.id;

  // 解答の進捗（確定した文字）は全員に見せる。選択肢のボタンは早押しに勝った本人にだけ表示する。
  // 誤答した瞬間（wrong）は、同じポップアップの中身を「✕不正解」表示に切り替える。
  const showProgress = phase === 'buzzed';
  const showWrong = phase === 'wrong';
  const showChoices = phase === 'buzzed' && isSelfBuzzed && letterChoices && letterChoices.length > 0;
  buzzOverlay.classList.toggle('hidden', !showProgress && !showWrong);
  buzzLive.classList.toggle('hidden', !showProgress);
  wrongResult.classList.toggle('hidden', !showWrong);
  if (showProgress) {
    buzzAvatar.textContent = (buzzedName || '?').slice(0, 1);
    buzzCardStatus.textContent = isSelfBuzzed ? 'あなたが解答中…' : `${buzzedName} が解答中…`;
  }
  if (showWrong) {
    wrongResultLetter.textContent = wrongLetterChoice || '';
  }
  answerProgressText.textContent = answerProgress || '';
  updateLetterCountdown(showProgress, (answerProgress || '').length, (answerProgress || '').length === 0);

  choicesContainer.classList.toggle('hidden', !showChoices);
  choiceButtons.forEach((btn, i) => {
    btn.textContent = letterChoices[i] || '';
    btn.disabled = false;
  });

  if (phase === 'buzzed') {
    statusBanner.classList.add('invisible');
    buzzBtn.disabled = true;
  } else if (phase === 'reveal') {
    statusBanner.textContent = `正解は「${revealedAnswer}」でした！`;
    statusBanner.className = 'status-banner reveal';
    statusBanner.classList.remove('invisible');
    buzzBtn.disabled = true;
  } else {
    // announce / open
    statusBanner.classList.add('invisible');
    buzzBtn.disabled = phase !== 'open' || !me || me.locked;
  }
});
