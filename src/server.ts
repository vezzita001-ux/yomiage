// 音声（VOICEVOX / AivisSpeech）・OCR・スクショ読み上げ・画面収録などの「サーバー」の場所。
// ・空（既定）＝このアプリを開いているURLと同じサーバー（トンネルのURLで開いた時はこれまで通り）
// ・GitHub Pages など別の場所でアプリを開く時は、設定の「サーバーURL」にトンネルのURL（https://〜.trycloudflare.com）を入れる
// localStorage に保存（この端末・このURLだけ）。バックアップには入れない（URLが変わるため）。
export const SERVER_KEY = 'yomiage:serverUrl';

/** 入力されたURLを「https://ホスト名」の形にそろえる（パスや ?shot= などは捨てる）。不正なら null */
export function normalizeServerUrl(raw: string): string | null {
  let v = (raw || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    if (!u.hostname) return null;
    return u.origin;
  } catch { return null; }
}

/** 保存されているサーバーURL（空＝同じサーバー） */
export function getServerUrl(): string {
  try { return normalizeServerUrl(localStorage.getItem(SERVER_KEY) || '') || ''; } catch { return ''; }
}

export function setServerUrl(v: string) {
  try { if (v) localStorage.setItem(SERVER_KEY, v); else localStorage.removeItem(SERVER_KEY); } catch { /* 無視 */ }
}

/** サーバーの基点（末尾の / なし）。同じサーバーなら location.origin */
export function serverBase(): string {
  return getServerUrl() || location.origin;
}

/** サーバーのAPIの絶対URL（path は "/voicevox/tts?..." のように / から始める） */
export function api(path: string): string {
  return serverBase() + path;
}

/** 別のサーバーを使っているか */
export function usingRemoteServer(): boolean {
  const s = getServerUrl();
  return !!s && s !== location.origin;
}

export interface HealthResult { ok: boolean; detail: string }

/** 接続確認：/novel/health（音声エンジン）と /ocr/health（OCR）を見る */
export async function checkServer(base = serverBase()): Promise<HealthResult> {
  const get = async (p: string) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    try { return await fetch(base + p, { cache: 'no-store', signal: ctl.signal }); } finally { clearTimeout(t); }
  };
  try {
    const r = await get('/novel/health');
    if (!r.ok) return { ok: false, detail: `サーバーの応答：${r.status}` };
    const j = await r.json().catch(() => ({})) as { engines?: Record<string, boolean> };
    const parts: string[] = [];
    const e = j.engines || {};
    if ('voicevox' in e) parts.push(`VOICEVOX ${e.voicevox ? 'OK' : 'NG'}`);
    if ('aivis' in e) parts.push(`AivisSpeech ${e.aivis ? 'OK' : 'NG'}`);
    try { const o = await get('/ocr/health'); parts.push(`OCR ${o.ok ? 'OK' : 'NG'}`); } catch { parts.push('OCR NG'); }
    return { ok: true, detail: parts.join('・') };
  } catch (e) {
    return { ok: false, detail: (e as Error).name === 'AbortError' ? '時間切れ（サーバーが止まっているか、URLが古い可能性）' : '接続できません（URLが違う・サーバーが止まっている・トンネルのURLが変わった可能性）' };
  }
}
