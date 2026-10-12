// 「📚 よみあげに送る」：読み上げブックマークレットから送られたチャット・小説の文章を本にする
// 送り方：クリップボード（1行目に【よみあげ送り】{"k":キー,"t":題名}）か、URLの # に入れた文（サーバーへは何も送らない）

export const CHAT_MARK = '【よみあげ送り】';
export interface ChatPayload { key: string; title: string; body: string }

const HEAD = /^\s*(■\s*)?(第\s*[0-9０-９一二三四五六七八九十百千]+\s*[話章節部幕回]|プロローグ|エピローグ|序章|終章|【\s*第)/;
export const isHeading = (line: string) => HEAD.test(line);

function hashStr(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** 貼り付けられた文（印あり・なし）を読む */
export function parsePayload(raw: string): ChatPayload | null {
  let text = String(raw || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  let key = '', title = '';
  const nl = text.indexOf('\n');
  const first = (nl < 0 ? text : text.slice(0, nl)).trim();
  if (first.startsWith(CHAT_MARK)) {
    try { const j = JSON.parse(first.slice(CHAT_MARK.length)); key = String(j.k || ''); title = String(j.t || ''); } catch { /* 印が壊れていても本文は使う */ }
    text = nl < 0 ? '' : text.slice(nl + 1);
  }
  const body = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!body) return null;
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!title) {
    const h = lines.find(isHeading);
    const d = new Date();
    title = (h || lines[0]).replace(/^■\s*/, '').slice(0, 24) + `（${d.getMonth() + 1}月${d.getDate()}日）`;
  }
  if (!key) key = 'paste-' + hashStr(lines.slice(0, 5).join('\n'));
  return { key: key.slice(0, 300), title: title.slice(0, 80), body };
}

/** 本として保存するファイルの中身（1行目に印。開く時に同じ本と分かるようにする） */
export function fileText(p: ChatPayload): string {
  return CHAT_MARK + JSON.stringify({ k: p.key, t: p.title }) + '\n' + p.body + '\n';
}

export function chatIdFor(key: string) { return 'chat|' + key; }

/** 見出し（第N話など）の所で章に分ける。見出しが無い／長すぎる章は約2000文字で分ける */
export function chapters(body: string): Array<{ head: string; text: string }> {
  const out: Array<{ head: string; text: string }> = [];
  let cur: { head: string; text: string } | null = null;
  for (const line of body.split('\n')) {
    if (isHeading(line)) { cur = { head: line.trim().replace(/^■\s*/, ''), text: '' }; out.push(cur); }
    if (!cur) { cur = { head: '', text: '' }; out.push(cur); }
    cur.text += (isHeading(line) ? line.trim().replace(/^■\s*/, '') : line) + '\n';
  }
  return out.filter((c) => c.text.trim());
}

export function pagesOf(body: string, size = 2000): { pages: string[]; unit: string } {
  const chs = chapters(body);
  const hasHead = chs.some((c) => c.head);
  const pages: string[] = [];
  for (const c of chs) {
    let cur = '';
    for (const line of c.text.split('\n')) {
      if (cur.length + line.length > size && cur.trim()) { pages.push(cur); cur = ''; }
      cur += line + '\n';
    }
    if (cur.trim()) pages.push(cur);
  }
  return { pages: pages.length ? pages : [''], unit: hasHead && pages.length === chs.length ? '章' : 'ページ' };
}

/** もう一度送られた時：前の章はそのまま（読書位置がずれないように）、続きが増えた章は差し替え、新しい章は後ろに足す */
export function mergeBodies(oldBody: string, newBody: string): { body: string; added: number; updated: number } {
  const norm = (s: string) => s.replace(/\s+/g, '');
  const key = (c: { head: string; text: string }, i: number) => c.head ? 'h:' + norm(c.head) : 'p:' + norm(c.text).slice(0, 60) + (norm(c.text).length ? '' : i);
  const olds = chapters(oldBody), news = chapters(newBody);
  const idx = new Map<string, number>();
  olds.forEach((c, i) => idx.set(key(c, i), i));
  let added = 0, updated = 0;
  const out = olds.map((c) => c.text);
  for (let i = 0; i < news.length; i++) {
    const c = news[i], k = key(c, i);
    const j = idx.get(k);
    if (j === undefined) {
      // 見出しなしの塊：中身が前の文にすっかり入っていれば足さない
      if (!c.head && norm(oldBody).includes(norm(c.text))) continue;
      out.push(c.text); added++;
    } else if (norm(c.text) !== norm(out[j]) && norm(c.text).startsWith(norm(out[j]).slice(0, 40)) && norm(c.text).length > norm(out[j]).length) { out[j] = c.text; updated++; }
  }
  return { body: out.join('').replace(/\n{3,}/g, '\n\n').trim(), added, updated };
}

// ---- URL の # に入れる形（base64url の UTF-8 JSON） ----
export function encodeHash(p: ChatPayload): string {
  const b = new TextEncoder().encode(JSON.stringify({ k: p.key, t: p.title, x: p.body }));
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeHash(h: string): ChatPayload | null {
  try {
    const s = atob(h.replace(/-/g, '+').replace(/_/g, '/'));
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    const j = JSON.parse(new TextDecoder().decode(b));
    if (!j || !j.x) return null;
    return parsePayload(CHAT_MARK + JSON.stringify({ k: j.k || '', t: j.t || '' }) + '\n' + j.x);
  } catch { return null; }
}
