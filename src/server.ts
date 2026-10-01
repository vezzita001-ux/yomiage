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

// ---------- 公開されている「今のサーバーURL」（トンネルが作り直されるとURLが変わるため） ----------
// ボックスの見張り番（tunnel-watchdog.sh）が GitHub の server ブランチの server.json に書く。トークン不要で読める。
const PUBLISHED = [
  'https://api.github.com/repos/vezzita001-ux/yomiage/contents/server.json?ref=server', // 新しい（1時間60回まで）
  'https://raw.githubusercontent.com/vezzita001-ux/yomiage/server/server.json', // 予備（最大5分ほど古いことがある）
];

/** 公開されているサーバーURL（取れなければ null） */
export async function fetchPublishedUrl(): Promise<string | null> {
  for (const u of PUBLISHED) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(u.includes('raw.') ? `${u}?t=${Date.now()}` : u, { cache: 'no-store', signal: ctl.signal });
      if (!r.ok) continue;
      let j = await r.json() as { url?: string; content?: string };
      if (j.content) j = JSON.parse(atob(j.content));
      const n = normalizeServerUrl(j.url || '');
      if (n) return n;
    } catch { /* 次を試す */ } finally { clearTimeout(t); }
  }
  return null;
}

/** 自動で書き換えてよいか：未設定（ローカル以外）か、トンネルのURL（〜.trycloudflare.com）の時だけ。手で入れた別のURLは変えない */
function autoUpdatable(): boolean {
  const s = getServerUrl();
  if (!s) return !/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname);
  try { return new URL(s).hostname.endsWith('.trycloudflare.com'); } catch { return false; }
}

let lastAuto = 0;
/** 公開URLを見て、今のサーバーURLと違えば自動で更新する。更新したら true（何度も呼ばれても30秒に1回だけ見る） */
export async function autoUpdateServerUrl(force = false): Promise<boolean> {
  if (!autoUpdatable()) return false;
  if (!force && Date.now() - lastAuto < 30000) return false;
  lastAuto = Date.now();
  const p = await fetchPublishedUrl();
  if (!p || p === serverBase() || !autoUpdatable()) return false;
  setServerUrl(p === location.origin ? '' : p);
  return true;
}

/** サーバーへの通信が失敗した時に呼ぶ（main.ts が受け取って公開URLを確かめる） */
export function notifyServerFail() {
  try { window.dispatchEvent(new Event('yomiage:serverfail')); } catch { /* 無視 */ }
}
