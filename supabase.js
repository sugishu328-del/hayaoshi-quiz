const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

// 環境変数が未設定でもゲーム自体は動くようにする（ローカルでSupabase無しでも開発できるように）。
const supabase = (url && key) ? createClient(url, key) : null;
if (!supabase) {
  console.warn('SUPABASE_URL / SUPABASE_SECRET_KEY が未設定のため、プレイヤー情報の永続化は無効です。');
}

// clientId単位でプレイヤーの表示名・アイコンを記録・更新する。失敗してもゲーム進行は止めない（fire-and-forget）。
// icon省略時（ゲスト参加時）は、以前アカウント作成時に保存したicon_idを消してしまわないよう更新しない。
async function upsertPlayer(clientId, displayName, icon) {
  if (!supabase) return;
  const payload = { client_id: clientId, display_name: displayName };
  if (icon) payload.icon_id = icon;
  const { error } = await supabase
    .from('players')
    .upsert(payload, { onConflict: 'client_id' });
  if (error) console.error('Supabase upsertPlayer failed:', error.message);
}

module.exports = { upsertPlayer };
