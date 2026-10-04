// OCRで読み取った本文の「文字の修正」（スキャン間違いの手直し）
// ファイルごとに localStorage に保存する（キー：yomiage:fix:<ファイルID>）。
// ・行ごとの修正：ページ番号と行番号（サーバーOCRは行、それ以外は段落）ごとに、元の文字と直した文字を持つ
// ・一括置換：本全体に適用する「文字 → 文字」の置き換え
// ・すべての本の一括置換：本棚のすべての本（あとから開いた本・読み取った本も）に効く置き換え（キー：yomiage:fixall）
// 表示と読み上げの両方に使われる。順番：行ごとの修正 → この本の一括置換 → すべての本の一括置換 → 読み方辞書。

export interface LineFix { orig: string; text: string; at: number }
export interface BookRule { id: string; from: string; to: string; at: number }
export interface DocFixes { v: 1; pages: Record<string, Record<string, LineFix>>; rules: BookRule[] }

const PREFIX = 'yomiage:fix:';
const keyOf = (docId: string) => PREFIX + docId;

export function loadFixes(docId: string): DocFixes {
  try {
    const j = JSON.parse(localStorage.getItem(keyOf(docId)) || 'null');
    if (j && j.v === 1) return { v: 1, pages: j.pages || {}, rules: Array.isArray(j.rules) ? j.rules : [] };
  } catch { /* 壊れていたら空から */ }
  return { v: 1, pages: {}, rules: [] };
}

export function saveFixes(docId: string, f: DocFixes) {
  const empty = !f.rules.length && !Object.values(f.pages).some((p) => Object.keys(p).length);
  if (empty) localStorage.removeItem(keyOf(docId));
  else localStorage.setItem(keyOf(docId), JSON.stringify(f));
}

export function isFixKey(k: string) { return k.startsWith(PREFIX); }

// ---------- すべての本の一括置換 ----------
export const GLOBAL_KEY = 'yomiage:fixall';
export interface GlobalFixes { v: 1; rules: BookRule[] }
const okRule = (r: unknown): r is BookRule => !!r && typeof (r as BookRule).from === 'string' && (r as BookRule).from.length > 0 && typeof (r as BookRule).to === 'string';
/** 保存されている形（JSON文字列）から読む。壊れていれば空 */
export function parseGlobalRules(json: string | null): BookRule[] {
  try {
    const j = JSON.parse(json || 'null');
    const arr = Array.isArray(j) ? j : j && Array.isArray(j.rules) ? j.rules : [];
    return arr.filter(okRule).map((r: BookRule) => ({ id: String(r.id || Math.random().toString(36).slice(2, 10)), from: r.from, to: r.to, at: Number(r.at) || 0 }));
  } catch { return []; }
}
export function loadGlobalRules(): BookRule[] { return parseGlobalRules(localStorage.getItem(GLOBAL_KEY)); }
export function saveGlobalRules(rules: BookRule[]) {
  if (!rules.length) localStorage.removeItem(GLOBAL_KEY);
  else localStorage.setItem(GLOBAL_KEY, JSON.stringify({ v: 1, rules } as GlobalFixes));
}
/** バックアップの復元（足す）：今のルールのあとに、まだ無い置き換えだけを足す。足すものが無ければ null */
export function mergeGlobalRules(curJson: string, addJson: string): string | null {
  const a = parseGlobalRules(curJson), b = parseGlobalRules(addJson);
  const seen = new Set(a.map((r) => `${r.from}\u0000${r.to}`));
  const add = b.filter((r) => !seen.has(`${r.from}\u0000${r.to}`));
  return add.length ? JSON.stringify({ v: 1, rules: [...a, ...add] } as GlobalFixes) : null;
}

/** すべて置換（literal）。件数も返す */
export function replaceAllCount(s: string, from: string, to: string): { out: string; n: number } {
  if (!from) return { out: s, n: 0 };
  const parts = s.split(from);
  return { out: parts.join(to), n: parts.length - 1 };
}

/** 一括置換を1つの文字列に適用（登録順） */
export function applyRules(s: string, rules: BookRule[]): string {
  for (const r of rules) s = replaceAllCount(s, r.from, r.to).out;
  return s;
}

/**
 * ページの単位（行・段落）に修正を当てる。
 * 行番号の位置の元の文字が保存時と同じなら置き換え、ずれていれば同じ文字の行を探す（OCRのやり直し等に備える）。
 * 一括置換は、行の修正のあとに本全体（修正した行も含む）に当てる。
 */
export function applyToUnits(units: string[], page: Record<string, LineFix> | undefined, rules: BookRule[]): { units: string[]; fixed: boolean[]; orig: string[] } {
  const out = units.slice();
  const fixed = units.map(() => false);
  if (page) {
    for (const [k, fx] of Object.entries(page)) {
      let idx = Number(k);
      if (units[idx] !== fx.orig) idx = units.indexOf(fx.orig);
      if (idx < 0 || fixed[idx]) continue;
      out[idx] = fx.text;
      fixed[idx] = true;
    }
  }
  if (rules.length) out.forEach((t, i) => { out[i] = applyRules(t, rules); });
  return { units: out, fixed, orig: units };
}

/** 修正前後の文字から、違う部分だけを取り出す（一括置換の候補） */
export function diffCore(a: string, b: string): { from: string; to: string } | null {
  if (a === b) return null;
  const A = Array.from(a), B = Array.from(b);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const from = A.slice(p, A.length - s).join('');
  const to = B.slice(p, B.length - s).join('');
  return from ? { from, to } : null;
}
