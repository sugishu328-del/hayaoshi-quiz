const socket = io();

const joinScreen = document.getElementById('join-screen');
const playerScreen = document.getElementById('player-screen');
const hostScreen = document.getElementById('host-screen');

const roleButtons = document.querySelectorAll('.role-btn');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');

let selectedRole = 'player';

roleButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    roleButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedRole = btn.dataset.role;
    nameInput.classList.toggle('hidden', selectedRole === 'host');
  });
});

joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (selectedRole === 'player' && !name) {
    nameInput.focus();
    return;
  }
  socket.emit('join', { name, role: selectedRole });
  joinScreen.classList.add('hidden');
  if (selectedRole === 'host') {
    hostScreen.classList.remove('hidden');
  } else {
    playerScreen.classList.remove('hidden');
  }
});

// ---- プレイヤー画面 ----
const statusBanner = document.getElementById('status-banner');
const buzzBtn = document.getElementById('buzz-btn');
const playerList = document.getElementById('player-list');

buzzBtn.addEventListener('click', () => {
  socket.emit('player:buzz');
});

// ---- 出題者画面 ----
const hostStatus = document.getElementById('host-status');
const openBtn = document.getElementById('open-btn');
const correctBtn = document.getElementById('correct-btn');
const wrongBtn = document.getElementById('wrong-btn');
const resetBtn = document.getElementById('reset-btn');
const hostPlayerList = document.getElementById('host-player-list');

const questionInput = document.getElementById('question-input');
const autoModeHint = document.getElementById('auto-mode-hint');
const hostAnswerDisplay = document.getElementById('host-answer-display');
const hostControls = document.getElementById('host-controls');
const modeButtons = document.querySelectorAll('.mode-btn');

const difficultySelect = document.getElementById('difficulty-select');
const difficultyButtons = document.querySelectorAll('.difficulty-btn');
const startAutoBtn = document.getElementById('start-auto-btn');
const autoSessionInfo = document.getElementById('auto-session-info');
const currentDifficultyLabel = document.getElementById('current-difficulty-label');
const changeDifficultyBtn = document.getElementById('change-difficulty-btn');

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.emit('host:setMode', { mode: btn.dataset.mode });
  });
});

difficultyButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.emit('host:setDifficulty', { difficulty: btn.dataset.difficulty });
  });
});

startAutoBtn.addEventListener('click', () => socket.emit('host:startAuto'));
changeDifficultyBtn.addEventListener('click', () => socket.emit('host:changeDifficulty'));

const cpuToggle = document.getElementById('cpu-toggle-checkbox');
cpuToggle.addEventListener('change', () => {
  socket.emit('host:setCpu', { enabled: cpuToggle.checked });
});

function applyHostPanel(mode, difficulty, autoStarted) {
  modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));

  const showDifficultySelect = mode === 'auto' && !autoStarted;
  const showAutoControls = mode === 'auto' && autoStarted;

  difficultySelect.classList.toggle('hidden', !showDifficultySelect);
  autoSessionInfo.classList.toggle('hidden', !showAutoControls);
  hostControls.classList.toggle('hidden', showDifficultySelect);
  questionInput.classList.toggle('hidden', mode !== 'manual');
  autoModeHint.classList.toggle('hidden', !showAutoControls);

  difficultyButtons.forEach((b) => b.classList.toggle('active', b.dataset.difficulty === difficulty));
  currentDifficultyLabel.textContent = difficulty;
}

openBtn.addEventListener('click', () => {
  socket.emit('host:open', { question: questionInput.value.trim() });
});
correctBtn.addEventListener('click', () => socket.emit('host:correct'));
wrongBtn.addEventListener('click', () => socket.emit('host:wrong'));
resetBtn.addEventListener('click', () => socket.emit('host:reset'));

function renderPlayerList(container, players, buzzedId) {
  container.innerHTML = '';
  players
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach((p) => {
      const li = document.createElement('li');
      li.textContent = `${p.name}（${p.score}点）`;
      if (p.locked) li.classList.add('locked');
      if (p.id === buzzedId) li.classList.add('buzzed');
      container.appendChild(li);
    });
}

const questionDisplay = document.getElementById('question-display');
const hostQuestionDisplay = document.getElementById('host-question-display');

const TYPEWRITER_SPEED_MS = 70;

function createRevealState() {
  return { text: null, index: 0, timer: null };
}

const playerReveal = createRevealState();
const hostReveal = createRevealState();

// 早押しクイズなので問題文を1文字ずつ表示する。同じ問題文が続く間はアニメーションを再開しない。
// buzzed中は読み上げが止まっている想定で表示も止め、openに戻ったら続きから再開する。
function updateQuestionReveal(state, el, text, phase) {
  if (text !== state.text) {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.text = text;
    state.index = 0;
    el.textContent = '';
    el.classList.toggle('hidden', !text);
    el.classList.remove('revealing');
    if (!text) return;
  }

  if (phase !== 'open') {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
      el.classList.remove('revealing');
    }
    return;
  }

  if (state.index >= state.text.length || state.timer) return;

  el.classList.add('revealing');
  state.timer = setInterval(() => {
    state.index++;
    el.textContent = state.text.slice(0, state.index);
    if (state.index >= state.text.length) {
      clearInterval(state.timer);
      state.timer = null;
      el.classList.remove('revealing');
    }
  }, TYPEWRITER_SPEED_MS);
}

function renderInstant(el, text) {
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

socket.on('state', (state) => {
  const { phase, players, buzzedId, buzzedName, question, mode, answer, difficulty, autoStarted } = state;

  // プレイヤー画面
  updateQuestionReveal(playerReveal, questionDisplay, question, phase);
  renderPlayerList(playerList, players, buzzedId);
  const isSelfBuzzed = buzzedId === socket.id;
  if (phase === 'idle') {
    statusBanner.textContent = '出題を待っています…';
    statusBanner.className = 'status-banner idle';
    buzzBtn.disabled = true;
  } else if (phase === 'open') {
    statusBanner.textContent = '押せます！';
    statusBanner.className = 'status-banner open';
    const me = players.find((p) => p.id === socket.id);
    buzzBtn.disabled = !me || me.locked;
  } else if (phase === 'buzzed') {
    statusBanner.textContent = isSelfBuzzed ? 'あなたが押しました！' : `${buzzedName} が押しました`;
    statusBanner.className = 'status-banner buzzed';
    buzzBtn.disabled = true;
  }

  // 出題者画面
  applyHostPanel(mode, difficulty, autoStarted);
  modeButtons.forEach((b) => (b.disabled = phase !== 'idle'));
  cpuToggle.checked = players.some((p) => p.id === 'cpu');
  cpuToggle.disabled = phase !== 'idle';
  updateQuestionReveal(hostReveal, hostQuestionDisplay, question, phase);
  renderInstant(hostAnswerDisplay, answer ? `正解: ${answer}` : '');
  renderPlayerList(hostPlayerList, players, buzzedId);
  if (phase === 'idle') {
    hostStatus.textContent = '待機中';
    hostStatus.className = 'status-banner idle';
    correctBtn.disabled = true;
    wrongBtn.disabled = true;
    if (!question) questionInput.value = '';
  } else if (phase === 'open') {
    hostStatus.textContent = '受付中…';
    hostStatus.className = 'status-banner open';
    correctBtn.disabled = true;
    wrongBtn.disabled = true;
  } else if (phase === 'buzzed') {
    hostStatus.className = 'status-banner buzzed';
    if (buzzedId === 'cpu') {
      hostStatus.textContent = 'CPUが回答中…（自動判定）';
      correctBtn.disabled = true;
      wrongBtn.disabled = true;
    } else {
      hostStatus.textContent = `${buzzedName} が回答権を獲得！`;
      correctBtn.disabled = false;
      wrongBtn.disabled = false;
    }
  }
});
