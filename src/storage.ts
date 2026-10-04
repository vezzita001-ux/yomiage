// 設定・読書位置（localStorage）と、最近のファイル・OCR結果（IndexedDB）の保存

import type { OcrMode } from './ocr';

export interface Settings {
  voiceURI: string | null;
  rate: number;
  pitch: number;
  fontSize: number;
  theme: 'auto' | 'light' | 'dark';
  ocrMode: OcrMode;
  showImage: boolean;
  wakeLock: boolean;
  engine: 'browser' | 'voicevox' | 'aivis';
  vvSpeaker: number;
  aivisSpeaker: number;
  intonation: number;
  volume: number;
  pause: number;
  gap: number;
  ocrEngine: 'server' | 'device';
  imgLarge: boolean;
  spread: 'auto' | 'on' | 'off';
  /** 挿絵のページ（文字が無い・ごく少ない画像ページ）で止まる秒数。0＝止まらない、-1＝タップするまで */
  illustWait: number;
}

export const DEFAULT_SETTINGS: Settings = {
  voiceURI: null,
  rate: 1,
  pitch: 1,
  fontSize: 21,
  theme: 'auto',
  ocrMode: 'auto',
  showImage: true,
  wakeLock: true,
  engine: 'browser',
  vvSpeaker: 3,
  aivisSpeaker: 497929760, // morioki（大人の女性の自然な声）
  intonation: 1,
  volume: 1,
  pause: 1,
  gap: 0,
  ocrEngine: 'server',
  imgLarge: false,
  spread: 'auto',
  illustWait: 5,
};

const SKEY = 'yomiage:settings';
const PKEY = 'yomiage:pos:';

export function loadSettings(): Settings {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s: Settings) {
  try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch { /* 容量不足など */ }
}

export interface Position { page: number; sentence: number; pageCount: number; updated: number }
export function loadPosition(id: string): Position | null {
  try { return JSON.parse(localStorage.getItem(PKEY + id) || 'null'); } catch { return null; }
}
export function savePosition(id: string, p: Position) {
  try { localStorage.setItem(PKEY + id, JSON.stringify(p)); } catch { /* 無視 */ }
}
export function clearPosition(id: string) { localStorage.removeItem(PKEY + id); }

// ---------- IndexedDB ----------
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const open = (v?: number) => {
        const r = v ? indexedDB.open('yomiage', v) : indexedDB.open('yomiage');
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages');
        };
        r.onsuccess = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('files') || !d.objectStoreNames.contains('pages')) { const nv = d.version + 1; d.close(); open(nv); return; }
          d.onversionchange = () => { d.close(); dbp = null; };
          res(d);
        };
        r.onerror = () => rej(r.error);
      };
      open();
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}
/** 1回の読み書き。書き込みは「トランザクションの完了（ディスクに書けた）」まで待つ
 *  （要求の成功だけで済ませると、空き容量が足りずに最後に取り消された時も成功に見えて、本棚に入らないのに何も出ない）。
 *  iPhone で長く裏に回したあとなどに IndexedDB とのつながりが切れていたら、開き直して1回だけやり直す */
function txOnce<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req.result);
    t.onabort = () => rej(t.error || req.error || new DOMException('保存できませんでした（空き容量が足りない可能性）', 'AbortError'));
  }));
}
const lostConnection = (e: unknown) => {
  const n = (e as DOMException)?.name || '', m = String((e as Error)?.message || '');
  return n === 'InvalidStateError' || /connection|closing|lost/i.test(m);
};
async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  try { return await txOnce(store, mode, fn); } catch (e) {
    if (!lostConnection(e)) throw e;
    console.warn('[IDB] connection lost → reopen', e);
    try { (await dbp)?.close(); } catch { /* 無視 */ }
    dbp = null;
    return txOnce(store, mode, fn);
  }
}

export interface RecentFile {
  id: string;
  name: string;
  files: { name: string; type: string; lastModified: number; blob: Blob }[];
  size: number;
  opened: number;
}

/** 本棚に入れる。入れられなかった時（空き容量が足りないなど）は例外にする（黙って入れないことはしない）。
 *  前は 40冊・合計1GB を超えると古い本を自動で消していたが、本棚の本は消さない（消すのは「削除」を押した時だけ） */
export async function saveRecent(id: string, name: string, files: File[]) {
  const size = files.reduce((a, f) => a + f.size, 0);
  const rec: RecentFile = {
    id, name, size, opened: Date.now(),
    files: files.map((f) => ({ name: f.name, type: f.type, lastModified: f.lastModified, blob: f })),
  };
  await tx('files', 'readwrite', (s) => s.put(rec));
}
export async function touchRecent(id: string) {
  const r = await tx<RecentFile | undefined>('files', 'readonly', (s) => s.get(id));
  if (r) { r.opened = Date.now(); await tx('files', 'readwrite', (s) => s.put(r)); }
}
/** 本棚の表示名だけ変える（開いた順は変えない） */
export async function renameRecent(id: string, name: string) {
  const r = await tx<RecentFile | undefined>('files', 'readonly', (s) => s.get(id));
  if (r) { r.name = name; await tx('files', 'readwrite', (s) => s.put(r)); }
}
export async function getRecentRecord(id: string): Promise<RecentFile | undefined> {
  return tx<RecentFile | undefined>('files', 'readonly', (s) => s.get(id));
}
/** 開いた日時（傷んだ記録でも並べられるように数にする） */
const openedOf = (r: RecentFile) => (Number.isFinite(Number(r?.opened)) ? Number(r.opened) : 0);
export async function listRecent(): Promise<RecentFile[]> {
  let all: RecentFile[];
  try { all = await tx<RecentFile[]>('files', 'readonly', (s) => s.getAll()); } catch (e) {
    // まとめて読めない時は1冊ずつ（読めない1冊のために本棚全体が出なくならないように）
    console.warn('[RECENT] getAll failed → one by one', e);
    const keys = await tx<IDBValidKey[]>('files', 'readonly', (s) => s.getAllKeys());
    all = [];
    for (const k of keys) { try { const r = await tx<RecentFile | undefined>('files', 'readonly', (s) => s.get(k)); if (r) all.push(r); } catch (e2) { console.warn('[RECENT] unreadable record', String(k), e2); } }
  }
  return all.filter((r) => r && typeof r === 'object' && r.id != null).map((r) => (Array.isArray(r.files) ? r : { ...r, files: [] })).sort((a, b) => openedOf(b) - openedOf(a));
}
export async function getRecent(id: string): Promise<File[] | null> {
  const r = await tx<RecentFile | undefined>('files', 'readonly', (s) => s.get(id));
  if (!r) return null;
  return (Array.isArray(r.files) ? r.files : []).filter((f) => f && f.blob).map((f) => new File([f.blob], f.name || '無題', { type: f.type || '', lastModified: f.lastModified || 0 }));
}
export async function deleteRecent(id: string) {
  await tx('files', 'readwrite', (s) => s.delete(id));
  const keys = await tx<IDBValidKey[]>('pages', 'readonly', (s) => s.getAllKeys());
  for (const k of keys) if (String(k).startsWith(id + '#')) await tx('pages', 'readwrite', (s) => s.delete(k));
  clearPosition(id);
}

export interface CachedPage {
  text: string; method: 'text' | 'ocr'; confidence?: number; orientation?: string;
  lines?: Array<{ text: string; box: [number, number, number, number]; vertical: boolean }>;
  ranges?: Array<[number, number]>; width?: number; height?: number; engine?: string; crop?: number[]; skip?: string; raw?: string;
}
export async function getCachedPage(key: string): Promise<CachedPage | undefined> {
  try { return await tx<CachedPage | undefined>('pages', 'readonly', (s) => s.get(key)); } catch { return undefined; }
}
export async function putCachedPage(key: string, v: CachedPage) {
  try { await tx('pages', 'readwrite', (s) => s.put(v, key)); } catch { /* 無視 */ }
}
export async function clearAll() {
  await tx('files', 'readwrite', (s) => s.clear());
  await tx('pages', 'readwrite', (s) => s.clear());
  Object.keys(localStorage).filter((k) => k.startsWith('yomiage:') && k !== 'yomiage:dict' && k !== 'yomiage:serverUrl' && k !== 'yomiage:fixall' && !k.startsWith('yomiage:fix:')).forEach((k) => localStorage.removeItem(k));
}

// ---------- バックアップ用 ----------
/** 本棚のレコードをそのまま置く（開いた日時なども保つ・一覧の整理はしない） */
export async function putRecentRecord(rec: RecentFile) { await tx('files', 'readwrite', (s) => s.put(rec)); }
export async function recentIds(): Promise<Set<string>> { return new Set((await tx<IDBValidKey[]>('files', 'readonly', (s) => s.getAllKeys())).map(String)); }
export async function pageKeys(): Promise<Set<string>> { return new Set((await tx<IDBValidKey[]>('pages', 'readonly', (s) => s.getAllKeys())).map(String)); }
/** OCR結果を少しずつ読む（全部を一度にメモリに載せない） */
export async function eachPages(batch: number, fn: (entries: Array<[string, CachedPage]>) => Promise<void>) {
  let after: string | null = null;
  for (;;) {
    const range: IDBKeyRange | undefined = after === null ? undefined : IDBKeyRange.lowerBound(after, true);
    const keys = (await tx<IDBValidKey[]>('pages', 'readonly', (s) => s.getAllKeys(range, batch))).map(String);
    if (!keys.length) return;
    const vals = await tx<CachedPage[]>('pages', 'readonly', (s) => s.getAll(range, batch));
    await fn(keys.map((k, i) => [k, vals[i]]));
    after = keys[keys.length - 1];
    if (keys.length < batch) return;
  }
}
export async function putPages(entries: Array<[string, CachedPage]>) {
  if (!entries.length) return;
  const d = await db();
  await new Promise<void>((res, rej) => {
    const t = d.transaction('pages', 'readwrite');
    const st = t.objectStore('pages');
    for (const [k, v] of entries) st.put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('保存できませんでした（空き容量が足りない可能性）'));
  });
}
export async function countPages(): Promise<number> { return tx<number>('pages', 'readonly', (s) => s.count()); }
export async function clearBooksAndPages() {
  await tx('files', 'readwrite', (s) => s.clear());
  await tx('pages', 'readwrite', (s) => s.clear());
}
