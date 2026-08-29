const {
  questionBanks,
  SKIP_CHARS,
  buildLetterChoices,
  buildFirstLetterChoices,
  CPU_ID,
  CPU_ACCURACY,
  TYPEWRITER_SPEED_MS,
  CORRECT_REVEAL_SPEED_MS,
  NO_BUZZ_TIMEOUT_MS,
  FIRST_LETTER_TIMEOUT_MS,
  LETTER_TIMEOUT_MS,
  REVEAL_DELAY_MS,
  ANNOUNCE_DELAY_MS,
  WRONG_ANSWER_DELAY_MS,
  POST_CORRECT_REVEAL_DELAY_MS,
  CORRECT_ANSWER_DELAY_MS,
} = require('./gameData');

// 1つの対戦部屋分の状態とロジックをまとめたクラス。
// 今はserver.js側で1部屋だけ（DEFAULT_ROOM_ID）を起動時に作って使っているが、
// 将来複数部屋に対応する際はこのクラスはそのまま複数インスタンス化できる。
class Room {
  constructor(id, io) {
    this.id = id; // Socket.ioの部屋名としても使う
    this.io = io;
    this.isTraining = false; // trueならトレーニングモード専用の部屋（CPU固定参加・持ち主が抜けたら自動で破棄される）

    // ---- ゲーム状態（出題者なし・全員参加者） ----
    // playersはブラウザごとに割り振られる永続的なclientId（localStorageに保存）をキーにする。
    // socket.idは切断・再接続のたびに変わってしまうため、スコアを引き継ぐにはclientIdで
    // 識別する必要がある。socketIdByClientIdで「今どのソケットが現役か」を管理し、
    // 切断時はすぐには削除せずDISCONNECT_GRACE_MSだけ猶予を持たせる（画面ロック等からの復帰用）。
    this.players = new Map(); // clientId -> { name, score, connected, disconnectTimer }
    this.socketIdByClientId = new Map(); // clientId -> 現在つながっているsocket.id

    this.shuffledQueues = { A: [], B: [], C: [] }; // 難易度ごとの未出題インデックス（1周するまで重複しない）

    this.started = false;
    this.difficulty = 'B';
    this.winScore = 5; // 0 = 制限なし。設定した点数に誰かが到達したら次の問題に進まずゲーム終了にする
    this.questionLimit = 30; // 0 = 制限なし。この問題数を出題し終えたらゲーム終了にする
    this.wrongPenalty = 0; // 0 = ペナルティなし。誤答1回につきこの点数を減点する（0点未満にはしない）
    this.wrongLimit = 0; // 0 = 無制限。1人の誤答回数がこれに達したら失格（disqualified）にする
    this.phase = 'open'; // announce | open | buzzed | wrong | correct | reveal（started=falseの間は未使用）
    this.question = '';
    this.questionNumber = 0; // 何問目か（game:startで1から始まる）
    this.answer = ''; // 実際に1文字ずつ入力させて正誤判定する文字列（questions.jsonのinput。漢字の読みや短縮形）
    this.displayAnswer = ''; // 「○正解」「A.答え」に表示する文字列（questions.jsonのanswer。漢字そのまま）
    this.currentDistractors = []; // 現在の問題のもっともらしい誤答（1文字目の選択肢作りに使う。{name, input}の配列）
    this.resolvedCount = 0; // answerの先頭から何文字確定したか（スキップ文字も含む）
    this.letterChoices = []; // 現在の文字位置の4択
    this.revealedAnswer = ''; // 正解発表時の正式表記（questions.jsonのanswer）
    this.revealedInput = ''; // 正解発表時の判定用表記（questions.jsonのinput。読みや短縮形）
    this.buzzedId = null;
    this.noBuzzDeadline = null; // 「誰も押さないまま自動で正解発表になる」時刻（クライアントのカウントダウン表示用）
    this.questionRevealedMs = 0; // この問題文がこれまでに表示され進んだ合計時間（誤答で中断された分は除く）
    this.questionTypingStartedAt = null; // 直近でopenフェーズに入った（表示が再開した）時刻
    this.questionOpenedAt = null; // この問題が最初にopenになった時刻（誤答での中断・再開では変わらない。反応時間の計測用）
    this.wrongLetterChoice = null; // 直前の誤答までに選んでいた文字（「✕不正解」表示用）
    this.wrongTimedOut = false; // 直前の誤答が「文字を選んでの誤答」ではなく「時間切れ」だったか
    this.lastBuzzerId = null; // 直近に押した人（「○正解」「✕不正解」表示中はbuzzedIdがnullになるので別途保持）
    this.lastBuzzerReactionMs = null; // 問題文表示開始から押すまでにかかった時間（参加者バーの表示用）
    this.lockedOut = new Set(); // この問題で誤答済みのplayerId
    this.disqualified = new Set(); // 誤答許容回数を超えて失格したplayerId（ゲーム終了までずっと押せない）

    this.cpuTimer = null;
    this.cpuLetterTimer = null;
    this.noBuzzTimer = null;
    this.letterTimer = null;
    this.advanceTimer = null;
    this.wrongTimer = null;
    this.correctTimer = null;
    this.cpuWillSucceed = true;
    this.cpuMistakeAt = -1; // 何文字目（ガード対象文字のうち何番目）でわざと間違えるか
    this.cpuStepIndex = 0;
    this.isFirstLetterPick = true; // 早押し後、最初の1文字目だけ制限時間を長くする
  }

  drawNextQuestion(difficulty) {
    const bank = questionBanks[difficulty] || [];
    if (bank.length === 0) return null;
    if (this.shuffledQueues[difficulty].length === 0) {
      const queue = bank.map((_, i) => i);
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
      this.shuffledQueues[difficulty] = queue;
    }
    const idx = this.shuffledQueues[difficulty].pop();
    return bank[idx];
  }

  connectedPlayerCount() {
    let count = 0;
    for (const p of this.players.values()) {
      if (p.connected) count++;
    }
    return count;
  }

  // トレーニング部屋はCPUが常時connected:trueのまま残るため、connectedPlayerCount()では
  // 「持ち主(人間)がいなくなったか」を判定できない。CPUを除いて判定する。
  hasConnectedHuman() {
    for (const [id, p] of this.players) {
      if (id !== CPU_ID && p.connected) return true;
    }
    return false;
  }

  cancelCpuTimer() { if (this.cpuTimer) { clearTimeout(this.cpuTimer); this.cpuTimer = null; } }
  cancelCpuLetterTimer() { if (this.cpuLetterTimer) { clearTimeout(this.cpuLetterTimer); this.cpuLetterTimer = null; } }
  cancelNoBuzzTimer() { if (this.noBuzzTimer) { clearTimeout(this.noBuzzTimer); this.noBuzzTimer = null; } this.noBuzzDeadline = null; }

  // 早押しされてopenフェーズが中断される瞬間に呼ぶ。ここまでに問題文が表示された時間を
  // questionRevealedMsに積み増しておき、後でopenに戻ったときに続きから計算できるようにする。
  pauseQuestionTyping() {
    if (this.questionTypingStartedAt !== null) {
      const totalTypingMs = this.question.length * TYPEWRITER_SPEED_MS;
      this.questionRevealedMs = Math.min(totalTypingMs, this.questionRevealedMs + (Date.now() - this.questionTypingStartedAt));
      this.questionTypingStartedAt = null;
    }
  }
  cancelLetterTimer() { if (this.letterTimer) { clearTimeout(this.letterTimer); this.letterTimer = null; } }
  cancelAdvanceTimer() { if (this.advanceTimer) { clearTimeout(this.advanceTimer); this.advanceTimer = null; } }
  cancelWrongTimer() { if (this.wrongTimer) { clearTimeout(this.wrongTimer); this.wrongTimer = null; } }
  cancelCorrectTimer() { if (this.correctTimer) { clearTimeout(this.correctTimer); this.correctTimer = null; } }
  cancelAllTimers() {
    this.cancelCpuTimer();
    this.cancelCpuLetterTimer();
    this.cancelNoBuzzTimer();
    this.cancelLetterTimer();
    this.cancelAdvanceTimer();
    this.cancelWrongTimer();
    this.cancelCorrectTimer();
  }

  publicPlayers() {
    return [...this.players.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      score: p.score,
      // 失格(disqualified)は「今の問題だけ押せない(lockedOut)」と見た目・扱いを共通化する
      // （どちらも「今は押せない」という点で表示上は同じでよいため、専用の表示は作らない）。
      // lockedOutは毎問クリアされるが、disqualifiedはゲーム終了までクリアされない。
      locked: this.lockedOut.has(id) || this.disqualified.has(id),
    }));
  }

  broadcastState() {
    const base = {
      started: this.started,
      difficulty: this.difficulty,
      winScore: this.winScore,
      questionLimit: this.questionLimit,
      wrongPenalty: this.wrongPenalty,
      wrongLimit: this.wrongLimit,
      phase: this.phase,
      question: this.question,
      questionNumber: this.questionNumber,
      isTraining: this.isTraining,
      revealedAnswer: this.revealedAnswer,
      revealedInput: this.revealedInput,
      noBuzzDeadline: this.noBuzzDeadline,
      wrongLetterChoice: this.wrongLetterChoice,
      wrongTimedOut: this.wrongTimedOut,
      buzzedId: this.buzzedId,
      buzzedName: this.buzzedId ? this.players.get(this.buzzedId)?.name : null,
      lastBuzzerId: this.lastBuzzerId,
      lastBuzzerReactionMs: this.lastBuzzerReactionMs,
      isFirstLetterChoice: this.isFirstLetterPick,
      players: this.publicPlayers(),
    };
    // answerProgress（確定した文字）は全員に見せる。letterChoices（次の文字の4択）は本人にだけ送る。
    // 「本人」の判定はsocket.idではなく、joinで紐付けたclientId（socket.data.clientId）で行う
    // （socket.idは再接続のたびに変わるが、clientIdはブラウザに保存されて変わらない）。
    const answerProgress = this.answer.slice(0, this.resolvedCount);
    const socketIds = this.io.sockets.adapter.rooms.get(this.id);
    if (!socketIds) return;
    for (const socketId of socketIds) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (!socket) continue;
      const cid = socket.data.clientId;
      socket.emit('state', {
        ...base,
        answerProgress,
        letterChoices: (cid && this.buzzedId === cid) ? this.letterChoices : [],
      });
    }
  }

  // 問題文の表示（タイプライター）の残りが終わるまでの時間 + NO_BUZZ_TIMEOUT_MS 待ってから
  // 誰も押さなければ諦めて次の問題へ。誤答で中断されていた場合は、その時点までの
  // 表示済み時間（questionRevealedMs）を差し引いた残りだけ待つ。
  scheduleNoBuzzTimer() {
    this.cancelNoBuzzTimer();
    const roundQuestion = this.question;
    const totalTypingMs = roundQuestion.length * TYPEWRITER_SPEED_MS;
    const remainingTypingMs = Math.max(0, totalTypingMs - this.questionRevealedMs);
    this.questionTypingStartedAt = Date.now();
    const totalDelay = remainingTypingMs + NO_BUZZ_TIMEOUT_MS;
    this.noBuzzDeadline = Date.now() + totalDelay;
    this.noBuzzTimer = setTimeout(() => {
      this.noBuzzTimer = null;
      if (!this.started || this.phase !== 'open' || this.question !== roundQuestion) return;
      this.enterReveal();
    }, totalDelay);
  }

  scheduleLetterTimeout(timeoutMs) {
    this.cancelLetterTimer();
    const myBuzzedId = this.buzzedId;
    const myResolvedCount = this.resolvedCount;
    this.letterTimer = setTimeout(() => {
      this.letterTimer = null;
      if (!this.started || this.phase !== 'buzzed' || this.buzzedId !== myBuzzedId || this.resolvedCount !== myResolvedCount) return;
      this.resolveWrong();
    }, timeoutMs);
  }

  // 現在のresolvedCountから次に選ばせる文字を用意する。スキップ文字は自動で読み飛ばし、
  // 最後まで到達したら正解確定。CPUの番なら次の一手もスケジュールする。
  advanceLetterOrFinish() {
    while (this.resolvedCount < this.answer.length && SKIP_CHARS.has(this.answer[this.resolvedCount])) {
      this.resolvedCount++;
    }
    if (this.resolvedCount >= this.answer.length) {
      this.finishCorrectAnswer();
      return;
    }
    // 「1文字目かどうか」はresolvedCount===0ではなくisFirstLetterPickで判定する。
    // （もしanswerの先頭がSKIP_CHARSの文字だった場合、上のwhileループでresolvedCountが
    // 0より先に進んでしまうため、resolvedCount===0では本当の1文字目を正しく検出できない）
    this.letterChoices = this.isFirstLetterPick
      ? buildFirstLetterChoices(this.answer[this.resolvedCount], this.currentDistractors)
      : buildLetterChoices(this.answer[this.resolvedCount]);
    this.broadcastState();
    this.scheduleLetterTimeout(this.isFirstLetterPick ? FIRST_LETTER_TIMEOUT_MS : LETTER_TIMEOUT_MS);
    this.isFirstLetterPick = false;
    if (this.buzzedId === CPU_ID) this.scheduleCpuLetterPick();
  }

  // 正解し終わったら「○正解」をCORRECT_ANSWER_DELAY_MSだけ表示し、その後
  // 残りの問題文を（誤答で止まっていた続きから）CORRECT_REVEAL_SPEED_MSで表示しきってから
  // さらにPOST_CORRECT_REVEAL_DELAY_MSだけ間を置いて次の問題へ（'correctReveal'フェーズ）。
  finishCorrectAnswer() {
    this.cancelAllTimers();
    const p = this.players.get(this.buzzedId);
    if (p) p.score += 1;
    this.revealedAnswer = this.displayAnswer;
    this.revealedInput = this.answer;
    this.buzzedId = null;
    this.resolvedCount = 0;
    this.letterChoices = [];
    this.phase = 'correct';
    this.broadcastState();
    this.correctTimer = setTimeout(() => {
      this.correctTimer = null;
      if (!this.started) return;
      this.phase = 'correctReveal';
      this.broadcastState();
      const alreadyShownChars = Math.round(this.questionRevealedMs / TYPEWRITER_SPEED_MS);
      const remainingChars = Math.max(0, this.question.length - alreadyShownChars);
      const fastTypingMs = remainingChars * CORRECT_REVEAL_SPEED_MS;
      this.advanceTimer = setTimeout(() => {
        this.advanceTimer = null;
        if (!this.started) return;
        this.drawAndOpenNextQuestion();
      }, fastTypingMs + POST_CORRECT_REVEAL_DELAY_MS);
    }, CORRECT_ANSWER_DELAY_MS);
  }

  resolveLetterChoice(choice) {
    this.cancelLetterTimer();
    const correctChar = this.answer[this.resolvedCount];
    if (choice === correctChar) {
      this.resolvedCount++;
      this.advanceLetterOrFinish();
    } else {
      this.resolveWrong(choice);
    }
  }

  scheduleCpuBuzzIfNeeded() {
    this.cancelCpuTimer();
    if (!this.players.has(CPU_ID) || !this.started || this.phase !== 'open' || !this.answer) return;
    if (this.lockedOut.has(CPU_ID) || this.disqualified.has(CPU_ID)) return;

    const roundQuestion = this.question;
    const reactionDelay = 1000 + Math.random() * 3000; // 1〜4秒でランダムに早押し
    this.cpuTimer = setTimeout(() => {
      this.cpuTimer = null;
      if (!this.started || this.phase !== 'open' || this.question !== roundQuestion) return;
      if (!this.players.has(CPU_ID) || this.lockedOut.has(CPU_ID) || this.disqualified.has(CPU_ID)) return;

      this.cancelNoBuzzTimer();
      this.pauseQuestionTyping();
      this.buzzedId = CPU_ID;
      this.lastBuzzerId = CPU_ID;
      this.lastBuzzerReactionMs = this.questionOpenedAt !== null ? Date.now() - this.questionOpenedAt : null;
      this.resolvedCount = 0;
      this.isFirstLetterPick = true;
      this.cpuStepIndex = 0;
      this.cpuWillSucceed = Math.random() < (CPU_ACCURACY[this.difficulty] ?? 0.5);
      // 間違えるときは必ず1文字目にする。1文字目だけは「もっともらしい別の答え」の頭文字が
      // 選択肢に混ざる（buildFirstLetterChoices）ため、間違え方として不自然に見えない。
      // 2文字目以降はただの同種文字からのランダム選択肢なので、そこで間違えると
      // （文脈上ほぼ答えが確定しているのに間違える、という）不自然な間違え方になってしまう。
      this.cpuMistakeAt = this.cpuWillSucceed ? -1 : 0;
      this.phase = 'buzzed';
      this.advanceLetterOrFinish();
    }, reactionDelay);
  }

  scheduleCpuLetterPick() {
    this.cancelCpuLetterTimer();
    const thinkDelay = 600 + Math.random() * 900;
    this.cpuLetterTimer = setTimeout(() => {
      this.cpuLetterTimer = null;
      if (this.buzzedId !== CPU_ID || this.phase !== 'buzzed') return;
      const correctChar = this.answer[this.resolvedCount];
      const shouldFailNow = !this.cpuWillSucceed && this.cpuStepIndex === this.cpuMistakeAt;
      const pick = shouldFailNow ? (this.letterChoices.find((c) => c !== correctChar) || this.letterChoices[0]) : correctChar;
      this.cpuStepIndex++;
      this.resolveLetterChoice(pick);
    }, thinkDelay);
  }

  // choiceを渡した場合（文字を選んでの誤答）は、それまで選んだ文字に今回誤答した1文字を
  // つなげて見せる。タイムアウト（何も選ばず時間切れ）の場合はchoiceを渡さず、それまで
  // 選んでいた文字だけを見せる。どちらの場合も「✕不正解」をWRONG_ANSWER_DELAY_MSだけ
  // 表示・音を鳴らしてから次に進む。
  resolveWrong(choice) {
    this.cancelLetterTimer();
    this.cancelCpuLetterTimer();
    if (this.buzzedId) {
      this.lockedOut.add(this.buzzedId);
      const p = this.players.get(this.buzzedId);
      if (p) {
        if (this.wrongPenalty > 0) p.score = Math.max(0, p.score - this.wrongPenalty);
        p.wrongCount = (p.wrongCount || 0) + 1;
        if (this.wrongLimit > 0 && p.wrongCount >= this.wrongLimit) this.disqualified.add(this.buzzedId);
      }
    }
    this.buzzedId = null;

    this.wrongLetterChoice = this.answer.slice(0, this.resolvedCount) + (choice || '');
    this.wrongTimedOut = !choice;
    this.resolvedCount = 0;
    this.letterChoices = [];
    this.phase = 'wrong';
    this.broadcastState();
    this.wrongTimer = setTimeout(() => {
      this.wrongTimer = null;
      this.proceedAfterWrong();
    }, WRONG_ANSWER_DELAY_MS);
  }

  // CPUはあくまで練習相手で、失格判定の対象から見た「続行の意味」を持たない
  // （人間が誰もいなければCPUだけ動き続けても仕方ないため）。接続中の人間プレイヤーが
  // 1人も残っていなければ（全員失格、または誰も参加していなければ）ゲームを続けない。
  allHumansDisqualified() {
    let hasConnectedHuman = false;
    for (const [id, p] of this.players) {
      if (id === CPU_ID || !p.connected) continue;
      hasConnectedHuman = true;
      if (!this.disqualified.has(id)) return false;
    }
    return hasConnectedHuman;
  }

  proceedAfterWrong() {
    this.wrongLetterChoice = null;
    this.wrongTimedOut = false;
    if (this.allHumansDisqualified()) {
      this.enterGameOver();
    } else if (this.lockedOut.size >= this.connectedPlayerCount()) {
      this.enterReveal();
    } else {
      this.phase = 'open';
      this.scheduleNoBuzzTimer();
      this.broadcastState();
      this.scheduleCpuBuzzIfNeeded();
    }
  }

  enterReveal() {
    this.cancelAllTimers();
    this.phase = 'reveal';
    this.revealedAnswer = this.displayAnswer;
    this.revealedInput = this.answer;
    this.buzzedId = null;
    this.resolvedCount = 0;
    this.letterChoices = [];
    this.broadcastState();
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = null;
      if (!this.started) return;
      this.drawAndOpenNextQuestion();
    }, REVEAL_DELAY_MS);
  }

  // 先取点数・出題数上限のどちらかに到達していたら、次の問題を出さずにゲーム終了にする。
  // 「次の問題を出そうとするタイミング」だけでチェックすれば、正解が確定した直後
  // （drawAndOpenNextQuestionが呼ばれる前）はcorrectReveal等の演出を最後まで見せられる。
  enterGameOver() {
    this.cancelAllTimers();
    this.phase = 'gameOver';
    this.buzzedId = null;
    this.letterChoices = [];
    this.broadcastState();
  }

  drawAndOpenNextQuestion() {
    if (this.questionLimit > 0 && this.questionNumber >= this.questionLimit) {
      this.enterGameOver();
      return;
    }
    if (this.winScore > 0 && [...this.players.values()].some((p) => p.score >= this.winScore)) {
      this.enterGameOver();
      return;
    }
    this.cancelAllTimers();
    const picked = this.drawNextQuestion(this.difficulty);
    this.question = picked ? picked.question : '';
    this.questionNumber++;
    this.answer = picked ? picked.input : '';
    this.displayAnswer = picked ? picked.answer : '';
    this.currentDistractors = picked && Array.isArray(picked.distractors) ? picked.distractors : [];
    this.resolvedCount = 0;
    this.letterChoices = [];
    this.revealedAnswer = '';
    this.revealedInput = '';
    this.buzzedId = null;
    this.wrongLetterChoice = null;
    this.wrongTimedOut = false;
    this.lastBuzzerId = null;
    this.lastBuzzerReactionMs = null;
    this.questionRevealedMs = 0;
    this.questionTypingStartedAt = null;
    this.questionOpenedAt = null;
    this.lockedOut.clear();
    this.phase = 'announce';
    this.broadcastState();
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = null;
      if (!this.started) return;
      this.phase = 'open';
      this.questionOpenedAt = Date.now();
      this.scheduleNoBuzzTimer();
      this.broadcastState();
      this.scheduleCpuBuzzIfNeeded();
    }, ANNOUNCE_DELAY_MS);
  }
}

module.exports = Room;
