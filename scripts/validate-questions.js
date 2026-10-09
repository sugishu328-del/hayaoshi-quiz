// questions.json の内容チェック用スクリプト。
// これまで問題を追加するたびに手作業のスクリプトで確認していたルールを1本にまとめたもの。
// 使い方: node scripts/validate-questions.js
'use strict';

const fs = require('fs');
const path = require('path');

// 引数でファイルパスを指定すれば、マージ前の下書きJSON（{A:[],B:[],C:[]}形式）も
// 同じルールでチェックできる。省略時はリポジトリ本体の questions.json を対象にする。
const QUESTIONS_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'questions.json');
const DIFFICULTIES = ['A', 'B', 'C'];

// 「AとBのうちどちらでしょう」のような二択形式を検知するためのパターン。
// このアプリは1文字ずつ4択で答える方式なので、二択形式の問題は使わない方針。
const BINARY_CHOICE_PATTERN = /のうちどちら/;

// 濁点・半濁点が「か゛」「は゜」のように結合前提の単独文字として残っていないかの
// チェック用パターン（正しくは「が」「ぱ」のように1文字に合成されているべき）。
// 単独のまま残っていると、gameData.jsが1文字ずつ選択肢の文字プールを作る際に
// 濁点・半濁点だけが独立した1文字として紛れ込み、無関係な問題の選択肢にまで
// 「゛」だけの選択肢が出てしまう（2026-08-29に実際に発生した不具合）。
const STRAY_COMBINING_MARK_PATTERN = /[゙゚゛゜ﾞﾟ]/;

// inputは通常1つの文字列だが、「コリオリの力/コリオリ力」「にほん/にっぽん」のように
// 本当に2通り以上の正式な読み・言い方が通用する答えの場合だけ、配列で複数の正解候補を
// 持たせられる（gameData.jsのisValidQuestionEntryと同じ基準、2026-10-09追加）。
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

function main() {
  let loaded;
  try {
    loaded = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf-8'));
  } catch (e) {
    console.error(`questions.json の読み込みに失敗しました: ${e.message}`);
    process.exit(1);
  }

  const errors = []; // { category, difficulty, index, detail }
  const questionTextSeen = new Map(); // question文 -> "難易度[index]" の最初の出現位置

  let totalCount = 0;

  for (const d of DIFFICULTIES) {
    const list = Array.isArray(loaded[d]) ? loaded[d] : [];
    totalCount += list.length;

    list.forEach((item, i) => {
      const loc = `${d}[${i}]`;

      // 1. スキーマ検証（gameData.js の isValidQuestionEntry と同じ基準）
      if (!isValidQuestionEntry(item)) {
        errors.push({ category: 'スキーマ不正', difficulty: d, index: i, detail: JSON.stringify(item).slice(0, 80) });
        return; // 形が不正な場合、以降のチェックは意味がないのでスキップ
      }

      // 2. distractorsがちょうど3個か
      if (item.distractors.length !== 3) {
        errors.push({
          category: 'ダミー選択肢の数が3個でない',
          difficulty: d,
          index: i,
          detail: `${item.distractors.length}個: ${item.question}`,
        });
      }

      // 3. answerにカッコ書きが含まれていないか
      if (/[（(]/.test(item.answer)) {
        errors.push({ category: '答えにカッコ書きが含まれている', difficulty: d, index: i, detail: item.answer });
      }

      // 4. 答え漏れ（問題文に答えの文字列がそのまま含まれている）
      if (item.question.includes(item.answer)) {
        errors.push({ category: '答え漏れ（問題文に答えが含まれている）', difficulty: d, index: i, detail: item.question });
      }

      // 5. 二択形式（「AとBのうちどちらでしょう」等）
      if (BINARY_CHOICE_PATTERN.test(item.question)) {
        errors.push({ category: '二択形式の問題文', difficulty: d, index: i, detail: item.question });
      }

      // 6. ダミー選択肢の読みが正解の読み(のどれか)と衝突していないか
      const inputCandidates = normalizeInputCandidates(item.input);
      item.distractors.forEach((dist, di) => {
        if (inputCandidates.includes(dist.input)) {
          errors.push({
            category: 'ダミー選択肢の読みが正解と衝突',
            difficulty: d,
            index: i,
            detail: `distractors[${di}]="${dist.name}"(${dist.input}) / 正解="${item.answer}"(${inputCandidates.join('/')})`,
          });
        }
      });

      // 7. ダミー選択肢同士の読みが衝突していないか
      for (let a = 0; a < item.distractors.length; a++) {
        for (let b = a + 1; b < item.distractors.length; b++) {
          if (item.distractors[a].input === item.distractors[b].input) {
            errors.push({
              category: 'ダミー選択肢同士の読みが衝突',
              difficulty: d,
              index: i,
              detail: `distractors[${a}]="${item.distractors[a].name}" / distractors[${b}]="${item.distractors[b].name}" (共に読み: ${item.distractors[a].input})`,
            });
          }
        }
      }

      // 8. 濁点・半濁点が単独文字のまま残っていないか（answer/input/distractors全体）
      const combiningMarkFields = [
        ['answer', item.answer],
        ...inputCandidates.map((s, si) => [inputCandidates.length > 1 ? `input[${si}]` : 'input', s]),
        ...item.distractors.flatMap((dist, di) => [
          [`distractors[${di}].name`, dist.name],
          [`distractors[${di}].input`, dist.input],
        ]),
      ];
      combiningMarkFields.forEach(([field, value]) => {
        if (typeof value === 'string' && STRAY_COMBINING_MARK_PATTERN.test(value)) {
          errors.push({
            category: '濁点・半濁点が単独文字のまま残っている',
            difficulty: d,
            index: i,
            detail: `${field}="${value}"`,
          });
        }
      });

      // 9b. inputが配列(複数の正式な読み)の場合、room.jsの分岐判定が成立する形になっているか。
      // 候補同士が完全に同じ/一方が他方の接頭辞になっている（例:"にほん"と"にほんこく"）と、
      // 短い方に到達した時点で早押し側が「全候補一致」と誤判定して正解確定してしまう。
      if (inputCandidates.length > 1) {
        for (let a = 0; a < inputCandidates.length; a++) {
          for (let b = a + 1; b < inputCandidates.length; b++) {
            const [shorter, longer] = inputCandidates[a].length <= inputCandidates[b].length
              ? [inputCandidates[a], inputCandidates[b]]
              : [inputCandidates[b], inputCandidates[a]];
            if (longer.startsWith(shorter)) {
              errors.push({
                category: 'input配列の候補同士が同一または接頭辞の関係になっている',
                difficulty: d,
                index: i,
                detail: `input=[${inputCandidates.join(', ')}] ("${shorter}"が"${longer}"の接頭辞)`,
              });
            }
          }
        }
      }

      // 9. 問題文の完全重複（難易度をまたいでバンク全体でチェック）
      if (questionTextSeen.has(item.question)) {
        errors.push({
          category: '問題文の重複',
          difficulty: d,
          index: i,
          detail: `"${item.question}" は ${questionTextSeen.get(item.question)} と重複`,
        });
      } else {
        questionTextSeen.set(item.question, loc);
      }
    });
  }

  // ---- 結果表示 ----
  console.log(`問題総数: ${totalCount} (A=${(loaded.A || []).length}, B=${(loaded.B || []).length}, C=${(loaded.C || []).length})`);

  if (errors.length === 0) {
    console.log('問題なし。すべてのチェックを通過しました。');
    process.exit(0);
  }

  const byCategory = new Map();
  for (const err of errors) {
    if (!byCategory.has(err.category)) byCategory.set(err.category, []);
    byCategory.get(err.category).push(err);
  }

  console.log(`\n${errors.length}件の問題を検出しました:\n`);
  for (const [category, list] of byCategory) {
    console.log(`■ ${category}（${list.length}件）`);
    for (const err of list) {
      console.log(`  - ${err.difficulty}[${err.index}]: ${err.detail}`);
    }
    console.log('');
  }

  process.exit(1);
}

main();
