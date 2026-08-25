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
const statusBanner = document.getElementById('status-banner');
const buzzBtn = document.getElementById('buzz-btn');
const playerList = document.getElementById('player-list');
const questionDisplay = document.getElementById('question-display');
const revealBanner = document.getElementById('reveal-banner');
const choicesContainer = document.getElementById('choices');
const choiceButtons = document.querySelectorAll('.choice-btn');

buzzBtn.addEventListener('click', () => {
  socket.emit('player:buzz');
});

choiceButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    socket.emit('player:answer', { choice: btn.textContent });
  });
});

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

const TYPEWRITER_SPEED_MS = 140;
const revealState = { text: null, index: 0, timer: null };

// 早押しクイズなので問題文を1文字ずつ表示する。誰かが押している間は表示を止め、
// 誤答でopenに戻ったら続きから再開する。
function updateQuestionReveal(el, text, phase) {
  if (text !== revealState.text) {
    if (revealState.timer) clearInterval(revealState.timer);
    revealState.timer = null;
    revealState.text = text;
    revealState.index = 0;
    el.textContent = '';
    el.classList.toggle('hidden', !text);
    el.classList.remove('revealing');
    if (!text) return;
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

socket.on('state', (state) => {
  const {
    started,
    difficulty,
    phase,
    question,
    choices,
    wrongChoices,
    revealedAnswer,
    buzzedId,
    buzzedName,
    players,
  } = state;

  renderPlayerList(playerList, players, buzzedId);

  setupPanel.classList.toggle('hidden', started);
  playPanel.classList.toggle('hidden', !started);
  difficultyButtons.forEach((b) => b.classList.toggle('active', b.dataset.difficulty === difficulty));
  cpuToggle.checked = players.some((p) => p.id === 'cpu');
  activeDifficultyLabel.textContent = difficulty;

  if (!started) return;

  updateQuestionReveal(questionDisplay, question, phase);

  const me = players.find((p) => p.id === socket.id);
  const isSelfBuzzed = buzzedId === socket.id;

  revealBanner.classList.toggle('hidden', phase !== 'reveal');
  if (phase === 'reveal') {
    revealBanner.textContent = `正解は「${revealedAnswer}」でした！`;
  }

  choicesContainer.classList.toggle('hidden', phase === 'reveal' || !choices || choices.length === 0);
  choiceButtons.forEach((btn, i) => {
    const text = choices[i] || '';
    btn.textContent = text;
    btn.classList.toggle('wrong-choice', wrongChoices && wrongChoices.includes(text));
    btn.disabled = !(phase === 'buzzed' && isSelfBuzzed) || (wrongChoices && wrongChoices.includes(text));
  });

  if (phase === 'open') {
    statusBanner.textContent = '押せます！';
    statusBanner.className = 'status-banner open';
    buzzBtn.disabled = !me || me.locked;
  } else if (phase === 'buzzed') {
    if (isSelfBuzzed) {
      statusBanner.textContent = 'あなたが押しました！選択肢から答えを選んでください';
    } else {
      statusBanner.textContent = `${buzzedName} が回答中…`;
    }
    statusBanner.className = 'status-banner buzzed';
    buzzBtn.disabled = true;
  } else if (phase === 'reveal') {
    statusBanner.textContent = '正解発表';
    statusBanner.className = 'status-banner idle';
    buzzBtn.disabled = true;
  }
});
