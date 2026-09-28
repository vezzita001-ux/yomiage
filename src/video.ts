// 画面収録（動画）から読む：動画をサーバーへ分割して送り、ページごとの静止画を取り出して GrPDF 形式の PDF にする
// （cloudflared の 100MB 制限があるので 32MB ずつ送る。途中で切れたら同じ動画を選び直すと続きから送る）
import { api } from './server';

export interface VideoPage { n: number; t: number; start: number; end: number; w?: number; h?: number }
export interface VideoStatus {
  id: string; name: string; state: 'uploading' | 'queued' | 'analyzing' | 'extracting' | 'done' | 'error';
  stage?: string; progress: number; size: number; received: number; duration?: number; codec?: string; interval?: number;
  width?: number; height?: number; pages: VideoPage[]; warnings: Array<{ t: number; msg: string }>; error?: string;
}
interface Saved { id: string; name: string; size: number; lastModified: number; at: number }
const LAST = 'yomiage:video:last';
const TITLE = 'yomiage:video:title';

export const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function json<T>(r: Response): Promise<T> {
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw Object.assign(new Error((j as { error?: string }).error || `HTTP ${r.status}`), { status: r.status, body: j });
  return j as T;
}

export function savedUpload(): Saved | null {
  try { const s = JSON.parse(localStorage.getItem(LAST) || 'null') as Saved | null; return s && Date.now() - s.at < 23 * 3600e3 ? s : null; } catch { return null; }
}

/** 動画を送る（同じ動画の送信が途中なら続きから）。戻り値は id */
export async function uploadVideo(file: File, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  let id = '', chunk = 32 * 1024 * 1024, off = 0;
  const prev = savedUpload();
  if (prev && prev.name === file.name && prev.size === file.size && prev.lastModified === file.lastModified) {
    try {
      const g = await json<{ received: number; size: number }>(await fetch(api(`/video/upload/${prev.id}`), { cache: 'no-store' }));
      id = prev.id; off = g.received;
      console.info(`[VIDEO] resume upload ${id} at ${off}/${file.size}`);
    } catch { /* 消えていたら最初から */ }
  }
  if (!id) {
    const s = await json<{ id: string; chunkSize: number }>(await fetch(api('/video/upload/start'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, size: file.size, type: file.type }),
    }));
    id = s.id; chunk = s.chunkSize || chunk;
    localStorage.setItem(LAST, JSON.stringify({ id, name: file.name, size: file.size, lastModified: file.lastModified, at: Date.now() } satisfies Saved));
  }
  onProgress(off, file.size);
  let fails = 0;
  while (off < file.size) {
    signal?.throwIfAborted();
    const end = Math.min(file.size, off + chunk);
    try {
      const r = await fetch(api(`/video/upload/${id}?offset=${off}`), { method: 'PUT', body: file.slice(off, end), headers: { 'Content-Type': 'application/octet-stream' }, signal });
      if (r.status === 409) { const j = await r.json(); if (typeof j.received === 'number') { off = j.received; if (off >= file.size) break; continue; } }
      const j = await json<{ received: number }>(r);
      off = j.received; fails = 0;
      onProgress(off, file.size);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (++fails > 5) throw new Error(`送信できませんでした（${(e as Error).message}）。電波の良い所で、同じ動画をもう一度選ぶと続きから送ります。`);
      console.warn(`[VIDEO] chunk at ${off} failed (${fails}/5)`, e);
      await sleep(1500 * fails);
      try { const g = await json<{ received: number }>(await fetch(api(`/video/upload/${id}`), { cache: 'no-store' })); off = g.received; } catch { /* 次で再挑戦 */ }
    }
  }
  return id;
}

export async function processVideo(id: string, onStatus: (s: VideoStatus) => void, signal?: AbortSignal): Promise<VideoStatus> {
  let s = await json<VideoStatus>(await fetch(api(`/video/process/${id}`), { method: 'POST' }));
  let errs = 0;
  for (;;) {
    onStatus(s);
    if (s.state === 'done') return s;
    if (s.state === 'error') throw new Error(s.error || '処理できませんでした');
    await sleep(1000);
    signal?.throwIfAborted();
    try { s = await json<VideoStatus>(await fetch(api(`/video/status/${id}`), { cache: 'no-store' })); errs = 0; } catch (e) { if (++errs > 20) throw e; }
  }
}

export const getStatus = async (id: string) => json<VideoStatus>(await fetch(api(`/video/status/${id}`), { cache: 'no-store' }));

export function pdfUrl(id: string, name: string, skip: number[], dl = false) {
  return api(`/video/pdf/${id}?name=${encodeURIComponent(name)}${skip.length ? `&skip=${skip.join(',')}` : ''}${dl ? '&dl=1' : ''}`);
}

export async function fetchPdf(id: string, name: string, skip: number[]): Promise<File> {
  const r = await fetch(pdfUrl(id, name, skip), { cache: 'no-store' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return new File([await r.blob()], name, { type: 'application/pdf', lastModified: Date.now() });
}

/** 巻No と書籍名から GrPDF のファイル名（「03.GrPDF.書籍名.pdf」） */
export function grpdfName(vol: string | number, title: string) {
  const n = Math.max(0, Math.floor(Number(vol) || 1));
  const t = (title.trim() || '無題').replace(/[\\/:*?"<>|\n\r]/g, '_');
  return `${String(n).padStart(2, '0')}.GrPDF.${t}.pdf`;
}
export function lastTitle(): { title: string; vol: number } {
  try { return JSON.parse(localStorage.getItem(TITLE) || 'null') || { title: '', vol: 0 }; } catch { return { title: '', vol: 0 }; }
}
export function rememberTitle(title: string, vol: number) { localStorage.setItem(TITLE, JSON.stringify({ title, vol })); }
