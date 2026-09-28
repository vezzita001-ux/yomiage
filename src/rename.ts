// 本棚の本の名前を変える。ファイルそのもの（とファイルID）は変えずに、表示名・書籍名・巻・保存するときのファイル名だけを覚える
// → 読書位置・OCR結果・文字の修正（どれもファイルIDで保存）はそのまま使える
import type { BookName } from './docs';

export interface NameRec {
  mode: 'book' | 'free';
  vol: string;   // 巻No.（空なら無し）。「3」「03」「3-2」など
  title: string; // 書籍名
  free: string;  // 自由な名前（拡張子なし）
  /** 最初に名前を変える前の本棚の表示名（元に戻す用） */
  orig?: string;
}
const PREFIX = 'yomiage:name:';

export function loadName(id: string): NameRec | null {
  try { const r = JSON.parse(localStorage.getItem(PREFIX + id) || 'null'); return r && (r.title || r.free) ? r : null; } catch { return null; }
}
export function saveName(id: string, r: NameRec | null) {
  try { if (r) localStorage.setItem(PREFIX + id, JSON.stringify(r)); else localStorage.removeItem(PREFIX + id); } catch { /* 無視 */ }
}

const FW: Record<string, string> = { '/': '／', '\\': '＼', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' };
/** ファイル名に使えない文字を全角に（制御文字・改行は空白に）。前後の空白・先頭の「.」は取る */
export function sanitize(s: string): string {
  return s.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[/\\:*?"<>|]/g, (c) => FW[c]).replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120);
}
/** 巻No. を整える：「3」→「03」、「3-2」→「03-2」、「３」も可。空・不正なら '' */
export function normVol(v: string): string {
  const s = v.normalize('NFKC').trim();
  const m = /^(\d{1,4})(?:-(\d{1,3}))?$/.exec(s);
  if (!m) return '';
  return String(Number(m[1])).padStart(2, '0') + (m[2] ? `-${Number(m[2])}` : '');
}
export function extOf(fileName: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(fileName);
  return m ? m[1].toLowerCase() : '';
}
/** 保存するときのファイル名 */
export function fileNameFor(r: NameRec, ext: string): string {
  const e = ext ? `.${ext}` : '';
  if (r.mode === 'free') {
    const f = sanitize(r.free).replace(new RegExp(`\\.${ext}$`, 'i'), '') || '無題';
    return f + e;
  }
  const t = sanitize(r.title) || '無題';
  const v = normVol(r.vol);
  return v ? `${v}.GrPDF.${t}${e}` : `${t}${e}`;
}
/** 書籍名と巻（本棚の並び・切り取り設定の共有に使う）。自由な名前の時は null */
export function bookFor(r: NameRec): BookName | null {
  if (r.mode !== 'book') return null;
  const title = sanitize(r.title);
  if (!title) return null;
  const vol = normVol(r.vol);
  if (!vol) return { title, vol: '', volNum: -1 };
  const [maj, part] = vol.split('-');
  return { title, vol, volNum: part ? parseFloat(maj) + parseInt(part, 10) / 1000 : parseFloat(maj) };
}
/** 表示名 */
export function displayFor(r: NameRec): string {
  if (r.mode === 'free') return sanitize(r.free) || '無題';
  const b = bookFor(r);
  if (!b) return '無題';
  return b.vol ? `${b.title}（${b.vol}巻）` : b.title;
}

/** PDF の Info 辞書の /Title を軽く読む（pdf.js を使わずにバイト列から。圧縮されたオブジェクトの中にある時は見つからない） */
export function pdfInfoTitle(bytes: Uint8Array): string | null {
  // 末尾近くの trailer にある /Info n 0 R を探し、その obj の /Title を読む。見つからなければ全体から最初の /Title
  const latin = (a: number, b: number) => { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i]); return s; };
  const tail = latin(Math.max(0, bytes.length - 4096), bytes.length);
  const info = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(tail);
  const head = latin(0, Math.min(bytes.length, 8 * 1024 * 1024));
  let region = head;
  if (info) {
    const at = head.lastIndexOf(`\n${info[1]} ${info[2]} obj`) >= 0 ? head.lastIndexOf(`\n${info[1]} ${info[2]} obj`) : head.lastIndexOf(`\r${info[1]} ${info[2]} obj`);
    if (at >= 0) region = head.slice(at, at + 4096);
    else if (bytes.length > head.length) { const whole = tail; region = whole; }
  }
  const m = /\/Title\s*(\(|<)/.exec(region);
  if (!m) return null;
  let raw: number[] = [];
  let i = m.index + m[0].length;
  if (m[1] === '<') {
    const end = region.indexOf('>', i);
    const hex = region.slice(i, end).replace(/\s/g, '');
    for (let k = 0; k + 1 < hex.length; k += 2) raw.push(parseInt(hex.slice(k, k + 2), 16));
  } else {
    let depth = 1;
    for (; i < region.length && depth > 0; i++) {
      const c = region.charCodeAt(i);
      if (c === 0x5c) { // バックスラッシュ
        const n = region[++i];
        const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
        if (n in esc) raw.push(esc[n]);
        else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(region[i + 1])) o += region[++i]; raw.push(parseInt(o, 8)); }
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) break;
      raw.push(c);
    }
  }
  let s: string;
  if (raw[0] === 0xfe && raw[1] === 0xff) { s = ''; for (let k = 2; k + 1 < raw.length; k += 2) s += String.fromCharCode((raw[k] << 8) | raw[k + 1]); }
  else if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) s = new TextDecoder().decode(new Uint8Array(raw.slice(3)));
  else s = raw.map((c) => String.fromCharCode(c)).join('');
  s = s.replace(/[\u0000-\u001f]/g, ' ').trim();
  return s || null;
}
