const fs = require('fs');
const path = require('path');

// ---- 問題バンク（難易度A/B/C別、全問自動出題） ----
// サーバー全体で1つだけ読み込む静的データ。部屋(Room)ごとに複製する必要はない。
const DIFFICULTIES = ['A', 'B', 'C'];
let questionBanks = { A: [], B: [], C: [] };

// 1問でも question/answer/input が空文字列や非文字列だったり、distractorsが不正な形
// だったりすると、出題時にサーバー全体がクラッシュしてしまう（例えば undefined.length
// のような例外は socket.io のイベントハンドラ内では捕捉されない）。今後この問題バンクが
// 手編集で壊れても落ちないよう、読み込み時に1問ずつ形を検証し、壊れている問題だけを
// 読み飛ばす（他の問題は影響を受けない）。
// inputは通常1つの文字列だが、「コリオリの力/コリオリ力」「にほん/にっぽん」のように
// 本当に2通り以上の正式な読み・言い方が通用する答えの場合だけ、配列で複数の正解候補を
// 持たせられる（2026-10-09追加）。配列化した場合も各要素は通常のinput同様1文字ずつ
// 判定される（room.jsのanswerCandidatesが分岐して両方受理する）。
function isValidInput(input) {
  if (typeof input === 'string') return !!input;
  if (Array.isArray(input)) return input.length > 0 && input.every((s) => typeof s === 'string' && !!s);
  return false;
}

function normalizeInputCandidates(input) {
  return Array.isArray(input) ? input : [input];
}

function isValidQuestionEntry(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.question !== 'string' || !item.question) return false;
  if (typeof item.answer !== 'string' || !item.answer) return false;
  if (!isValidInput(item.input)) return false;
  if (!Array.isArray(item.distractors)) return false;
  return item.distractors.every(
    (d) => d && typeof d.name === 'string' && typeof d.input === 'string' && d.input
  );
}

try {
  const loaded = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf-8'));
  for (const d of DIFFICULTIES) {
    const rawList = Array.isArray(loaded[d]) ? loaded[d] : [];
    const validList = rawList.filter((item, i) => {
      const ok = isValidQuestionEntry(item);
      if (!ok) console.error(`questions.json の ${d}[${i}] は形式が不正なため読み飛ばしました:`, item);
      return ok;
    });
    questionBanks[d] = validList;
  }
} catch (e) {
  console.error('questions.json の読み込みに失敗しました:', e.message);
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
// 「・」「.」は選ばせず自動でスキップする（「ワシントンD.C.」「3.14」のような区切り記号を
// 選択肢として選ばせるのは不自然なため）。数字/ローマ字/ひらがな/カタカナ/漢字でダミー文字の種類を揃える
// （例：「ドラえもん」のようにカタカナとひらがなが混ざる答えでも、文字ごとに種類を合わせる）。
// 「-」「−」「/」「&」も同じ理由でスキップする（「Wi-Fi」「S&P500」「N/m」のような英数字の
// 連結記号。classifyCharでは漢字/カタカナ/ひらがな/ローマ字/数字のどれにも当てはまらず
// 「漢字」プールにフォールバックしてしまい、正解が「-」のときに見た目がほぼ同じ「−」(全角マイナス、
// のばし棒と見分けづらい)や無関係な漢字が誤答選択肢に混ざる不具合があった。2026-10-08修正）。
const SKIP_CHARS = new Set(['・', '.', '-', '−', '/', '&']);

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
      const strings = [...normalizeInputCandidates(item.input), ...(item.distractors || []).map((dd) => dd.input)];
      for (const s of strings) {
        if (typeof s !== 'string') continue;
        for (const ch of s) {
          if (SKIP_CHARS.has(ch)) continue;
          seen[classifyChar(ch)].add(ch);
        }
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

// correctCharは通常1文字だが、answerCandidatesが分岐している位置（例:「にほん」の
// 「ほ」と「にっぽん」の「っ」）では、room.js側からその位置で正解になる複数文字を
// 配列で渡してくる。単一文字のときは配列化してそのまま扱う（動作は変えない）。
function buildLetterChoices(correctChar) {
  const correctChars = Array.isArray(correctChar) ? correctChar : [correctChar];
  const cls = classifyChar(correctChars[0]);
  const pool = charPools[cls].filter((c) => !correctChars.includes(c));
  const shuffledPool = shuffleArray(pool);
  const decoys = [];
  const decoyTarget = Math.max(0, 4 - correctChars.length);
  for (const c of shuffledPool) {
    if (decoys.length >= decoyTarget) break;
    if (!decoys.includes(c)) decoys.push(c);
  }
  return shuffleArray([...correctChars, ...decoys]);
}

// 1文字目だけは、ランダムな同種文字ではなく「もっともらしい誤答（distractors）」の
// 頭文字を選択肢にする。distractorsが足りない/重複する分は通常のプールで補う。
// correctCharも上記buildLetterChoicesと同様、分岐位置では配列で渡される。
function buildFirstLetterChoices(correctChar, distractors) {
  const correctChars = Array.isArray(correctChar) ? correctChar : [correctChar];
  const candidates = [...correctChars];
  for (const d of distractors || []) {
    if (candidates.length >= 4) break;
    const firstChar = d && typeof d.input === 'string' ? d.input[0] : null;
    if (firstChar && !candidates.includes(firstChar)) candidates.push(firstChar);
  }
  if (candidates.length < 4) {
    const cls = classifyChar(correctChars[0]);
    const pool = shuffleArray(charPools[cls].filter((c) => !candidates.includes(c)));
    for (const c of pool) {
      if (candidates.length >= 4) break;
      candidates.push(c);
    }
  }
  return shuffleArray(candidates);
}

// ---- CPU対戦相手（参加は任意、正答率は難易度に応じる） ----
const CPU_ID = 'cpu';
const CPU_ACCURACY = { A: 0.3, B: 0.6, C: 0.9 }; // A=むずかしい, C=かんたん

// プロフィール（アカウント作成）で選べるアイコン一覧。public/client.jsにも同じ内容を
// 直接書いている（ブラウザ側はバンドラを使っていないためrequireできない）ので、
// 増減する際はそちらも合わせて変更すること。
const ICON_CHOICES = ['🦊', '🐱', '🐶', '🐻', '🦁', '🐰', '🐼', '🐨'];

// ---- 部屋(Room)共通のタイミング定数 ----
const DISCONNECT_GRACE_MS = 300000; // この時間内に同じclientIdで再参加すればスコアを維持したまま復帰できる（スマホの画面ロック・スリープで数分切れることがあるため、60秒では短すぎた。2026-10-04に60秒→5分へ延長）
const PAUSED_DISCONNECT_GRACE_MS = 1800000; // 一時停止中に切断した場合だけはこちらを使う（食事休憩・充電探し等、通常の切断より長い中断を想定。2026-10-07追加）
const TYPEWRITER_SPEED_MS = 140; // client.jsの問題文タイプライター表示と同じ速さ（表示完了タイミングの計算に使う）
const CORRECT_REVEAL_SPEED_MS = 47; // 正解後、残りの問題文を続きから表示するときの速さ（client.jsと同じ値）
const NO_BUZZ_TIMEOUT_MS = 5000; // 問題文が表示され終わってから、誰も押さないまま経過したら諦めて次の問題へ
const FIRST_LETTER_TIMEOUT_MS = 5000; // 早押し直後、1文字目だけの制限時間
const LETTER_TIMEOUT_MS = 3000; // 2文字目以降、選ばないまま経過したら誤答扱い
const REVEAL_DELAY_MS = 3000; // 正解発表を表示しておく時間
const ANNOUNCE_DELAY_MS = 1500; // 「第N問」だけを表示しておく時間
const WRONG_ANSWER_DELAY_MS = 1500; // 文字を選んで誤答したときに「✕不正解」を表示しておく時間
const POST_CORRECT_REVEAL_DELAY_MS = 2000; // 「○正解」の後、残りの問題文＋A.答えを表示しておく時間
const CORRECT_ANSWER_DELAY_MS = 1500; // 正解し終わったときに「○正解」を表示しておく時間
const SIMULTANEOUS_BUZZ_WINDOW_MS = 300; // 最初の早押しからこの時間以内の早押しは「同時」とみなし、同じ解答権キューに加える（2026-10-08追加）

module.exports = {
  DIFFICULTIES,
  questionBanks,
  SKIP_CHARS,
  normalizeInputCandidates,
  shuffleArray,
  buildLetterChoices,
  buildFirstLetterChoices,
  CPU_ID,
  CPU_ACCURACY,
  ICON_CHOICES,
  DISCONNECT_GRACE_MS,
  PAUSED_DISCONNECT_GRACE_MS,
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
  SIMULTANEOUS_BUZZ_WINDOW_MS,
};
