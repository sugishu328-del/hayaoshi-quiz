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

function renderQuestion(el, question) {
  el.textContent = question || '';
  el.classList.toggle('hidden', !question);
}

socket.on('state', (state) => {
  const { phase, players, buzzedId, buzzedName, question } = state;

  // プレイヤー画面
  renderQuestion(questionDisplay, question);
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
  renderQuestion(hostQuestionDisplay, question);
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
    hostStatus.textContent = `${buzzedName} が回答権を獲得！`;
    hostStatus.className = 'status-banner buzzed';
    correctBtn.disabled = false;
    wrongBtn.disabled = false;
  }
});
