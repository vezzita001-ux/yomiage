// 読み方辞書：読み上げに送る文字だけを置き換える（画面の表示は元のまま）

export interface DictEntry {
  id: string;
  from: string; // 表記（正規表現も可）
  to: string; // 読み
  regex: boolean;
  enabled: boolean;
}

const KEY = 'yomiage:dict';

export function loadDict(): DictEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((e) => e && typeof e.from === 'string') : [];
  } catch { return []; }
}
export function saveDict(d: DictEntry[]) {
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* 無視 */ }
  compiled = null;
}
export function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/** 正規表現が正しいか確認。正しくなければエラー文を返す */
export function checkRegex(src: string): string | null {
  try { new RegExp(src, 'gu'); return null; } catch (e) { return (e as Error).message; }
}

let compiled: Array<(s: string) => string> | null = null;
function compile(d: DictEntry[]) {
  const fns: Array<(s: string) => string> = [];
  for (const e of d) {
    if (!e.enabled || !e.from) continue;
    if (e.regex) {
      try { const re = new RegExp(e.from, 'gu'); fns.push((s) => s.replace(re, e.to)); } catch { /* 無効な式は飛ばす */ }
    } else {
      fns.push((s) => s.split(e.from).join(e.to));
    }
  }
  return fns;
}

/** 辞書を上から順に適用 */
export function applyDict(text: string, d?: DictEntry[]): string {
  const fns = d ? compile(d) : (compiled ??= compile(loadDict()));
  let s = text;
  for (const f of fns) s = f(s);
  return s;
}

export function exportDict(d: DictEntry[]): string {
  return JSON.stringify({ app: 'yomiage', type: 'dictionary', version: 1, entries: d.map(({ from, to, regex, enabled }) => ({ from, to, regex, enabled })) }, null, 2);
}

/** 読み込み：{entries:[...]} 形式・配列・{"表記":"読み"} 形式に対応 */
export function parseDictImport(json: string): DictEntry[] {
  const v = JSON.parse(json);
  let arr: Array<Partial<DictEntry>> = [];
  if (Array.isArray(v)) arr = v;
  else if (v && Array.isArray(v.entries)) arr = v.entries;
  else if (v && typeof v === 'object') arr = Object.entries(v).map(([from, to]) => ({ from, to: String(to) }));
  return arr
    .filter((e) => e && typeof e.from === 'string' && e.from.length > 0)
    .map((e) => ({ id: newId(), from: e.from!, to: String(e.to ?? ''), regex: !!e.regex, enabled: e.enabled !== false }));
}
