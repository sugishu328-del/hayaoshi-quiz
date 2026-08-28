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
function isValidQuestionEntry(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.question !== 'string' || !item.question) return false;
  if (typeof item.answer !== 'string' || !item.answer) return false;
  if (typeof item.input !== 'string' || !item.input) return false;
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
const SKIP_CHARS = new Set(['・', '.']);

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
      const strings = [item.input, ...(item.distractors || []).map((dd) => dd.input)];
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
    const firstChar = d && typeof d.input === 'string' ? d.input[0] : null;
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

// ---- CPU対戦相手（参加は任意、正答率は難易度に応じる） ----
const CPU_ID = 'cpu';
const CPU_ACCURACY = { A: 0.3, B: 0.6, C: 0.9 }; // A=むずかしい, C=かんたん

// ---- 部屋(Room)共通のタイミング定数 ----
const DISCONNECT_GRACE_MS = 60000; // この時間内に同じclientIdで再参加すればスコアを維持したまま復帰できる
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

module.exports = {
  DIFFICULTIES,
  questionBanks,
  SKIP_CHARS,
  shuffleArray,
  buildLetterChoices,
  buildFirstLetterChoices,
  CPU_ID,
  CPU_ACCURACY,
  DISCONNECT_GRACE_MS,
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
};
