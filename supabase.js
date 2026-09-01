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

// 不適切な名前・迷惑行為の通報を記録する（審査用ダッシュボードはないため、開発者が
// Supabaseの管理画面で手動確認する運用）。失敗してもゲーム進行は止めない。
async function submitReport(reporterClientId, reportedClientId, reportedName, roomId, reason) {
  if (!supabase) return;
  const { error } = await supabase.from('reports').insert({
    reporter_client_id: reporterClientId,
    reported_client_id: reportedClientId,
    reported_name: reportedName,
    room_id: roomId || null,
    reason: reason || null,
  });
  if (error) console.error('Supabase submitReport failed:', error.message);
}

// ブロックは今のところ「自分の画面上でその相手の名前・アイコンを伏せる」表示上の効果のみ
// （合言葉制のため見知らぬ人との自動マッチングは存在しない）。ただし将来マッチング機能を
// 追加した際にすぐ活用できるよう、サーバー側（Supabase）に保存しておく。
async function addBlock(blockerClientId, blockedClientId, blockedName) {
  if (!supabase) return;
  const { error } = await supabase.from('blocks').upsert(
    { blocker_client_id: blockerClientId, blocked_client_id: blockedClientId, blocked_name: blockedName },
    { onConflict: 'blocker_client_id,blocked_client_id' }
  );
  if (error) console.error('Supabase addBlock failed:', error.message);
}

async function removeBlock(blockerClientId, blockedClientId) {
  if (!supabase) return;
  const { error } = await supabase
    .from('blocks')
    .delete()
    .eq('blocker_client_id', blockerClientId)
    .eq('blocked_client_id', blockedClientId);
  if (error) console.error('Supabase removeBlock failed:', error.message);
}

async function getBlockList(blockerClientId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('blocks')
    .select('blocked_client_id, blocked_name')
    .eq('blocker_client_id', blockerClientId);
  if (error) {
    console.error('Supabase getBlockList failed:', error.message);
    return [];
  }
  return (data || []).map((row) => ({ clientId: row.blocked_client_id, name: row.blocked_name }));
}

// アカウント削除。プロフィール（players）とブロックリストは削除するが、通報記録（reports）は
// 安全対策の記録として残す（他アプリの一般的な運用にならい、削除しない）。
async function deleteAccount(clientId) {
  if (!supabase) return;
  await supabase.from('blocks').delete().or(`blocker_client_id.eq.${clientId},blocked_client_id.eq.${clientId}`);
  const { error } = await supabase.from('players').delete().eq('client_id', clientId);
  if (error) console.error('Supabase deleteAccount failed:', error.message);
}

// アイコン画像（プレイヤーが自由にアップロードする分）をStorageの公開バケット"avatars"に
// clientId名のファイルとして保存する（upsert:trueで同じ人が再アップロードしたら上書き）。
// 事前審査は行わず、既存の通報・ブロック機能で事後対応する運用（ユーザーの明示的な判断）。
async function uploadIcon(clientId, buffer, contentType) {
  if (!supabase) return null;
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const path = `${clientId}.${ext}`;
  const { error } = await supabase.storage.from('avatars').upload(path, buffer, { contentType, upsert: true });
  if (error) {
    console.error('Supabase uploadIcon failed:', error.message);
    return null;
  }
  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  return data ? data.publicUrl : null;
}

module.exports = { upsertPlayer, submitReport, addBlock, removeBlock, getBlockList, deleteAccount, uploadIcon };
