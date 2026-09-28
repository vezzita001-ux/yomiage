// スクショ本：何回かに分けて選んだスクリーンショットを1冊（「NN.GrPDF.書籍名.pdf」）にまとめる
// ・写真／ファイル（iCloud Drive・Googleドライブ・このiPhone内）／zip から追加できる
// ・撮影日時（EXIF/XMP → ファイル名の日時 → ファイルの日時）の順に並べ、同じページの重複・真っ黒/真っ白の画面を除く
// ・画像は1枚ずつ縮小して IndexedDB に置く（iPhone SE のメモリでも数百枚）。PDF は Blob をつなぐだけで作る
import JSZip from 'jszip';
import { captureInfo, natural } from './shots';
import { makePdf, type PageOcr } from './pdfwrite';

export interface ShotItem {
  key?: number;
  blob: Blob; thumb: Blob; w: number; h: number;
  /** 撮影/保存日時と、その元（exif/xmp/png＝画像の中の情報、name＝ファイル名の日時、file＝ファイルの日時） */
  ts: number; how: TimeHow;
  /** ファイル名（zip の中ならフォルダ名も含む） */
  name: string;
  /** 取り込んだ順（何回目に追加したか・その中の順番。読み込みが終わった順ではない） */
  seq: number;
  /** 手で並べた順番 */
  pos?: number;
  sig: Uint8Array; mean: number; std: number;
  state?: 'ok' | 'dup' | 'blank'; manual?: 'in' | 'out';
  /** 読み取った文字（PDF に入れる。一度読めば作り直しても再利用） */
  ocr?: PageOcr | null;
}
export type TimeHow = 'exif' | 'xmp' | 'png' | 'name' | 'file';
export type SortMode = 'name-asc' | 'name-desc' | 'time-asc' | 'time-desc' | 'import' | 'manual';
export const SORT_LABEL: Record<SortMode, string> = {
  'name-asc': 'ファイル名（昇順）', 'name-desc': 'ファイル名（降順）',
  'time-asc': '撮影/保存日時（古い順）', 'time-desc': '撮影/保存日時（新しい順）',
  import: '取り込んだ順', manual: '手で並べた順',
};
export const HOW_LABEL: Record<TimeHow, string> = { exif: '撮影日時（EXIF）', xmp: '撮影日時（XMP）', png: 'PNGの日時', name: 'ファイル名の日時', file: 'ファイルの日時' };
const DB = 'yomiage-shotbook';
const MAX_LONG = 2000;          // これより大きい画像は縮小（SE3 の 1334 はそのまま）
const SW = 36, SH = 64;         // 重複判定用の小さな画像
const META = 'yomiage:shotbook:meta';

function db(version?: number): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = version ? indexedDB.open(DB, version) : indexedDB.open(DB);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('items')) r.result.createObjectStore('items', { keyPath: 'key', autoIncrement: true }); };
    r.onsuccess = () => {
      const d = r.result;
      // 入れ物が無い（別の処理が空のまま作った等）時は版を上げて作り直す
      if (!d.objectStoreNames.contains('items')) { const v = d.version + 1; d.close(); db(v).then(res, rej); return; }
      res(d);
    };
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const d = await db();
  return new Promise<T>((res, rej) => {
    const t = d.transaction('items', mode);
    const req = f(t.objectStore('items'));
    t.oncomplete = () => { d.close(); res(req ? req.result : (undefined as T)); };
    t.onerror = () => { d.close(); rej(t.error || new Error('保存できませんでした')); };
    t.onabort = () => { d.close(); rej(t.error || new Error('保存できませんでした（空き容量が足りない可能性）')); };
  });
}
// IndexedDB に画像を置けない環境（プライベートブラウズなど）では、メモリに置く（アプリを閉じると消える）
let mem: Map<number, ShotItem> | null = null;
let memKey = 1;
export const memoryMode = () => !!mem;
export async function listItems(): Promise<ShotItem[]> {
  if (mem) return [...mem.values()];
  try { return await tx<ShotItem[]>('readonly', (s) => s.getAll()); } catch (e) { console.warn('[SHOTBOOK] IndexedDB list failed → memory', e); mem = new Map(); return []; }
}
export async function putItem(it: ShotItem): Promise<void> {
  if (!mem) {
    try { const k = await tx<IDBValidKey>('readwrite', (s) => s.put(it)); it.key = Number(k); return; }
    catch (e) {
      console.warn('[SHOTBOOK] IndexedDB put failed → memory', e);
      mem = new Map();
      try { for (const old of await tx<ShotItem[]>('readonly', (s) => s.getAll())) { mem.set(old.key!, old); memKey = Math.max(memKey, old.key! + 1); } } catch { /* 読めなければ空から */ }
    }
  }
  if (it.key == null) it.key = memKey++;
  mem.set(it.key, it);
}
/** まとめて保存（並べ替えの結果など） */
export async function putMany(items: ShotItem[]): Promise<void> {
  if (!mem) {
    try { await tx('readwrite', (s) => { for (const it of items) s.put(it); }); return; }
    catch (e) { console.warn('[SHOTBOOK] IndexedDB putMany failed → memory', e); mem = new Map(); }
  }
  for (const it of items) { if (it.key == null) it.key = memKey++; mem.set(it.key, it); }
}
export async function clearItems(): Promise<void> {
  if (mem) mem.clear();
  try { await tx('readwrite', (s) => s.clear()); } catch { /* 無視 */ }
}

export interface Meta { title: string; vol: number; built?: string; builtName?: string; sort?: SortMode; splitOffered?: boolean; split?: 'none' | 'every' | 'ranges'; splitVal?: string; builtParts?: Record<string, string> }
export function loadMeta(): Meta { try { return JSON.parse(localStorage.getItem(META) || 'null') || { title: '', vol: 1 }; } catch { return { title: '', vol: 1 }; } }
export function saveMeta(m: Meta) { localStorage.setItem(META, JSON.stringify(m)); }

const IMG_RE = /\.(png|jpe?g|heic|heif|webp|gif|bmp|tiff?)$/i;
export const isImage = (f: File) => f.type.startsWith('image/') || IMG_RE.test(f.name);
export const isZip = (f: File) => /zip/.test(f.type) || /\.zip$/i.test(f.name);

/** ファイル名に入っている日時（「2026-09-27 4.55.12」「20260927_045512」「Screenshot_20260927-045512」など） */
export function nameTime(name: string): number | null {
  const m = /(20\d\d)[-_.年]?(\d\d)[-_.月]?(\d\d)日?[ _T-]*(?:at )?(\d{1,2})[.:_時-]?(\d\d)[.:_分-]?(\d\d)(?:[.,](\d{1,3}))?/.exec(name);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? +m[7].padEnd(3, '0') : 0).getTime();
  return Number.isFinite(t) && +m[2] >= 1 && +m[2] <= 12 ? t : null;
}

async function decode(f: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try { return await createImageBitmap(f); } catch { /* HEIC などは img で */ }
  const url = URL.createObjectURL(f);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
const toBlob = (c: HTMLCanvasElement, q: number) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('画像の変換に失敗しました'))), 'image/jpeg', q));

/** 1枚を縮小して ShotItem にする。seq は取り込んだ順（呼ぶ側が選ばれた順に付ける） */
export async function prepare(f: File, seq: number, name = f.name): Promise<ShotItem> {
  const info = await captureInfo(f).catch(() => null);
  const nt = info ? null : nameTime(name);
  const ts = info?.t ?? nt ?? f.lastModified;
  const src = await decode(f);
  const w0 = 'naturalWidth' in src ? src.naturalWidth : src.width, h0 = 'naturalHeight' in src ? src.naturalHeight : src.height;
  if (!w0 || !h0) throw new Error('画像を読み込めませんでした');
  const sc = Math.min(1, MAX_LONG / Math.max(w0, h0));
  const w = Math.round(w0 * sc), h = Math.round(h0 * sc);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  if ('close' in src) src.close();
  const blob = await toBlob(c, 0.85);
  const t = document.createElement('canvas'); t.width = 120; t.height = Math.round(120 * h / w);
  t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
  const thumb = await toBlob(t, 0.6);
  const s = document.createElement('canvas'); s.width = SW; s.height = SH;
  const sx = s.getContext('2d', { willReadFrequently: true })!;
  // 上下の帯（時刻・電池・位置No.など）は比べない
  sx.drawImage(c, 0, h * 0.08, w, h * 0.84, 0, 0, SW, SH);
  const px = sx.getImageData(0, 0, SW, SH).data;
  const sig = new Uint8Array(SW * SH);
  let sum = 0, sq = 0;
  for (let i = 0; i < sig.length; i++) { const v = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000; sig[i] = v; sum += v; sq += v * v; }
  const mean = sum / sig.length, std = Math.sqrt(Math.max(0, sq / sig.length - mean * mean));
  c.width = 0; t.width = 0; s.width = 0;
  return { blob, thumb, w, h, ts, how: info ? info.src : nt ? 'name' : 'file', name, seq, sig, mean, std };
}

// zip の日時は「その土地の時刻」で入っているが、JSZip は UTC として読むので直す
const zipLocal = (d?: Date) => (d && Number.isFinite(d.getTime()) ? d.getTime() + d.getTimezoneOffset() * 60000 : Date.now());
/** zip の中の画像を取り出す（フォルダごと zip にした時など） */
export async function unzipImages(f: File): Promise<File[]> {
  const zip = await JSZip.loadAsync(f);
  const out: File[] = [];
  const entries = Object.values(zip.files).sort((a, b) => natural.compare(a.name, b.name)).filter((e) => !e.dir && IMG_RE.test(e.name) && !/(^|\/)(__MACOSX|\._)/.test(e.name));
  for (const e of entries) {
    const b = await e.async('blob');
    out.push(new File([b], e.name, { type: /\.png$/i.test(e.name) ? 'image/png' : /\.jpe?g$/i.test(e.name) ? 'image/jpeg' : '', lastModified: zipLocal(e.date) }));
  }
  return out;
}

/** 2枚の違い（0〜255 の平均の差。明るさの全体的な違い＝ダイアログの暗い背景は差し引く） */
export function sigDiff(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

/** 並べ替え（読み込みが終わった順には決してしない。同じ値なら ファイル名 → 取り込んだ順 で必ず同じ結果になる） */
export function sortItems(items: ShotItem[], mode: SortMode = 'name-asc'): ShotItem[] {
  const byName = (a: ShotItem, b: ShotItem) => natural.compare(a.name, b.name);
  const bySeq = (a: ShotItem, b: ShotItem) => a.seq - b.seq;
  const cmp: Record<SortMode, (a: ShotItem, b: ShotItem) => number> = {
    'name-asc': (a, b) => byName(a, b) || bySeq(a, b),
    'name-desc': (a, b) => byName(b, a) || bySeq(b, a),
    'time-asc': (a, b) => a.ts - b.ts || byName(a, b) || bySeq(a, b),
    'time-desc': (a, b) => b.ts - a.ts || byName(b, a) || bySeq(b, a),
    import: bySeq,
    manual: (a, b) => (a.pos ?? 1e12 + a.seq) - (b.pos ?? 1e12 + b.seq) || bySeq(a, b),
  };
  return items.sort(cmp[mode]);
}
/** 並べ替えて、重複（前のページと同じ）・真っ黒/真っ白を判定する */
export function classify(items: ShotItem[], mode: SortMode = 'name-asc'): ShotItem[] {
  sortItems(items, mode);
  let prev: ShotItem | null = null;
  for (const it of items) {
    if (it.std < 3) it.state = 'blank';
    else if (prev && sigDiff(prev.sig, it.sig) < 2.2) it.state = 'dup';
    else it.state = 'ok';
    if (inBook(it)) prev = it;
  }
  return items;
}
/** 今の並びを「手で並べた順」として番号を付ける */
export function freezeOrder(items: ShotItem[]) { items.forEach((it, i) => { it.pos = i; }); }
/** ファイル名に並べるための番号があるか（写真から選ぶと「image.jpg」ばかりのことがある） */
export function namesUseful(items: ShotItem[]): boolean {
  if (items.length < 2) return true;
  return new Set(items.map((x) => x.name)).size === items.length;
}
/** 分け方：「N枚ごと」または「1-120,121-250」→ ページ番号（1から）の範囲の一覧 */
export function splitRanges(count: number, mode: 'none' | 'every' | 'ranges' | undefined, val: string | undefined): Array<[number, number]> {
  if (mode === 'every') {
    const n = Math.max(1, Math.floor(Number(val) || 0));
    if (!n || n >= count) return [[1, count]];
    const out: Array<[number, number]> = [];
    for (let a = 1; a <= count; a += n) out.push([a, Math.min(count, a + n - 1)]);
    return out;
  }
  if (mode === 'ranges') {
    const out: Array<[number, number]> = [];
    for (const part of (val || '').split(/[,、，\s]+/)) {
      const m = /^(\d+)\s*[-~〜ー－]\s*(\d+)?$/.exec(part.trim()) || /^(\d+)$/.exec(part.trim());
      if (!m) continue;
      const a = Math.max(1, +m[1]), b = Math.min(count, m[2] ? +m[2] : m[0].includes('-') || /[~〜ー－]/.test(m[0]) ? count : +m[1]);
      if (a <= b) out.push([a, b]);
    }
    return out.length ? out : [[1, count]];
  }
  return [[1, count]];
}
export const inBook = (it: ShotItem) => (it.manual ? it.manual === 'in' : it.state === 'ok');

/** JPEG を1ページずつ並べた PDF（画像はそのまま埋め込み。読み取った文字があれば見えない文字の層と /YomiageOCR も入れる） */
export function makePdfBlob(pages: Array<{ blob: Blob; w: number; h: number; ocr?: PageOcr | null }>, title: string): Blob {
  return makePdf(pages, title);
}

/** サムネイルを作り直す（バックアップには入れないため） */
export async function makeThumb(blob: Blob): Promise<Blob> {
  const src = await decode(blob);
  const w0 = 'naturalWidth' in src ? src.naturalWidth : src.width, h0 = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const t = document.createElement('canvas'); t.width = 120; t.height = Math.max(1, Math.round(120 * h0 / w0));
  t.getContext('2d')!.drawImage(src, 0, 0, t.width, t.height);
  if ('close' in src) src.close();
  const b = await toBlob(t, 0.6);
  t.width = 0;
  return b;
}
/** バックアップ用に小さくする：グレースケールの JPEG（文字を読むには十分な画質） */
export async function shrinkForBackup(blob: Blob, quality = 0.7): Promise<Blob> {
  const src = await decode(blob);
  const w = 'naturalWidth' in src ? src.naturalWidth : src.width, h = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d')!;
  x.filter = 'grayscale(1)';
  x.drawImage(src, 0, 0);
  if ('close' in src) src.close();
  // filter が効かないブラウザ（古い Safari）では画素を直接グレーにする
  if (x.filter !== 'grayscale(1)') {
    const d = x.getImageData(0, 0, w, h); const p = d.data;
    for (let i = 0; i < p.length; i += 4) { const v = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000; p[i] = p[i + 1] = p[i + 2] = v; }
    x.putImageData(d, 0, 0);
  }
  const out = await toBlob(c, quality);
  c.width = 0;
  return out.size < blob.size ? out : blob;
}
