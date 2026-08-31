const socket = io();

// crypto.randomUUID()はセキュアコンテキスト（httpsまたはlocalhost）でしか使えないため、
// スマホ実機からLAN内のIPアドレス（http://192.168.x.x など）で開いた場合は使えず、
// 呼び出すと例外で処理全体が止まってしまう。その場合は簡易的なID生成にフォールバックする。
function generateId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// clientIdはこのブラウザに永続的に紐づく識別子（localStorageに保存）。socket.idは
// 再接続のたびに変わってしまうが、これを使うことで切断→再接続してもサーバー側で
// 同一人物として認識され、スコアを引き継げる。
function getClientId() {
  const key = 'hayaoshi_client_id';
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = generateId();
      localStorage.setItem(key, id);
    }
    return id;
  } catch (e) {
    // プライベートブラウジング等でlocalStorageが使えない場合は、その場限りのIDで動かす
    return generateId();
  }
}
const clientId = getClientId();

// ---- プロフィール（アカウント作成で名前・アイコンを保存する機能） ----
// gameData.jsのICON_CHOICESと同じ内容。ブラウザ側はバンドラを使っておらずrequireできないため
// 直接書いている（増減する際は両方を合わせて変更する）。
const ICON_CHOICES = ['🦊', '🐱', '🐶', '🐻', '🦁', '🐰', '🐼', '🐨'];
const PROFILE_KEY = 'hayaoshi_profile';

function getProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.name !== 'string' || !ICON_CHOICES.includes(parsed.icon)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function saveProfile(name, icon) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ name, icon }));
  } catch (e) {
    // localStorageが使えない環境では保存を諦める（次回もゲスト扱いになるだけで、動作は継続できる）
  }
}

// ---- 効果音のON/OFF設定 ----
const SOUND_ENABLED_KEY = 'hayaoshi_sound_enabled';

function getSoundEnabled() {
  try {
    const raw = localStorage.getItem(SOUND_ENABLED_KEY);
    return raw === null ? true : raw === 'true';
  } catch (e) {
    return true;
  }
}

function setSoundEnabled(enabled) {
  try {
    localStorage.setItem(SOUND_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch (e) {
    // 保存できなくても今回のセッション中は効くので、そのまま続行
  }
}
let soundEnabled = getSoundEnabled();

// ---- 効果音 ----
// public/sounds/ に置いた音声ファイルをWeb Audio APIで鳴らす。<audio>要素の.play()を
// 毎回呼ぶ方式だと、呼んでから実際に音が出るまでスマホで数百ms単位のラグが出ることが
// あるため、あらかじめ音声データをデコードして持っておき、AudioContextから低遅延で
// 再生する方式にしている。スマホのブラウザは「ユーザー操作なしの音声再生」をブロック
// するため、AudioContextは最初のタップ（参加するボタン）で生成する。
let audioCtx = null;
const sfxBuffers = {}; // { buzz: AudioBuffer, announce: ..., correct: ..., wrong: ... }
const SFX_NAMES = ['buzz', 'announce', 'correct', 'wrong'];

function unlockAudio() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  SFX_NAMES.forEach((name) => {
    fetch(`sounds/${name}.mp3`)
      .then((res) => res.arrayBuffer())
      .then((buf) => audioCtx.decodeAudioData(buf))
      .then((decoded) => { sfxBuffers[name] = decoded; })
      .catch(() => {});
  });
}

// startAt: 音声ファイル先頭の無音部分を飛ばして再生を始める位置（秒）
// playDurationMs: 「○正解」「第N問」等のポップアップの表示時間に合わせて途中で
//   フェードアウトさせるための、再生開始からの長さ（ミリ秒）。nullなら最後まで再生する。
function playSfx(name, { startAt = 0, playDurationMs = null, fadeMs = 150 } = {}) {
  if (!soundEnabled) return;
  const buffer = sfxBuffers[name];
  if (!audioCtx || !buffer) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  const gain = audioCtx.createGain();
  source.connect(gain);
  gain.connect(audioCtx.destination);

  const now = audioCtx.currentTime;
  if (playDurationMs === null) {
    gain.gain.setValueAtTime(1, now);
    source.start(now, startAt);
    return;
  }
  const fadeStartSec = Math.max(0, playDurationMs - fadeMs) / 1000;
  const fadeEndSec = playDurationMs / 1000;
  gain.gain.setValueAtTime(1, now + fadeStartSec);
  gain.gain.linearRampToValueAtTime(0.0001, now + fadeEndSec);
  source.start(now, startAt);
  source.stop(now + fadeEndSec + 0.02);
}

function playBuzzSound() { playSfx('buzz'); }
// 「第N問」の表示は1.5秒（ANNOUNCE_DELAY_MS, server.js）なので、表示が消えた後まで
// 音が鳴り続けてズレて聞こえないよう、そこに収まるようフェードアウトさせる。
function playAnnounceSound() { playSfx('announce', { playDurationMs: 1450 }); }
// 「○正解」の表示は1.5秒（CORRECT_ANSWER_DELAY_MS, server.js）。この音声ファイルは
// 先頭に少し無音があるので、そこを飛ばしてから鳴らし、かつ表示時間に収まるようにする。
function playCorrectSound() { playSfx('correct', { startAt: 0.08, playDurationMs: 1450 }); }
function playWrongSound() { playSfx('wrong'); }

const joinScreen = document.getElementById('join-screen');
const gameScreen = document.getElementById('game-screen');
const nameInput = document.getElementById('name-input');
const modeTrainingBtn = document.getElementById('mode-training-btn');
const modeFriendBtn = document.getElementById('mode-friend-btn');
const profileModeCard = document.getElementById('profile-mode-card');
const profileModeGuestBtn = document.getElementById('profile-mode-guest-btn');
const profileModeAccountBtn = document.getElementById('profile-mode-account-btn');
const iconPicker = document.getElementById('icon-picker');
const nameCard = document.getElementById('name-card');
const profileDisplayCard = document.getElementById('profile-display-card');
const profileDisplayAvatar = document.getElementById('profile-display-avatar');
const profileDisplayName = document.getElementById('profile-display-name');

let hasJoined = false;
let savedName = '';
let selectedMode = null; // 'training' | 'friend'
let joinIcon = null; // 参加時に送るアイコン（絵文字）。ゲスト等でnullなら名前の頭文字を表示する
let profileModeIsAccount = false; // 初回のゲスト/アカウント作成タブでどちらを選んでいるか

// アイコン選択グリッドを描画する。参加画面・設定ポップアップの2箇所で共通利用する。
function renderIconPicker(container, selected, onSelect) {
  container.innerHTML = '';
  ICON_CHOICES.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-choice-btn' + (emoji === selected ? ' active' : '');
    btn.textContent = emoji;
    btn.addEventListener('click', () => onSelect(emoji));
    container.appendChild(btn);
  });
}

function selectJoinIcon(emoji) {
  joinIcon = emoji;
  renderIconPicker(iconPicker, joinIcon, selectJoinIcon);
}

function setProfileMode(mode) {
  profileModeIsAccount = mode === 'account';
  profileModeGuestBtn.classList.toggle('active', mode === 'guest');
  profileModeAccountBtn.classList.toggle('active', mode === 'account');
  if (mode === 'guest') {
    iconPicker.classList.add('hidden');
    joinIcon = null;
  } else {
    iconPicker.classList.remove('hidden');
    selectJoinIcon(ICON_CHOICES[0]);
  }
}

profileModeGuestBtn.addEventListener('click', () => setProfileMode('guest'));
profileModeAccountBtn.addEventListener('click', () => setProfileMode('account'));

// 保存済みプロフィール（アカウント作成済み）があれば、ゲスト/アカウント作成の選択と
// 名前入力欄自体を省略し、代わりにアイコン+名前を「表示」するカードに差し替える。
// 無ければ今まで通り選択・名前入力から始める。
function initProfileUi() {
  const profile = getProfile();
  if (profile) {
    profileModeCard.classList.add('hidden');
    nameCard.classList.add('hidden');
    profileDisplayCard.classList.remove('hidden');
    profileDisplayAvatar.textContent = profile.icon;
    profileDisplayName.textContent = profile.name;
    joinIcon = profile.icon;
  } else {
    profileModeCard.classList.remove('hidden');
    nameCard.classList.remove('hidden');
    profileDisplayCard.classList.add('hidden');
    setProfileMode('guest');
  }
}
initProfileUi();

// プロフィール表示カードをタップすると、設定ポップアップのプロフィール編集を直接開く。
profileDisplayCard.addEventListener('click', () => {
  openSettings();
  openProfileEdit();
});

function doJoin(name, mode) {
  savedName = name;
  selectedMode = mode;
  hasJoined = true;
  // 参加ボタンを押すまでの間に（他の人のプレイで）フェーズが進んでいても、
  // 参加した直後に届く最初のstateを「切り替わった」と誤判定して音を鳴らさないようにする。
  sfxPhaseInitialized = false;
  socket.emit('join', { name, clientId, mode, icon: joinIcon });
}

// 画面ロック・電波切れ等で切断された後、socket.ioが自動で再接続したときに
// 自動で再参加させる（clientId・modeが同じなのでサーバー側で同じ部屋・スコアに戻れる）。
socket.on('connect', () => {
  if (hasJoined) {
    sfxPhaseInitialized = false;
    socket.emit('join', { name: savedName, clientId, mode: selectedMode, icon: joinIcon });
  }
});

function startJoinFlow(mode) {
  const profile = getProfile();
  const name = profile ? profile.name : nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }
  unlockAudio();
  // 初めて「アカウント作成」を選んだ状態でここまで来たら、この時点で名前・アイコンを保存する
  // （以後はこの画面が省略され、保存した内容で自動的に参加できるようになる）。
  if (!profileModeCard.classList.contains('hidden') && profileModeIsAccount) {
    saveProfile(name, joinIcon);
  }
  // 直前まで別の部屋にいた場合、参加直後にすぐゲーム画面を表示すると、新しい部屋の状態が
  // 届くまでの一瞬だけ前の部屋の表示（CPU参加ボタンの有無、難易度の選択状態など）が
  // 残って見えてしまう。新しい部屋のstateが届く（＝画面が正しく更新される）まで待ってから
  // 画面を切り替える。
  socket.once('state', () => {
    joinScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
  });
  doJoin(name, mode);
}

modeTrainingBtn.addEventListener('click', () => startJoinFlow('training'));
modeFriendBtn.addEventListener('click', () => startJoinFlow('friend'));

// ---- 設定ポップアップ（参加画面からのみ開く。プロフィール編集・効果音ON/OFF） ----
const settingsBtn = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsProfileView = document.getElementById('settings-profile-view');
const settingsProfileEmpty = document.getElementById('settings-profile-empty');
const settingsProfileEdit = document.getElementById('settings-profile-edit');
const settingsProfileAvatar = document.getElementById('settings-profile-avatar');
const settingsProfileName = document.getElementById('settings-profile-name');
const settingsEditProfileBtn = document.getElementById('settings-edit-profile-btn');
const settingsCreateProfileBtn = document.getElementById('settings-create-profile-btn');
const settingsNameInput = document.getElementById('settings-name-input');
const settingsIconPicker = document.getElementById('settings-icon-picker');
const settingsEditCancelBtn = document.getElementById('settings-edit-cancel-btn');
const settingsEditSaveBtn = document.getElementById('settings-edit-save-btn');
const soundToggleCheckbox = document.getElementById('sound-toggle-checkbox');

let settingsEditIcon = null;

function selectSettingsIcon(emoji) {
  settingsEditIcon = emoji;
  renderIconPicker(settingsIconPicker, settingsEditIcon, selectSettingsIcon);
}

// プロフィールの有無に応じて「表示」か「未作成」のどちらかを見せる（編集フォームは閉じる）。
function showSettingsProfileState() {
  settingsProfileEdit.classList.add('hidden');
  const profile = getProfile();
  if (profile) {
    settingsProfileView.classList.remove('hidden');
    settingsProfileEmpty.classList.add('hidden');
    settingsProfileAvatar.textContent = profile.icon;
    settingsProfileName.textContent = profile.name;
  } else {
    settingsProfileView.classList.add('hidden');
    settingsProfileEmpty.classList.remove('hidden');
  }
}

function openSettings() {
  showSettingsProfileState();
  soundToggleCheckbox.checked = soundEnabled;
  settingsOverlay.classList.remove('hidden');
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
}

function openProfileEdit() {
  const profile = getProfile();
  settingsNameInput.value = profile ? profile.name : '';
  selectSettingsIcon(profile ? profile.icon : ICON_CHOICES[0]);
  settingsProfileView.classList.add('hidden');
  settingsProfileEmpty.classList.add('hidden');
  settingsProfileEdit.classList.remove('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsCloseBtn.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});
settingsEditProfileBtn.addEventListener('click', openProfileEdit);
settingsCreateProfileBtn.addEventListener('click', openProfileEdit);
settingsEditCancelBtn.addEventListener('click', showSettingsProfileState);
settingsEditSaveBtn.addEventListener('click', () => {
  const name = settingsNameInput.value.trim();
  if (!name) {
    settingsNameInput.focus();
    return;
  }
  saveProfile(name, settingsEditIcon);
  // 参加画面側にも即座に反映する（ゲスト/アカウント作成の選択自体を今後省略できるように）。
  initProfileUi();
  showSettingsProfileState();
});
soundToggleCheckbox.addEventListener('change', () => {
  soundEnabled = soundToggleCheckbox.checked;
  setSoundEnabled(soundEnabled);
});

// ---- モード選択に戻る ----
const backToModeBtn = document.getElementById('back-to-mode-btn');
const leaveConfirmOverlay = document.getElementById('leave-confirm-overlay');
const leaveConfirmCancelBtn = document.getElementById('leave-confirm-cancel');
const leaveConfirmOkBtn = document.getElementById('leave-confirm-ok');
let currentlyStarted = false;

function leaveToModeSelect() {
  socket.emit('leave');
  hasJoined = false;
  selectedMode = null;
  gameScreen.classList.add('hidden');
  joinScreen.classList.remove('hidden');
  // 設定でプロフィールを作成/変更した直後の可能性があるので、ゲスト/アカウント作成の
  // 選択欄の表示・非表示を再判定する。
  initProfileUi();
}

backToModeBtn.addEventListener('click', () => {
  if (currentlyStarted) {
    leaveConfirmOverlay.classList.remove('hidden');
  } else {
    leaveToModeSelect();
  }
});
leaveConfirmCancelBtn.addEventListener('click', () => {
  leaveConfirmOverlay.classList.add('hidden');
});
leaveConfirmOkBtn.addEventListener('click', () => {
  leaveConfirmOverlay.classList.add('hidden');
  leaveToModeSelect();
});

// ---- セットアップパネル（誰でも操作可） ----
const setupPanel = document.getElementById('setup-panel');
const playPanel = document.getElementById('play-panel');
const difficultyButtons = document.querySelectorAll('.difficulty-btn');
const cpuToggleRow = document.querySelector('.cpu-toggle');
const cpuToggle = document.getElementById('cpu-toggle-checkbox');
const winScoreInput = document.getElementById('win-score-input');
const questionLimitInput = document.getElementById('question-limit-input');
const wrongPenaltyInput = document.getElementById('wrong-penalty-input');
const wrongLimitInput = document.getElementById('wrong-limit-input');
const winScoreUnit = document.getElementById('win-score-unit');
const questionLimitUnit = document.getElementById('question-limit-unit');
const wrongPenaltyUnit = document.getElementById('wrong-penalty-unit');
const wrongLimitUnit = document.getElementById('wrong-limit-unit');

// 「制限なし」等のプレースホルダー表示中は単位を隠し、数値が入っている時だけ見せる。
function syncStepperUnit(input, unitEl) {
  unitEl.classList.toggle('hidden', input.value === '');
}
[[winScoreInput, winScoreUnit], [questionLimitInput, questionLimitUnit], [wrongPenaltyInput, wrongPenaltyUnit], [wrongLimitInput, wrongLimitUnit]].forEach(([input, unit]) => {
  input.addEventListener('input', () => syncStepperUnit(input, unit));
});
const startGameBtn = document.getElementById('start-game-btn');
const endGameBtn = document.getElementById('end-game-btn');
const questionNumberBadge = document.getElementById('question-number-badge');

difficultyButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.emit('game:setDifficulty', { difficulty: btn.dataset.difficulty });
  });
});

cpuToggle.addEventListener('change', () => {
  socket.emit('game:setCpu', { enabled: cpuToggle.checked });
});

// 空欄・0は「制限なし」として送る。
winScoreInput.addEventListener('change', () => {
  socket.emit('game:setWinScore', { winScore: winScoreInput.value === '' ? 0 : Number(winScoreInput.value) });
});
questionLimitInput.addEventListener('change', () => {
  socket.emit('game:setQuestionLimit', { questionLimit: questionLimitInput.value === '' ? 0 : Number(questionLimitInput.value) });
});
wrongPenaltyInput.addEventListener('change', () => {
  socket.emit('game:setWrongPenalty', { wrongPenalty: wrongPenaltyInput.value === '' ? 0 : Number(wrongPenaltyInput.value) });
});
wrongLimitInput.addEventListener('change', () => {
  socket.emit('game:setWrongLimit', { wrongLimit: wrongLimitInput.value === '' ? 0 : Number(wrongLimitInput.value) });
});

// 先取点数・出題数上限の±ボタン。対象のinputの値を直接書き換えてchangeイベントを
// 発火させることで、上のリスナー（サーバーへの送信）をそのまま再利用する。
document.querySelectorAll('.step-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.stepTarget);
    const delta = Number(btn.dataset.stepDelta);
    const current = target.value === '' ? 0 : Number(target.value);
    const next = Math.max(0, Math.min(99, current + delta));
    target.value = next > 0 ? next : '';
    target.dispatchEvent(new Event('change'));
  });
});

startGameBtn.addEventListener('click', () => socket.emit('game:start'));

// 「終了」は誤タップで即ゲームが終わってしまわないよう、確認ポップアップを挟む。
const endConfirmOverlay = document.getElementById('end-confirm-overlay');
const endConfirmCancelBtn = document.getElementById('end-confirm-cancel');
const endConfirmOkBtn = document.getElementById('end-confirm-ok');

endGameBtn.addEventListener('click', () => {
  endConfirmOverlay.classList.remove('hidden');
});
endConfirmCancelBtn.addEventListener('click', () => {
  endConfirmOverlay.classList.add('hidden');
});
endConfirmOkBtn.addEventListener('click', () => {
  endConfirmOverlay.classList.add('hidden');
  socket.emit('game:end');
});

// 先取点数・出題数上限に到達すると自動的にこの画面になる（確認なしでそのまま終了してよい）。
const gameOverOverlay = document.getElementById('game-over-overlay');
const gameOverRanking = document.getElementById('game-over-ranking');
const gameOverCloseBtn = document.getElementById('game-over-close-btn');

gameOverCloseBtn.addEventListener('click', () => {
  socket.emit('game:end');
});

function renderGameOverRanking(players) {
  gameOverRanking.innerHTML = '';
  const sorted = players.slice().sort((a, b) => b.score - a.score);
  const topScore = sorted.length > 0 ? sorted[0].score : 0;
  sorted.forEach((p) => {
    const li = document.createElement('li');
    if (p.score === topScore && topScore > 0) li.classList.add('winner');
    const name = document.createElement('span');
    name.className = 'game-over-name';
    name.textContent = p.name;
    const score = document.createElement('span');
    score.className = 'game-over-score';
    score.textContent = `${p.score}点`;
    li.appendChild(name);
    li.appendChild(score);
    gameOverRanking.appendChild(li);
  });
}

// ---- プレイ画面 ----
// 出たり消えたりする要素は display ではなく visibility を切り替える（invisibleクラス）。
// こうすることで、非表示になっても場所は確保されたままになり、下にあるボタンなどの
// 位置がフェーズの切り替わりで動かない（画面の上下が固定される）。
const revealTimerBar = document.getElementById('reveal-timer-bar');
const buzzBtn = document.getElementById('buzz-btn');
const playerList = document.getElementById('player-list');
const questionNumberEl = document.getElementById('question-number');
const questionDisplay = document.getElementById('question-display');
const questionTextEl = document.getElementById('question-text');
const answerRevealLabel = document.getElementById('answer-reveal-label');
const answerRevealAnswerEl = document.getElementById('answer-reveal-answer');
const answerRevealInputEl = document.getElementById('answer-reveal-input');
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
const correctResult = document.getElementById('correct-result');
const correctResultLetter = document.getElementById('correct-result-letter');

buzzBtn.addEventListener('click', () => {
  playBuzzSound();
  socket.emit('player:buzz');
});

choiceButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    // 連打（ダブルタップ）で次の文字の選択肢に古いクリックが誤爆しないよう、
    // 送信直後に全ボタンを無効化する（次のstateで再度有効化される）。
    choiceButtons.forEach((b) => { b.disabled = true; });
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
// 誰かが押した直後（buzzed/wrong/correct）は、その人のチップに反応時間を添える。
// プロフィールでアイコン（絵文字）を設定していればそれを、無ければ名前の頭文字を表示する。
function setAvatarContent(el, name, icon) {
  el.textContent = icon || (name || '?').slice(0, 1);
}

function renderPlayerList(container, players, buzzedId, showReactionFor, reactionMs) {
  container.innerHTML = '';
  players
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach((p) => {
      const li = document.createElement('li');
      li.title = `${p.name}（${p.score}点）`;
      if (p.locked) li.classList.add('locked');
      if (p.id === buzzedId) li.classList.add('buzzed');

      // アイコン用のスペース（今は名前の頭文字を丸の中に表示。将来カスタムアイコンに差し替え予定）。
      const avatar = document.createElement('span');
      avatar.className = 'player-avatar';
      setAvatarContent(avatar, p.name, p.icon);
      li.appendChild(avatar);

      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = p.name;
      li.appendChild(name);

      const score = document.createElement('span');
      score.className = 'player-score';
      score.textContent = `${p.score}点`;
      li.appendChild(score);

      // 反応時間バッジはアイコンの右上に重ねて表示する（カード内の行として追加すると
      // カードの高さが変わり、バー全体の位置がガタつくため、アイコンに乗せる形にする）。
      if (showReactionFor && p.id === showReactionFor && typeof reactionMs === 'number') {
        const badge = document.createElement('span');
        badge.className = 'reaction-badge';
        badge.textContent = `${(reactionMs / 1000).toFixed(2)}秒`;
        avatar.appendChild(badge);
      }
      container.appendChild(li);
    });
}

const TYPEWRITER_SPEED_MS = 140;
const CORRECT_REVEAL_SPEED_MS = 47; // 正解後、残りの問題文を続きから表示するときの速さ（出題時より速い）
const revealState = { text: null, index: 0, timer: null };

// 早押しクイズなので問題文を1文字ずつ表示する。誰かが押している間は表示を止め、
// 誤答でopenに戻ったら続きから再開する。正解後(correctReveal)も続きから、出題時より速く表示する。
// 誰も正解しなかった場合の発表(reveal)だけは全文を即表示する。
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

  if (phase !== 'open' && phase !== 'correctReveal') {
    if (revealState.timer) {
      clearInterval(revealState.timer);
      revealState.timer = null;
      el.classList.remove('revealing');
    }
    return;
  }

  if (revealState.index >= revealState.text.length || revealState.timer) return;

  const speed = phase === 'correctReveal' ? CORRECT_REVEAL_SPEED_MS : TYPEWRITER_SPEED_MS;
  el.classList.add('revealing');
  revealState.timer = setInterval(() => {
    revealState.index++;
    el.textContent = revealState.text.slice(0, revealState.index);
    if (revealState.index >= revealState.text.length) {
      clearInterval(revealState.timer);
      revealState.timer = null;
      el.classList.remove('revealing');
    }
  }, speed);
}

// 問題文の表示が終わったのに誰も押さないままだと、サーバーが一定時間後に
// 自動で正解発表へ進む。その残り時間を、参加者バー下のreveal-timer-barが
// 満幅から0まで縮んでいくアニメーションで示す（CSS transitionに任せることで
// 250ms間隔のポーリングでもなめらかに見える。詳細はresetRevealTimerBar/
// freezeRevealTimerBar/startRevealTimerBarを参照）。
let currentPhase = null;
let currentNoBuzzDeadline = null;
let latestRevealedAnswer = null;
let latestRevealedInput = null;
let lastSfxPhase = null; // 出題・正解・不正解の効果音を、フェーズが切り替わった瞬間だけ鳴らすための直前値
let sfxPhaseInitialized = false; // 参加/再接続した直後の最初のstateでは、進行中のフェーズを誤って「切り替わった」と判定しないようにする
let revealTimerDeadline = null; // 現在バーがアニメーション対象にしている締切（同じ締切に対して二重にstartしないため）
let revealTimerRunning = false; // 現在CSS transitionで縮んでいる最中かどうか

// 次の問題の待機に備えて、バーを満幅・アニメーションなしの状態に戻す。
function resetRevealTimerBar() {
  revealTimerDeadline = null;
  revealTimerRunning = false;
  revealTimerBar.style.transition = 'none';
  revealTimerBar.style.width = '100%';
}

// 縮んでいる途中で誰かが押して中断された場合、その時点の幅で止める
// （満幅に戻さない。CSS transitionを止めるには、今のピクセル幅を明示的に指定し直す必要がある）。
function freezeRevealTimerBar() {
  if (!revealTimerRunning) return;
  const currentWidthPx = revealTimerBar.getBoundingClientRect().width;
  revealTimerBar.style.transition = 'none';
  revealTimerBar.style.width = `${currentWidthPx}px`;
  revealTimerRunning = false;
}

// 満幅から0まで、残り時間ぶんかけてCSS transitionで縮ませ始める。
function startRevealTimerBar(remainingMs) {
  revealTimerBar.style.transition = 'none';
  revealTimerBar.style.width = '100%';
  void revealTimerBar.offsetWidth; // 満幅を確定させてからtransitionを仕込むための強制リフロー
  revealTimerBar.style.transition = `width ${remainingMs}ms linear`;
  revealTimerBar.style.width = '0%';
  revealTimerRunning = true;
}

function tickNoBuzzCountdown() {
  if (currentPhase !== 'open' || !currentNoBuzzDeadline) return;
  const isTypingDone = revealState.text !== null && revealState.index >= revealState.text.length;
  if (!isTypingDone) return; // タイプライター表示中はバーは満幅のまま動かさない
  if (revealTimerDeadline === currentNoBuzzDeadline) return; // この締切に対してはstart済み
  revealTimerDeadline = currentNoBuzzDeadline;
  const remainingMs = Math.max(0, currentNoBuzzDeadline - Date.now());
  startRevealTimerBar(remainingMs);
}

// 正解後(correctReveal)は、残りの問題文の表示が終わるまで「A.答え」を隠す。
// 誰も正解しなかった場合の発表(reveal)は、今まで通りすぐ表示する。
function tickAnswerRevealLabel() {
  const isTypingDone = revealState.text !== null && revealState.index >= revealState.text.length;
  const show = currentPhase === 'reveal' || (currentPhase === 'correctReveal' && isTypingDone);
  answerRevealAnswerEl.textContent = `A.${latestRevealedAnswer || ''}`;
  // 判定用の読み・短縮形は、正式表記と同じ場合は二重表示せず省略する。
  const showInputLine = !!latestRevealedInput && latestRevealedInput !== latestRevealedAnswer;
  answerRevealInputEl.textContent = showInputLine ? latestRevealedInput : '';
  answerRevealLabel.classList.toggle('has-input', showInputLine);
  answerRevealLabel.classList.toggle('hidden', !show);
}

setInterval(() => {
  tickNoBuzzCountdown();
  tickAnswerRevealLabel();
}, 250);

socket.on('state', (state) => {
  const {
    started,
    difficulty,
    winScore,
    questionLimit,
    wrongPenalty,
    wrongLimit,
    phase,
    question,
    questionNumber,
    isTraining,
    answerProgress,
    letterChoices,
    revealedAnswer,
    revealedInput,
    noBuzzDeadline,
    wrongLetterChoice,
    wrongTimedOut,
    lastBuzzerId,
    lastBuzzerReactionMs,
    isFirstLetterChoice,
    buzzedId,
    buzzedName,
    players,
  } = state;

  const prevPhase = currentPhase;
  const prevNoBuzzDeadline = currentNoBuzzDeadline;
  currentPhase = started ? phase : null;
  currentNoBuzzDeadline = noBuzzDeadline;
  currentlyStarted = started;

  // 「第N問」（announce）が表示されるタイミングで、次の問題に備えてバーを満幅に戻す。
  // 前の問題が誰かが押して終わった場合、締切は前後ともnullのままになる（押された時点で
  // 一度nullへ変わっている）ので、締切の変化だけを見ていると次のannounceでリセットが
  // 発火せず、前の問題で縮んだ/止まった幅が「第N問」表示中も残ってしまう。そのため
  // announceに入った瞬間は締切の変化に関わらず必ずリセットする。
  if (currentPhase === 'announce') {
    resetRevealTimerBar();
  } else if (prevPhase === 'open' && currentPhase !== 'open' && revealTimerRunning) {
    // 誰かが押して'open'から抜けた（＝中断。時間切れでreveal/correctRevealに
    // 切り替わった場合も含む）→ その時点の幅で止める。
    freezeRevealTimerBar();
  } else if (currentNoBuzzDeadline !== prevNoBuzzDeadline) {
    // 締切が新しい値に変わった（念のためのフォールバック）→ 満幅にリセットする。
    resetRevealTimerBar();
  }

  // フェーズが切り替わった瞬間にだけ効果音を鳴らす（同じフェーズ中に他の理由で
  // stateが再送されても連打で鳴ってしまわないように、直前のフェーズと比較する）。
  // ただし参加/再接続した直後の最初のstateは「今のフェーズに追いついただけ」なので、
  // それをフェーズの切り替わりとみなして音を鳴らしてしまわないようにする。
  if (!sfxPhaseInitialized) {
    sfxPhaseInitialized = true;
  } else if (currentPhase !== lastSfxPhase) {
    if (currentPhase === 'announce') playAnnounceSound();
    else if (currentPhase === 'correct') playCorrectSound();
    else if (currentPhase === 'wrong') playWrongSound();
    // 自分が押したときは押した瞬間（buzzBtnのクリック）に既に鳴らしているので、
    // ここで鳴らすのは他の人（CPU含む）が押したのを知らせる分だけでよい。
    else if (currentPhase === 'buzzed' && buzzedId !== clientId) playBuzzSound();
  }
  lastSfxPhase = currentPhase;

  // 押した人への反応時間バッジは、その結果（○/✕）を表示している間だけ見せる。
  const showReactionFor = (phase === 'buzzed' || phase === 'wrong' || phase === 'correct') ? lastBuzzerId : null;
  renderPlayerList(playerList, players, buzzedId, showReactionFor, lastBuzzerReactionMs);

  setupPanel.classList.toggle('hidden', started);
  playPanel.classList.toggle('hidden', !started);
  questionNumberBadge.classList.toggle('hidden', !started);
  endGameBtn.classList.toggle('hidden', !started);
  difficultyButtons.forEach((b) => b.classList.toggle('active', b.dataset.difficulty === difficulty));
  // CPU参加の選択肢はトレーニングモードでのみ表示する（フレンド対戦モードでは非表示）。
  // トレーニングモードでも今まで通り自由にON/OFFを選べる。
  cpuToggleRow.classList.toggle('hidden', !isTraining);
  cpuToggle.checked = players.some((p) => p.id === 'cpu');
  // 入力中（フォーカス中）の欄は、他の人の操作で届いたstateで値を上書きしないようにする。
  if (document.activeElement !== winScoreInput) winScoreInput.value = winScore > 0 ? winScore : '';
  if (document.activeElement !== questionLimitInput) questionLimitInput.value = questionLimit > 0 ? questionLimit : '';
  if (document.activeElement !== wrongPenaltyInput) wrongPenaltyInput.value = wrongPenalty > 0 ? wrongPenalty : '';
  if (document.activeElement !== wrongLimitInput) wrongLimitInput.value = wrongLimit > 0 ? wrongLimit : '';
  syncStepperUnit(winScoreInput, winScoreUnit);
  syncStepperUnit(questionLimitInput, questionLimitUnit);
  syncStepperUnit(wrongPenaltyInput, wrongPenaltyUnit);
  syncStepperUnit(wrongLimitInput, wrongLimitUnit);

  gameOverOverlay.classList.toggle('hidden', phase !== 'gameOver');
  if (phase === 'gameOver') {
    renderGameOverRanking(players);
    return;
  }

  if (!started) return;

  // 上部バー中央の「QN」バッジは、フェーズに関わらず常に何問目かを表示し続ける
  // （「第N問」の一瞬表示とは別物）。
  questionNumberBadge.textContent = `Q${questionNumber}`;

  // 正解発表の後、次の問題文が出る前に「第N問」だけを一瞬表示する。
  // question-number と question-display は片方だけを表示し（display:noneで
  // 場所を占有しない）、出題エリアの高さは表示中の問題文・解答の長さに応じて
  // 可変にする（短ければ縮み、長ければ伸びる）。
  questionNumberEl.textContent = `第${questionNumber}問`;
  questionNumberEl.classList.toggle('hidden', phase !== 'announce');
  questionDisplay.classList.toggle('hidden', phase === 'announce');
  updateQuestionReveal(questionTextEl, question, phase);

  const me = players.find((p) => p.id === clientId);
  const isSelfBuzzed = buzzedId === clientId;

  // 解答の進捗（確定した文字）は全員に見せる。選択肢のボタンは早押しに勝った本人にだけ表示する。
  // 誤答した瞬間（wrong）・正解し終えた瞬間（correct）は、同じポップアップの中身を
  // 「✕不正解」「○正解」表示に切り替える。
  const showProgress = phase === 'buzzed';
  const showWrong = phase === 'wrong';
  const showCorrect = phase === 'correct';
  const showChoices = phase === 'buzzed' && isSelfBuzzed && letterChoices && letterChoices.length > 0;
  buzzOverlay.classList.toggle('hidden', !showProgress && !showWrong && !showCorrect);
  buzzLive.classList.toggle('hidden', !showProgress);
  wrongResult.classList.toggle('hidden', !showWrong);
  correctResult.classList.toggle('hidden', !showCorrect);
  if (showProgress) {
    const buzzedPlayer = players.find((p) => p.id === buzzedId);
    setAvatarContent(buzzAvatar, buzzedName, buzzedPlayer && buzzedPlayer.icon);
    buzzCardStatus.textContent = isSelfBuzzed ? 'あなたが解答中…' : `${buzzedName} が解答中…`;
  }
  if (showWrong) {
    wrongResultLetter.textContent = wrongTimedOut ? '時間切れ' : (wrongLetterChoice || '');
  }
  if (showCorrect) {
    correctResultLetter.textContent = revealedInput || '';
  }
  answerProgressText.textContent = answerProgress || '';
  updateLetterCountdown(showProgress, (answerProgress || '').length, !!isFirstLetterChoice);

  choicesContainer.classList.toggle('hidden', !showChoices);
  choiceButtons.forEach((btn, i) => {
    btn.textContent = letterChoices[i] || '';
    btn.disabled = false;
  });

  // 正解発表時は、問題文の枠の右下に「A.答え」を重ねて表示する
  // （correctRevealのときは残りの問題文が表示し終わるまでtickAnswerRevealLabelが隠す）。
  latestRevealedAnswer = revealedAnswer;
  latestRevealedInput = revealedInput;
  tickAnswerRevealLabel();

  buzzBtn.disabled = phase !== 'open' || !me || me.locked;
});
