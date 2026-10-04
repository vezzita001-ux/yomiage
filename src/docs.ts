// ファイル（PDF・画像・ePub・テキスト）を「ページの集まり」として扱う
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import PdfWorker from './pdf-worker?worker';
import { loadEpub, EpubError, epubImageBlob, type EpubInfo } from './epub';
import { joinLayoutLines } from './split';
import { natural } from './shots';
import { parseEmbeddedOcr, OCR_KEY, type PageOcr } from './pdfwrite';

// ワーカーは補完入りの自前エントリを優先（失敗したら通常のワーカーファイル）
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
try {
  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
} catch (e) {
  console.warn('pdf worker (module) failed, fallback', e);
}
const BASE = import.meta.env.BASE_URL;

export type DocKind = 'pdf' | 'image' | 'epub' | 'txt';

export interface RawPage {
  /** テキスト（null の場合はOCRが必要） */
  text: string | null;
  /** OCR用・表示用の画像を作る関数 */
  image?: () => Promise<HTMLCanvasElement>;
  /** PDF に入っていた読み取り結果（よみあげで作った文字入りPDF） */
  ocr?: PageOcr;
}

export interface LoadedDoc {
  id: string;
  name: string;
  kind: DocKind;
  pageCount: number;
  unit: string; // 「ページ」「章」など
  hasImages: boolean;
  /** そのページに画像があるか（ePubの文字と画像の混在用。無ければ hasImages と同じ） */
  pageHasImage?(i: number): boolean;
  getRawPage(i: number): Promise<RawPage>;
  destroy?(): void;
  /** スクショ読み上げ（電子書籍アプリの画面のスクリーンショット）：ステータスバー・アプリの表示を除いて読む */
  screen?: boolean;
  /** 「巻No.GrPDF.書籍名.pdf」の書籍名と巻（切り取り設定は書籍名ごとに覚える） */
  book?: BookName | null;
  /** PDF の Info の Title・ePub の dc:title（「本のタイトルを使う」用） */
  metaTitle?: string;
}

export interface BookName { title: string; vol: string; volNum: number }
/** ファイル名「03.GrPDF.書籍名.pdf」から書籍名と巻を取り出す（Filesが付ける「 2」などの重複番号も許す） */
export function parseBookName(name: string): BookName | null {
  const m = /^(\d{1,4}(?:[.\-]\d{1,3})?)\.GrPDF\.(.+?)(?:\s\d{1,2})?\.pdf$/i.exec(name.normalize('NFC').trim());
  if (!m || !m[2].trim()) return null;
  // 「03-2」＝3巻の2つ目（分けた本）。3-10 が 3-1 と同じにならないように 3 + 2/1000 とする
  const [maj, part] = m[1].split('-');
  return { vol: m[1], volNum: part ? parseFloat(maj) + parseInt(part, 10) / 1000 : parseFloat(maj), title: m[2].trim() };
}
export function bookLabel(b: BookName) { return `${b.title}（${b.vol}巻）`; }

export function detectKind(f: File): DocKind | null {
  const n = f.name.toLowerCase();
  const t = (f.type || '').toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (t === 'application/epub+zip' || n.endsWith('.epub')) return 'epub';
  if (t.startsWith('text/') || /\.(txt|text|md)$/.test(n)) return 'txt';
  if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?)$/.test(n)) return 'image';
  return null;
}

export function docIdFor(files: File[], kind: DocKind): string {
  const names = files.map((f) => `${f.name}:${f.size}`).join('|');
  return `${kind}|${names}`;
}

/** ownWorker：今開いている本とは別の pdf.js ワーカーで開く（すべての本の一括置換の件数を数える時など。閉じても今の本に影響しない） */
export async function openFiles(files: File[], opt: { ownWorker?: boolean } = {}): Promise<LoadedDoc> {
  const kinds = files.map(detectKind);
  const images = files.filter((_, i) => kinds[i] === 'image');
  // 画像は名前の番号順（iPhone の写真・ファイルから選ぶと、読み込みが終わった順に並ぶことがあるため）。名前が全部同じなら選んだ順
  if (images.length > 0 && images.length === files.length) {
    const names = new Set(images.map((f) => f.name));
    return openImages(names.size === images.length ? [...images].sort((a, b) => natural.compare(a.name, b.name)) : images);
  }
  const idx = kinds.findIndex((k) => k && k !== 'image');
  if (idx < 0) throw new Error('対応していない種類のファイルです（PDF・画像・txt・ePubに対応）');
  const f = files[idx];
  const kind = kinds[idx]!;
  if (kind === 'pdf') return openPdf(f, !!opt.ownWorker);
  if (kind === 'epub') return openEpub(f);
  return openTxt(f);
}

// ---------------- PDF ----------------
// 前のPDFの後片付け（ワーカーの終了）が終わる前に次のPDFを開くと「worker is being destroyed」になるので待つ
let pdfDestroying: Promise<unknown> = Promise.resolve();
async function openPdf(f: File, ownWorker = false): Promise<LoadedDoc> {
  if (!ownWorker) await pdfDestroying;
  // 別のワーカー（共有のワーカーを壊さない）
  let ownPort: Worker | null = null, own: pdfjs.PDFWorker | null = null;
  if (ownWorker) {
    try { ownPort = new PdfWorker(); own = new pdfjs.PDFWorker({ port: ownPort as unknown as null }); } catch { ownPort = null; own = new pdfjs.PDFWorker(); }
  }
  const freeOwn = () => { try { own?.destroy(); } catch { /* 無視 */ } ownPort?.terminate(); };
  const t0 = performance.now();
  const data = new Uint8Array(await f.arrayBuffer());
  console.info(`[PDF] ${f.name} ${(data.length / 1048576).toFixed(1)}MB read in ${Math.round(performance.now() - t0)}ms`);
  // WebKit（iPhone）では OffscreenCanvas / ImageDecoder を使わない（古いiOSで未対応・不安定なため）
  const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Android/.test(navigator.userAgent);
  const task = pdfjs.getDocument({
    data,
    ...(own ? { worker: own } : {}),
    ...(isWebKit ? { isOffscreenCanvasSupported: false, isImageDecoderSupported: false } : {}),
    cMapUrl: `${BASE}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
    wasmUrl: `${BASE}pdfjs/wasm/`,
    iccUrl: `${BASE}pdfjs/iccs/`,
  });
  let pdf: pdfjs.PDFDocumentProxy;
  try { pdf = await task.promise; } catch (e) { if (own) { await task.destroy().catch(() => undefined); freeOwn(); } throw e; }
  console.info(`[PDF] opened: ${pdf.numPages} pages in ${Math.round(performance.now() - t0)}ms (webkit=${isWebKit})`);
  // スマホのスクリーンショットをまとめたPDFか（ファイル名が「NN.GrPDF.書籍名.pdf」、または1ページ目が縦長・横長のスマホ画面の比率で文字情報が無い）
  const book = parseBookName(f.name);
  let screen = !!book;
  if (!screen) {
    try {
      const p1 = await pdf.getPage(1);
      const vp = p1.getViewport({ scale: 1 });
      const ar = Math.max(vp.width, vp.height) / Math.min(vp.width, vp.height);
      if (ar >= 1.65) screen = (await extractPdfText(pdf, 0)).replace(/[\s\p{P}\p{S}]/gu, '').length < 5;
    } catch { /* 判定できなければ通常のPDF */ }
  }
  if (screen) console.info(`[PDF] phone screenshots → screen OCR mode${book ? ` (book: ${book.title} vol ${book.vol})` : ''}`);
  const render = async (i: number, targetLong: number) => {
    const page = await pdf.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = targetLong / Math.max(vp1.width, vp1.height);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const r0 = performance.now();
    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
    console.info(`[PDF] page ${i + 1} rendered ${canvas.width}x${canvas.height} in ${Math.round(performance.now() - r0)}ms`);
    page.cleanup();
    return canvas;
  };
  // 見開き（横長）のページは2ページ分なので高めの解像度で描く（iPhoneのキャンバス上限 約1670万画素より十分小さい）
  const renderPage = async (i: number) => {
    const page = await pdf.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const max = vp1.width > vp1.height * 1.2 ? 3200 : 2200;
    // スクショのPDF（1ページ1画像）は元の画像の解像度で描く（拡大すると文字の読み取りが少し不安定になる）
    if (screen) {
      try {
        const ops = await page.getOperatorList();
        const OPS = (pdfjs as unknown as { OPS: Record<string, number> }).OPS;
        let long = 0;
        ops.fnArray.forEach((fn, k) => {
          if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
            const a = ops.argsArray[k] as unknown[];
            const w = Number(a?.[1]) || 0, h = Number(a?.[2]) || 0;
            long = Math.max(long, w, h);
          }
        });
        if (long >= 900) return render(i, Math.min(max, long));
      } catch { /* 分からなければ通常どおり */ }
    }
    return render(i, max);
  };
  let metaTitle = '';
  let embedded: Array<PageOcr | null> | null = null;
  try {
    const md = await pdf.getMetadata();
    const info = md.info as Record<string, unknown> & { Custom?: Record<string, unknown> | Map<string, unknown> };
    metaTitle = String(info?.Title || '').trim();
    // よみあげで読み取った文字入りの PDF：中の文字（行と枠）をそのまま使い、OCR をしない
    const cu = info?.Custom; // pdf.js の版によって Map かオブジェクト
    embedded = parseEmbeddedOcr(cu instanceof Map ? cu.get(OCR_KEY) : cu?.[OCR_KEY]);
    if (embedded && embedded.length !== pdf.numPages) embedded = null;
    if (embedded) console.info(`[PDF] embedded OCR text found: ${embedded.filter(Boolean).length}/${pdf.numPages} pages → no OCR needed`);
  } catch { /* 無し */ }
  return {
    id: docIdFor([f], 'pdf'),
    metaTitle,
    name: book ? bookLabel(book) : f.name,
    kind: 'pdf',
    screen,
    book,
    pageCount: pdf.numPages,
    unit: 'ページ',
    hasImages: true,
    async getRawPage(i) {
      const eo = embedded?.[i];
      if (eo) return { text: null, ocr: eo, image: () => renderPage(i) };
      let s = '';
      try {
        s = await extractPdfText(pdf, i);
      } catch (e) {
        // 文字の取り出しに失敗しても OCR で読めるようにする
        console.warn(`[PDF] page ${i + 1} text extraction failed → OCR`, e);
        s = '';
      }
      // NFKC：PDFでよくある「⽂（部首）」→「文」などの互換文字を通常の文字に直す
      const text = joinLayoutLines(s.normalize('NFKC'));
      // 文字がほとんど無いページはスキャン画像とみなしOCRへ
      const meaningful = text.replace(/[\s\p{P}\p{S}]/gu, '').length;
      return { text: meaningful >= 5 ? text : null, image: () => renderPage(i) };
    },
    destroy() {
      if (own) { void task.destroy().catch(() => undefined).then(freeOwn); return; }
      pdfDestroying = task.destroy().catch(() => undefined);
    },
  };
}

/** ページの文字を取り出す。for await を使わず reader で読む（iOS Safari 対策） */
async function extractPdfText(pdf: pdfjs.PDFDocumentProxy, i: number): Promise<string> {
  const page = await pdf.getPage(i + 1);
  const stream = page.streamTextContent() as ReadableStream<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
  const reader = stream.getReader();
  let s = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const it of value?.items || []) {
        if (typeof it.str !== 'string') continue;
        s += it.str;
        if (it.hasEOL) s += '\n';
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 無視 */ }
  }
  return s;
}

// ---------------- 画像 ----------------
async function decodeImage(f: Blob, name = (f as File).name || '画像'): Promise<HTMLCanvasElement> {
  const toCanvas = (src: CanvasImageSource, w: number, h: number) => {
    // iPhone の Safari は1枚のキャンバスが約1670万画素を超えると真っ白になるため、長辺4096px・1600万画素までに縮小
    const k = Math.min(1, 4096 / Math.max(w, h), Math.sqrt(16_000_000 / (w * h)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    console.info(`[IMG] ${name} ${w}x${h} → ${c.width}x${c.height}`);
    return c;
  };
  const url = URL.createObjectURL(f);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return toCanvas(img, img.naturalWidth, img.naturalHeight);
  } catch {
    try {
      const bmp = await createImageBitmap(f);
      return toCanvas(bmp, bmp.width, bmp.height);
    } catch {
      throw new Error(`画像を読み込めませんでした（${name}）。このブラウザが対応していない形式の可能性があります（HEICの場合はJPEGで保存し直してください）`);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function openImages(files: File[]): Promise<LoadedDoc> {
  return {
    id: docIdFor(files, 'image'),
    name: files.length === 1 ? files[0].name : `${files[0].name} ほか${files.length - 1}枚`,
    kind: 'image',
    pageCount: files.length,
    unit: '枚目',
    hasImages: true,
    async getRawPage(i) {
      return { text: null, image: () => decodeImage(files[i]) };
    },
  };
}

/** スクショ読み上げ：画像を並べた順のまま1枚ずつ読む（並べ替えは shots.ts） */
export function openScreenshots(files: File[]): LoadedDoc {
  const t = new Date(files[0].lastModified || Date.now());
  const label = `スクショ ${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return {
    id: 'shot|' + docIdFor(files, 'image'),
    name: files.length === 1 ? label : `${label} ほか${files.length - 1}枚`,
    kind: 'image',
    pageCount: files.length,
    unit: '枚目',
    hasImages: true,
    screen: true,
    async getRawPage(i) {
      return { text: null, image: () => decodeImage(files[i]) };
    },
  };
}

// ---------------- テキスト ----------------
export function decodeText(buf: ArrayBuffer): { text: string; encoding: string } {
  const b = new Uint8Array(buf);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'UTF-8' };
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'UTF-16LE' };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'UTF-16BE' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'UTF-8' };
  } catch { /* UTF-8ではない */ }
  // Shift_JIS / EUC-JP を試し、文字化けの少ない方を採用
  const score = (t: string) => {
    const bad = (t.match(/\uFFFD/g) || []).length;
    const ja = (t.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
    const halfKana = (t.match(/[\uff61-\uff9f]/g) || []).length;
    return ja - bad * 10 - halfKana * 2;
  };
  const candidates: Array<{ text: string; encoding: string }> = [];
  for (const [label, name] of [['shift_jis', 'Shift_JIS'], ['euc-jp', 'EUC-JP']] as const) {
    try { candidates.push({ text: new TextDecoder(label).decode(b), encoding: name }); } catch { /* 非対応 */ }
  }
  if (!candidates.length) return { text: new TextDecoder('utf-8').decode(b), encoding: 'UTF-8（不明）' };
  candidates.sort((x, y) => score(y.text) - score(x.text));
  return candidates[0];
}

/** 長い文章を約2000文字ごとに段落の切れ目でページ分けする */
function paginate(text: string, size = 2000): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const pages: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur.length + line.length > size && cur.trim()) { pages.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) pages.push(cur);
  return pages.length ? pages : [''];
}

async function openTxt(f: File): Promise<LoadedDoc> {
  const { text } = decodeText(await f.arrayBuffer());
  const pages = paginate(text);
  return {
    id: docIdFor([f], 'txt'),
    name: f.name,
    kind: 'txt',
    pageCount: pages.length,
    unit: 'ページ',
    hasImages: false,
    async getRawPage(i) { return { text: pages[i] }; },
  };
}

// ---------------- ePub ----------------
async function openEpub(f: File): Promise<LoadedDoc> {
  let info: EpubInfo;
  try {
    info = await loadEpub(await f.arrayBuffer(), f.name);
  } catch (e) {
    // 構造の診断（本文は含まない）をログへ
    if (e instanceof EpubError) console.warn(`[EPUB] ${e.diag}`);
    throw e;
  }
  console.info(`[EPUB] ${info.diag}`);
  const { pages, zip } = info;
  return {
    id: docIdFor([f], 'epub'),
    metaTitle: info.metaTitle,
    name: info.title || f.name,
    kind: 'epub',
    pageCount: pages.length,
    unit: info.unit,
    hasImages: info.hasImages,
    pageHasImage: (i) => pages[i]?.kind === 'image',
    async getRawPage(i) {
      const p = pages[i];
      if (!p) return { text: '' };
      if (p.kind === 'text') return { text: p.text || '' };
      const path = p.image!;
      return { text: null, image: async () => decodeImage(await epubImageBlob(zip, path), path.split('/').pop() || path) };
    },
  };
}
