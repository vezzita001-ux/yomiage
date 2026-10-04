// バックアップ（1つまたは数個の .zip）と復元。
// ・zip は「無圧縮（store）」を自前で作る/読む。本の Blob はつなぐだけ、CRC は 4MB ずつ読んで計算 → 何百冊・何百枚でもメモリをほとんど使わない
// ・復元も zip 全体は読まず、File.slice で必要な部分だけ取り出す
// ・中身：manifest.json（形式・版）、local.json（localStorage の yomiage:*。辞書・文字の修正・すべての本の一括置換 yomiage:fixall も）、recents.json＋files/*.bin（本棚の本）、
//         pages-*.json（OCR結果）、shotbook.json＋shot/*.bin（作りかけのスクショ本）
// ・よみあげで作った画像の PDF（動画読み取り・スクショ本）は、ページの JPEG を同じ画素数のまま画質を下げて作り直して入れる（pdfshrink.ts）。
//   本の ID（読書位置・読み取り結果のキー）は元のまま recents.json に入るので、復元した本は続きから・読み取り済みのページはサーバー無しで読める
// ・中身がまったく同じファイル（大きさと CRC が同じ）は1つだけ入れる
import {
  listRecent, putRecentRecord, recentIds, pageKeys, eachPages, putPages, countPages, clearBooksAndPages,
  type RecentFile, type CachedPage, type Position,
} from './storage';
import { listItems as sbList, putMany as sbPutMany, clearItems as sbClear, makeThumb, loadMeta as sbLoadMeta, type ShotItem } from './shotbook';
import { GLOBAL_KEY as FIXALL_KEY, mergeGlobalRules } from './fixes';
import { shrinkPdf, estimateShrink, reencodeJpeg, SHRINK_Q, type ShrinkMode } from './pdfshrink';

export const BACKUP_FORMAT = 'yomiage-backup';
export const BACKUP_VERSION = 1;
const LS_PREFIX = 'yomiage:';
/** バックアップに入れない localStorage（この端末のバックアップの記録など） */
const LS_SKIP = /^yomiage:(backup:|serverUrl$)/; // サーバーURLはURLごとに違うので入れない・消さない
export const LAST_KEY = 'yomiage:backup:last';
const RESTORED_KEY = 'yomiage:backup:restored';

export interface Progress { (label: string, done: number, total: number): void }
export interface Manifest {
  format: string; version: number; id: string; created: number; build: string; origin: string;
  part: number; parts: number; books: boolean;
  counts: { books: number; bookBytes: number; pages: number; shots: number; localKeys: number };
  /** 画像を小さくしたか（無ければ元のまま） */
  shrink?: ShrinkMode;
}

// ---------------- CRC32 ----------------
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crcUpdate(crc: number, b: Uint8Array) { let c = crc ^ 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const CHUNK = 4 * 1024 * 1024;
async function crcBlob(b: Blob): Promise<number> {
  let crc = 0;
  for (let i = 0; i < b.size; i += CHUNK) crc = crcUpdate(crc, new Uint8Array(await b.slice(i, i + CHUNK).arrayBuffer()));
  return crc;
}

// ---------------- zip（無圧縮）を作る ----------------
const enc = new TextEncoder();
class ZipWriter {
  parts: BlobPart[] = [];
  cd: Uint8Array[] = [];
  offset = 0;
  count = 0;
  private dosTime: number; private dosDate: number;
  constructor() {
    const d = new Date();
    this.dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    this.dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  }
  async add(name: string, data: Blob | Uint8Array, knownCrc?: number) {
    const nb = enc.encode(name);
    const size = data instanceof Blob ? data.size : data.length;
    const crc = knownCrc ?? (data instanceof Blob ? await crcBlob(data) : crcUpdate(0, data));
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, this.dosTime, true); lh.setUint16(12, this.dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, this.dosTime, true); ch.setUint16(14, this.dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, nb.length, true); ch.setUint32(42, this.offset, true);
    const cdEntry = new Uint8Array(46 + nb.length); cdEntry.set(new Uint8Array(ch.buffer)); cdEntry.set(nb, 46);
    this.cd.push(cdEntry);
    // 小さいデータは Blob にしておく（メモリからディスク側へ移せるように）
    this.parts.push(new Uint8Array(lh.buffer), nb, data instanceof Blob ? data : new Blob([data as BlobPart]));
    this.offset += 30 + nb.length + size;
    this.count++;
  }
  finish(): Blob {
    let cdSize = 0; for (const c of this.cd) cdSize += c.length;
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.count, true); e.setUint16(10, this.count, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.cd, new Uint8Array(e.buffer)] as BlobPart[], { type: 'application/zip' });
  }
}

// ---------------- zip（無圧縮）を読む ----------------
export interface ZipEntry { name: string; blob: Blob }
export async function readZip(f: Blob): Promise<Map<string, Blob>> {
  const tailLen = Math.min(f.size, 65557);
  const tail = new DataView(await f.slice(f.size - tailLen).arrayBuffer());
  let eo = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eo = i; break; }
  if (eo < 0) throw new Error('バックアップのファイルではないか、壊れています（zip の終わりが見つかりません）');
  const count = tail.getUint16(eo + 10, true), cdSize = tail.getUint32(eo + 12, true), cdOff = tail.getUint32(eo + 16, true);
  const cd = new DataView(await f.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = new Map<string, Blob>();
  let p = 0;
  const pending: Array<{ name: string; off: number; size: number; method: number }> = [];
  for (let k = 0; k < count; k++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('バックアップの目次が壊れています');
    const method = cd.getUint16(p + 10, true), size = cd.getUint32(p + 20, true);
    const nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true), off = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
    pending.push({ name, off, size, method });
    p += 46 + nl + xl + cl;
  }
  for (const e of pending) {
    if (e.method !== 0) throw new Error(`圧縮されたzipには対応していません（${e.name}）。このアプリで作ったバックアップを選んでください`);
    const lh = new DataView(await f.slice(e.off, e.off + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('バックアップの中身が壊れています');
    const start = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    out.set(e.name, f.slice(start, start + e.size));
  }
  return out;
}

// ---------------- 大きさの見積もり ----------------
/** small/gray：画像を小さくした時の見積もり（小さくできない本は無し） */
export interface BookEntry { id: string; name: string; size: number; kind: string; small?: number; gray?: number }
export interface Estimate {
  books: BookEntry[]; bookBytes: number; shots: number; shotBytes: number;
  /** 作りかけのスクショ本の画像を小さくした時の見積もり */
  shotSmall: number; shotGray: number;
  /** 作りかけのスクショ本の画像が、本棚の本（作ったPDF）と同じものか（同じなら既定では入れない） */
  shotsBuiltOnShelf: string[];
  pages: number; pageBytes: number; localBytes: number;
}
export async function estimate(): Promise<Estimate> {
  let recents: RecentFile[] = []; try { recents = await listRecent(); } catch { /* 無し */ }
  let shots: ShotItem[] = []; try { shots = await sbList(); } catch { /* 無し */ }
  let pages = 0; try { pages = await countPages(); } catch { /* 無し */ }
  let localBytes = 0;
  for (const k of Object.keys(localStorage)) if (k.startsWith(LS_PREFIX) && !LS_SKIP.test(k)) localBytes += (k.length + (localStorage.getItem(k) || '').length) * 1.5;
  const books: BookEntry[] = [];
  for (const r of recents) {
    const b: BookEntry = { id: r.id, name: r.name, size: r.files.reduce((a, f) => a + (f.blob?.size || 0), 0), kind: r.id.split('|')[0] };
    // 画像の PDF は数ページだけ作り直して、小さくした時の大きさを見積もる
    let small = 0, gray = 0, any = false;
    for (let k = 0; k < r.files.length; k++) {
      const f = r.files[k];
      const e = isPdf(f) ? await estimateShrink(f.blob, `${r.id}#${k}#${f.blob.size}`).catch(() => null) : null;
      if (e) any = true;
      small += e ? e.small : f.blob.size; gray += e ? e.gray : f.blob.size;
    }
    if (any) { b.small = small; b.gray = gray; }
    books.push(b);
  }
  const built = Object.values(sbLoadMeta().builtParts || {});
  const shotsBuiltOnShelf = shots.length ? recents.filter((r) => built.includes(r.id)).map((r) => r.name) : [];
  const shotBytes = shots.reduce((a, s) => a + s.blob.size + 300 + (s.ocr ? 60 * (s.ocr.lines.length + 1) : 0), 0);
  // スクショ本も数枚だけ試して比べる
  let r0 = 0, rs = 0, rg = 0;
  for (const s of [shots[Math.floor(shots.length / 3)], shots[Math.floor(shots.length * 2 / 3)]].filter(Boolean)) {
    r0 += s.blob.size;
    rs += (await reencodeJpeg(s.blob, s.w, s.h, SHRINK_Q.small, false).catch(() => ({ blob: s.blob }))).blob.size;
    rg += (await reencodeJpeg(s.blob, s.w, s.h, SHRINK_Q.gray, true).catch(() => ({ blob: s.blob }))).blob.size;
  }
  return {
    books, bookBytes: books.reduce((a, b) => a + b.size, 0), shots: shots.length,
    shotBytes, shotSmall: r0 ? Math.round(shotBytes * rs / r0) : shotBytes, shotGray: r0 ? Math.round(shotBytes * rg / r0) : shotBytes,
    shotsBuiltOnShelf, pages, pageBytes: pages * 2500, localBytes,
  };
}

// ---------------- 作る ----------------
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const json = (v: unknown) => enc.encode(JSON.stringify(v));
const isPdf = (f: { name: string; type: string }) => /pdf/i.test(f.type || '') || /\.pdf$/i.test(f.name);

export interface BuildOptions {
  books: boolean;
  /** 入れる本（本棚の ID）。省略時は全部 */
  bookIds?: Set<string>;
  /** 作りかけのスクショ本の画像を入れる */
  shots?: boolean;
  /** 画像を小さくする（small＝画質を少し下げる／gray＝白黒にしてもう少し下げる）。本（よみあげで作った画像の PDF）と作りかけのスクショ本の両方 */
  shrink?: ShrinkMode;
  /** 古い呼び方（スクショ本だけ白黒）。shrink が無い時だけ使う */
  shotGray?: boolean;
  partBytes: number; build: string; onProgress?: Progress;
}
/** バックアップを作る。partBytes を超えそうなら本の途中で次のファイルに分ける */
export async function buildBackup(o: BuildOptions): Promise<File[]> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Date.now();
  const stamp = new Date(created);
  const ymd = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}`;
  const prog = o.onProgress || (() => {});
  const shrink: ShrinkMode = o.shrink ?? (o.shotGray ? 'gray' : 'none');
  const recents: RecentFile[] = o.books ? (await listRecent().catch(() => [] as RecentFile[])).filter((r) => !o.bookIds || o.bookIds.has(r.id)) : [];
  const shots: ShotItem[] = o.books && o.shots !== false ? await sbList().catch(() => []) : [];
  const totalWork = recents.reduce((a, r) => a + r.size, 0) + shots.reduce((a, s) => a + s.blob.size, 0) + 1;
  let done = 0;
  const zips: Array<{ w: ZipWriter; books: number; bookBytes: number; pages: number; shots: number; localKeys: number; same: Map<string, string> }> = [];
  const newZip = () => { const z = { w: new ZipWriter(), books: 0, bookBytes: 0, pages: 0, shots: 0, localKeys: 0, same: new Map<string, string>() }; zips.push(z); return z; };
  let z = newZip();
  // 1冊目：設定・辞書・読書位置など（localStorage）と OCR結果
  prog('設定・辞書・読書位置をまとめています', 0, totalWork);
  const local: Record<string, string> = {};
  for (const k of Object.keys(localStorage)) if (k.startsWith(LS_PREFIX) && !LS_SKIP.test(k)) local[k] = localStorage.getItem(k) || '';
  await z.w.add('local.json', json(local));
  z.localKeys = Object.keys(local).length;
  let pn = 0;
  await eachPages(400, async (entries) => { await z.w.add(`pages-${String(pn++).padStart(4, '0')}.json`, json(entries)); z.pages += entries.length; });
  // 本棚の本（recents.json は各ファイルに、そのファイルに入れた本の分だけ書く）
  let recs: unknown[] = [];
  let fileNo = 0;
  const flush = async () => { if (recs.length) { await z.w.add('recents.json', json(recs)); recs = []; } };
  for (const r of recents) {
    // 画像の PDF は小さく作り直す（ID・ファイル名はそのまま）
    const put: Array<{ f: RecentFile['files'][number]; blob: Blob; shrunk: boolean }> = [];
    for (const f of r.files) {
      let blob = f.blob, shrunk = false;
      if (shrink !== 'none' && isPdf(f)) {
        const base = done;
        prog(`本の画像を小さくしています：${r.name}`, done, totalWork);
        const s = await shrinkPdf(f.blob, shrink, undefined, (d, t) => { if (d % 5 === 0 || d === t) prog(`本の画像を小さくしています：${r.name}（${d} / ${t}ページ）`, base + f.blob.size * d / t * 0.9, totalWork); })
          .catch((e) => { console.warn('[BACKUP] shrink failed → original', r.name, e); return null; });
        if (s) { console.info(`[BACKUP] shrink ${r.name}: ${f.blob.size} → ${s.size} (${shrink})`); blob = s; shrunk = true; }
      }
      put.push({ f, blob, shrunk });
    }
    const need = put.reduce((a, x) => a + x.blob.size + 200, 0);
    if (z.w.offset > 4096 && z.w.offset + need > o.partBytes) { await flush(); z = newZip(); }
    const files = [];
    let size = 0;
    for (const { f, blob, shrunk } of put) {
      prog(`本をまとめています：${r.name}`, done, totalWork);
      const crc = await crcBlob(blob);
      const same = `${blob.size}:${crc}`;
      let path = z.same.get(same);
      if (!path) { // 同じ中身のファイルは1回だけ入れる
        path = `files/${String(fileNo++).padStart(6, '0')}.bin`;
        await z.w.add(path, blob, crc);
        z.same.set(same, path);
      }
      files.push({ name: f.name, type: f.type, lastModified: f.lastModified, path, size: blob.size, ...(shrunk ? { origSize: f.blob.size } : {}) });
      size += blob.size;
      done += f.blob.size;
    }
    recs.push({ id: r.id, name: r.name, size, opened: r.opened, files });
    z.books++; z.bookBytes += size;
  }
  await flush();
  // 作りかけのスクショ本
  let sitems: unknown[] = [];
  const flushShots = async () => { if (sitems.length) { await z.w.add('shotbook.json', json(sitems)); sitems = []; } };
  let sn = 0;
  for (const it of shots) {
    // サムネイルは入れない（復元の時に作り直す）。小さくする時は画質を下げる（白黒ならさらに）
    const img = shrink !== 'none' ? (await reencodeJpeg(it.blob, it.w, it.h, SHRINK_Q[shrink], shrink === 'gray').catch(() => ({ blob: it.blob }))).blob : it.blob;
    const need = img.size + 800;
    if (z.w.offset > 4096 && z.w.offset + need > o.partBytes) { await flushShots(); z = newZip(); }
    const bp = `shot/${String(sn).padStart(6, '0')}.jpg`; sn++;
    await z.w.add(bp, img);
    const { blob: _b, thumb: _t, sig, key: _k, ...rest } = it;
    sitems.push({ ...rest, blobPath: bp, blobType: img.type || 'image/jpeg', sig: b64(sig) });
    done += it.blob.size; z.shots++;
    if (sn % 20 === 0) prog(`スクショ本の画像をまとめています（${sn} / ${shots.length}）`, done, totalWork);
  }
  await flushShots();
  // 各ファイルに目次（manifest）を付けて完成
  prog('仕上げています', totalWork, totalWork);
  const out: File[] = [];
  for (let i = 0; i < zips.length; i++) {
    const zz = zips[i];
    const m: Manifest = {
      format: BACKUP_FORMAT, version: BACKUP_VERSION, id, created, build: o.build, origin: location.origin, part: i + 1, parts: zips.length, books: o.books,
      counts: { books: zz.books, bookBytes: zz.bookBytes, pages: zz.pages, shots: zz.shots, localKeys: zz.localKeys }, shrink,
    };
    await zz.w.add('manifest.json', json(m));
    const name = zips.length > 1 ? `yomiage-backup-${ymd}-${i + 1}of${zips.length}.zip` : `yomiage-backup-${ymd}.zip`;
    out.push(new File([zz.w.finish()], name, { type: 'application/zip', lastModified: created }));
  }
  return out;
}

// ---------------- 復元 ----------------
export interface RestoreResult { books: number; skippedBooks: number; pages: number; shots: number; localKeys: number; parts: number; manifest: Manifest }
export async function inspectBackup(f: File): Promise<{ manifest: Manifest; entries: Map<string, Blob> }> {
  const entries = await readZip(f);
  const mb = entries.get('manifest.json');
  if (!mb) throw new Error(`「${f.name}」はよみあげのバックアップではありません（manifest.json がありません）`);
  const manifest = JSON.parse(await mb.text()) as Manifest;
  if (manifest.format !== BACKUP_FORMAT) throw new Error(`「${f.name}」はよみあげのバックアップではありません`);
  if (manifest.version > BACKUP_VERSION) throw new Error(`このバックアップは新しい版（${manifest.version}）で作られています。アプリを最新にしてから復元してください`);
  return { manifest, entries };
}

/** 復元。mode: merge＝今のデータは残して足りないものを足す（読書位置は新しい方）／replace＝今のデータを消してバックアップと同じにする */
export async function restoreBackup(files: File[], mode: 'merge' | 'replace', onProgress?: Progress): Promise<RestoreResult> {
  const prog = onProgress || (() => {});
  const parts = [];
  for (const f of files) parts.push(await inspectBackup(f));
  parts.sort((a, b) => a.manifest.part - b.manifest.part);
  const res: RestoreResult = { books: 0, skippedBooks: 0, pages: 0, shots: 0, localKeys: 0, parts: parts.length, manifest: parts[0].manifest };
  // 置き換え：同じバックアップの続きのファイル（2of3 など）を後から復元する時は消さない
  if (mode === 'replace' && localStorage.getItem(RESTORED_KEY) !== parts[0].manifest.id) {
    prog('今のデータを消しています', 0, 1);
    await clearBooksAndPages();
    await sbClear();
    for (const k of Object.keys(localStorage)) if (k.startsWith(LS_PREFIX) && !LS_SKIP.test(k)) localStorage.removeItem(k);
  }
  const total = parts.reduce((a, p) => a + [...p.entries.values()].reduce((b, x) => b + x.size, 0), 0) + 1;
  let done = 0;
  const haveIds = await recentIds().catch(() => new Set<string>());
  const havePages = await pageKeys().catch(() => new Set<string>());
  let haveShots: Set<string> | null = null;
  for (const { manifest, entries } of parts) {
    // 設定・辞書・読書位置など
    const lj = entries.get('local.json');
    if (lj) {
      const local = JSON.parse(await lj.text()) as Record<string, string>;
      for (const [k, v] of Object.entries(local)) {
        if (!k.startsWith(LS_PREFIX) || LS_SKIP.test(k)) continue;
        const cur = localStorage.getItem(k);
        let val: string | null = v;
        if (mode === 'merge' && cur != null) {
          val = null;
          if (k.startsWith('yomiage:pos:')) { // 読書位置は新しい方
            try { if (((JSON.parse(v) as Position).updated || 0) > ((JSON.parse(cur) as Position).updated || 0)) val = v; } catch { /* そのまま */ }
          } else if (k === 'yomiage:dict') { // 辞書は足し合わせる（同じ読み替えは1つ）
            try {
              const a = JSON.parse(cur) as Array<{ id?: string; from: string; to: string }>, b = JSON.parse(v) as typeof a;
              const seen = new Set(a.map((e) => `${e.from}\u0000${e.to}`));
              const add = b.filter((e) => !seen.has(`${e.from}\u0000${e.to}`));
              if (add.length) val = JSON.stringify([...a, ...add]);
            } catch { /* そのまま */ }
          } else if (k === FIXALL_KEY) { // すべての本の一括置換も足し合わせる（同じ置き換えは1つ）
            val = mergeGlobalRules(cur, v);
          }
        }
        if (val != null) { try { localStorage.setItem(k, val); res.localKeys++; } catch (e) { console.warn('[BACKUP] localStorage full', k, e); } }
      }
    }
    // OCR結果
    const pnames = [...entries.keys()].filter((n) => /^pages-\d+\.json$/.test(n)).sort();
    for (const n of pnames) {
      const list = (JSON.parse(await entries.get(n)!.text()) as Array<[string, CachedPage]>).filter(([k]) => mode === 'replace' || !havePages.has(k));
      await putPages(list);
      res.pages += list.length;
      done += entries.get(n)!.size;
      prog('読み取り結果を戻しています', done, total);
    }
    // 本棚の本（同じ本＝同じファイル名と大きさ・同じID は重ねない）
    const rj = entries.get('recents.json');
    if (rj) {
      const recs = JSON.parse(await rj.text()) as Array<{ id: string; name: string; size: number; opened: number; files: Array<{ name: string; type: string; lastModified: number; path: string; size: number }> }>;
      for (const r of recs) {
        if (haveIds.has(r.id)) { res.skippedBooks++; for (const f of r.files) done += f.size; continue; }
        prog(`本を戻しています：${r.name}`, done, total);
        const files = r.files.map((f) => {
          const blob = entries.get(f.path);
          if (!blob || blob.size !== f.size) throw new Error(`バックアップの中の本が壊れています（${r.name}）`);
          done += f.size;
          return { name: f.name, type: f.type, lastModified: f.lastModified, blob: new Blob([blob], { type: f.type }) };
        });
        await putRecentRecord({ id: r.id, name: r.name, size: r.size, opened: r.opened, files });
        haveIds.add(r.id);
        res.books++;
      }
    }
    // 作りかけのスクショ本
    const sj = entries.get('shotbook.json');
    if (sj) {
      if (!haveShots) haveShots = new Set((await sbList().catch(() => [])).map((s) => `${s.name}\u0000${s.seq}`));
      const list = JSON.parse(await sj.text()) as Array<Omit<ShotItem, 'blob' | 'thumb' | 'sig'> & { blobPath: string; thumbPath?: string; blobType: string; sig: string }>;
      const items: ShotItem[] = [];
      for (const s of list) {
        const blob = entries.get(s.blobPath);
        if (!blob) continue;
        const sigKey = `${s.name}\u0000${s.seq}`;
        done += blob.size;
        if (haveShots.has(sigKey)) continue;
        const { blobPath: _bp, thumbPath, blobType, sig, ...rest } = s;
        const img = new Blob([blob], { type: blobType || 'image/jpeg' });
        const tb = thumbPath && entries.get(thumbPath);
        const thumb = tb ? new Blob([tb], { type: 'image/jpeg' }) : await makeThumb(img).catch(() => img);
        items.push({ ...rest, blob: img, thumb, sig: unb64(sig) });
        haveShots.add(sigKey);
        res.shots++;
        if (items.length >= 50) { await sbPutMany(items.splice(0)); prog(`スクショ本の画像を戻しています（${res.shots}枚）`, done, total); }
      }
      await sbPutMany(items);
    }
    void manifest;
  }
  localStorage.setItem(RESTORED_KEY, parts[0].manifest.id);
  prog('完了', total, total);
  return res;
}
