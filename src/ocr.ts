// tesseract.js による端末内OCR（日本語：横書き jpn / 縦書き jpn_vert）
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { joinLayoutLines, removeCjkSpaces } from './split';
import { api } from './server';

export type OcrMode = 'auto' | 'horizontal' | 'vertical';
export interface OcrProgress { label: string; progress: number }
export interface OcrResult { text: string; confidence: number; orientation: 'horizontal' | 'vertical' }

const BASE = import.meta.env.BASE_URL;
const STATUS_JA: Record<string, string> = {
  'loading tesseract core': 'OCRエンジンを読み込み中',
  'initializing tesseract': 'OCRエンジンを準備中',
  'initialized tesseract': 'OCRエンジンを準備中',
  'loading language traineddata': '日本語データを読み込み中（初回のみ約2MB）',
  'loaded language traineddata': '日本語データを読み込み中',
  'initializing api': 'OCRを準備中',
  'initialized api': 'OCRを準備中',
  'recognizing text': '文字を認識中',
};

let progressCb: ((p: OcrProgress) => void) | null = null;
let currentPrefix = '';
const workers = new Map<string, Promise<Worker>>();

function getWorker(lang: 'jpn' | 'jpn_vert'): Promise<Worker> {
  let w = workers.get(lang);
  if (!w) {
    w = createWorker(lang, 1, {
      workerPath: `${BASE}tesseract/worker.min.js`,
      corePath: `${BASE}tesseract/core/`,
      workerBlobURL: false,
      logger: (m: { status: string; progress: number }) => {
        progressCb?.({ label: currentPrefix + (STATUS_JA[m.status] || m.status), progress: m.progress || 0 });
      },
    });
    w.catch(() => workers.delete(lang));
    workers.set(lang, w);
  }
  return w;
}

// OCRは1件ずつ順番に実行する
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const p = queue.then(job, job);
  queue = p.catch(() => undefined);
  return p;
}

/** 画像をOCR向けに整える：小さい画像は拡大、大きすぎる画像は縮小、暗い背景は反転 */
export function prepareCanvas(src: CanvasImageSource & { width: number; height: number }): HTMLCanvasElement {
  const w0 = (src as HTMLImageElement).naturalWidth || src.width;
  const h0 = (src as HTMLImageElement).naturalHeight || src.height;
  const long = Math.max(w0, h0);
  let scale = 1;
  if (long < 1600) scale = Math.min(2, 1600 / long);
  if (long * scale > 3000) scale = 3000 / long;
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * scale);
  c.height = Math.round(h0 * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  // 平均輝度を調べ、ダークモードのスクリーンショットなら白黒反転
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let sum = 0;
  let n = 0;
  const step = Math.max(4, Math.floor(d.length / 4 / 20000)) * 4;
  for (let i = 0; i < d.length; i += step) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
  if (sum / n < 110) {
    for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

async function recognize(canvas: HTMLCanvasElement, orientation: 'horizontal' | 'vertical'): Promise<OcrResult> {
  const worker = await getWorker(orientation === 'vertical' ? 'jpn_vert' : 'jpn');
  await worker.setParameters({
    tessedit_pageseg_mode: orientation === 'vertical' ? PSM.SINGLE_BLOCK_VERT_TEXT : PSM.AUTO,
    preserve_interword_spaces: '1',
  });
  const { data } = await worker.recognize(canvas);
  const text = joinLayoutLines(removeCjkSpaces(data.text || ''));
  return { text, confidence: data.confidence ?? 0, orientation };
}

/** OCRを実行。auto の場合は横書きで試し、自信度が低ければ縦書きも試して良い方を採用 */
export function ocrCanvas(canvas: HTMLCanvasElement, mode: OcrMode, onProgress: (p: OcrProgress) => void): Promise<OcrResult> {
  return enqueue(async () => {
    progressCb = onProgress;
    try {
      if (mode === 'horizontal' || mode === 'vertical') {
        currentPrefix = mode === 'vertical' ? '縦書き：' : '横書き：';
        return await recognize(canvas, mode);
      }
      currentPrefix = '自動（横書きで確認）：';
      const h = await recognize(canvas, 'horizontal');
      if (h.confidence >= 75 && h.text.length > 0) return h;
      currentPrefix = '自動（縦書きで確認）：';
      const v = await recognize(canvas, 'vertical');
      return v.confidence > h.confidence ? v : h;
    } finally {
      progressCb = null;
      currentPrefix = '';
    }
  });
}

// ---------------- サーバーOCR（NDLOCR-Lite） ----------------
export interface OcrLine { text: string; box: [number, number, number, number]; vertical: boolean }
export interface ServerOcrResult { lines: OcrLine[]; width: number; height: number; vertical: boolean; ms: number; spread?: boolean; crop?: number[]; dropped?: Array<{ text: string; why: string }> }

/** ページ画像を配信元サーバーの NDLOCR-Lite に送り、読み順の行（文字と枠）を受け取る */
export type SpreadMode = 'auto' | 'on' | 'off';

/** screen に文字列（'' または '&top=0.05&bottom=0.1…'）を渡すと、スクショ読み上げ用（/shot/text：ステータスバー・読書アプリの表示を除く） */
export async function serverOcr(canvas: HTMLCanvasElement, onProgress: (p: OcrProgress) => void, split: SpreadMode = 'auto', screen: string | false = false): Promise<ServerOcrResult> {
  // 大きすぎる画像は縮小して送る（通信量とサーバー負荷を抑える）。見開きは2ページ分なので大きめ
  const MAX = canvas.width > canvas.height * 1.2 ? 3200 : 2400;
  let src = canvas;
  let scale = 1;
  const long = Math.max(canvas.width, canvas.height);
  if (long > MAX) {
    scale = MAX / long;
    src = document.createElement('canvas');
    src.width = Math.round(canvas.width * scale);
    src.height = Math.round(canvas.height * scale);
    src.getContext('2d')!.drawImage(canvas, 0, 0, src.width, src.height);
  }
  onProgress({ label: 'サーバーで文字を認識中（NDLOCR-Lite）', progress: 0.2 });
  const blob = await new Promise<Blob>((res, rej) => src.toBlob((b) => (b ? res(b) : rej(new Error('画像の変換に失敗しました'))), 'image/jpeg', 0.85));
  if (src !== canvas) { src.width = 0; src.height = 0; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  let r: Response;
  try {
    r = await fetch(api(screen !== false ? `/shot/text?keep=0&split=${split}${screen}` : `/ocr/page?split=${split}`), { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' }, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error(`OCRサーバーのエラー（${r.status}）`);
  const j = await r.json() as { lines: OcrLine[]; width: number; height: number; vertical: boolean; ms: number; spread?: boolean; crop?: number[]; dropped?: Array<{ text: string; why: string }> };
  const inv = 1 / scale;
  const lines = (j.lines || []).map((l) => ({
    text: removeCjkSpaces(l.text.normalize('NFKC')).trim().replace(/</g, '〈').replace(/>/g, '〉').replace(/\.{3}/g, '…'), vertical: l.vertical,
    box: l.box.map((v) => v * inv) as [number, number, number, number],
  }));
  onProgress({ label: 'サーバーで文字を認識中（NDLOCR-Lite）', progress: 1 });
  return { lines, width: canvas.width, height: canvas.height, vertical: j.vertical, ms: j.ms, spread: j.spread, crop: j.crop?.map((v) => v * inv), dropped: j.dropped };
}

/** 行をつなげて本文にする。各行が本文のどこに入ったか（範囲）も返す */
export function linesToText(lines: OcrLine[]): { text: string; ranges: Array<[number, number]> } {
  const TERM = '。．！？!?」』）)';
  const lens = lines.map((l) => Array.from(l.text).length).sort((a, b) => b - a);
  const typical = lens.length >= 3 ? lens[Math.floor(lens.length * 0.1)] : Infinity;
  let text = '';
  const ranges: Array<[number, number]> = [];
  for (const l of lines) {
    const t = l.text.trim();
    const start = text.length;
    text += t;
    ranges.push([start, text.length]);
    const last = t[t.length - 1] || '';
    if (TERM.includes(last) || Array.from(t).length < typical * 0.7) text += '\n';
  }
  return { text: text.trim(), ranges };
}

/** 見開き（横長で中央に空白の帯がある）なら、境目のx座標を返す。縦書きの本は右ページから読む */
export function findGutter(canvas: HTMLCanvasElement, mode: SpreadMode): number | null {
  const { width: w, height: h } = canvas;
  if (mode === 'off') return null;
  if (mode === 'auto' && w / h < 1.2) return null;
  const sw = Math.min(800, w);
  const k = sw / w;
  const sh = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, sw, sh);
  const y0 = Math.round(sh * 0.12), y1 = Math.round(sh * 0.9);
  const d = ctx.getImageData(0, y0, sw, y1 - y0).data;
  c.width = 0; c.height = 0;
  const ink = new Float32Array(sw);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 < 150) ink[(i / 4) % sw]++;
  }
  const win = Math.max(5, Math.round(sw / 60));
  const sm = new Float32Array(sw);
  for (let x = 0; x < sw; x++) {
    let s = 0, n = 0;
    for (let j = x - (win >> 1); j <= x + (win >> 1); j++) if (j >= 0 && j < sw) { s += ink[j]; n++; }
    sm[x] = s / n;
  }
  const lo = Math.round(sw * 0.3), hi = Math.round(sw * 0.7);
  const limit = (y1 - y0) * 0.003;
  let best: [number, number] | null = null;
  let start = -1;
  for (let x = lo; x <= hi; x++) {
    const low = x < hi && sm[x] <= limit;
    if (low && start < 0) start = x;
    if (!low && start >= 0) { if (!best || x - start > best[1] - best[0]) best = [start, x]; start = -1; }
  }
  if (best && best[1] - best[0] >= sw * 0.012) return Math.round(((best[0] + best[1]) / 2) / k);
  if (mode === 'on') return Math.round(w / 2);
  return null;
}

/** 見開きを右ページ・左ページの2枚に分ける */
export function splitSpread(canvas: HTMLCanvasElement, mode: SpreadMode): HTMLCanvasElement[] {
  const g = findGutter(canvas, mode);
  if (g === null) return [canvas];
  const part = (x0: number, x1: number) => {
    const c = document.createElement('canvas');
    c.width = x1 - x0; c.height = canvas.height;
    c.getContext('2d')!.drawImage(canvas, x0, 0, x1 - x0, canvas.height, 0, 0, x1 - x0, canvas.height);
    return c;
  };
  return [part(g, canvas.width), part(0, g)];
}
