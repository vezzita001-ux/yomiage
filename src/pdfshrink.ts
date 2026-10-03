// バックアップ用：よみあげが作った「1ページ1枚の JPEG」の PDF（動画読み取り・スクショ本・文字入りPDF）を小さく作り直す
// ・PDF の目次（xref）から各ページの JPEG の場所を読むだけ（全体をメモリに読まない）
// ・JPEG を同じ大きさ（画素数）のまま画質を下げて入れ直す → 読み取り結果の位置・切り取り設定はそのまま使える
// ・PDF に入っていた読み取り結果（/YomiageOCR）は引き継ぐ
// 形が違う PDF（ほかのアプリで作った PDF など）は null を返す＝そのまま入れる
import { makePdf, parseEmbeddedOcr, type PdfPage, type PageOcr } from './pdfwrite';

export type ShrinkMode = 'none' | 'small' | 'gray';
/** JPEG の画質（small＝カラーのまま少し下げる／gray＝白黒にしてもう少し下げる） */
export const SHRINK_Q = { small: 0.6, gray: 0.5 } as const;
/** これより小さくならないページは元の JPEG のまま */
const KEEP_RATIO = 0.92;

interface ImgRef { blob: Blob; w: number; h: number; cs: NonNullable<PdfPage['cs']> }
export interface ImagePdf { title: string; pages: ImgRef[]; ocr: Array<PageOcr | null> | null; imageBytes: number }

const latin1 = new TextDecoder('latin1');
const txt = async (b: Blob, a: number, z: number) => latin1.decode(await b.slice(a, z).arrayBuffer());
const fail = () => { throw new Error('not an image PDF'); };

function decodeTitle(info: string): string {
  const h = /\/Title <([0-9A-Fa-f\s]*)>/.exec(info);
  if (h) {
    const x = h[1].replace(/\s/g, '');
    let s = '';
    const st = /^feff/i.test(x) ? 4 : 0;
    for (let i = st; i + 4 <= x.length; i += 4) s += String.fromCharCode(parseInt(x.slice(i, i + 4), 16));
    return s;
  }
  const l = /\/Title \(((?:\\.|[^\\)])*)\)/.exec(info);
  return l ? l[1].replace(/\\(.)/g, '$1') : '';
}

const cache = new Map<string, ImagePdf | null>();
/** よみあげ形式の画像 PDF なら各ページの JPEG（元の PDF の一部分）を返す。違えば null */
export async function parseImagePdf(b: Blob, key?: string): Promise<ImagePdf | null> {
  if (key && cache.has(key)) return cache.get(key)!;
  let r: ImagePdf | null = null;
  try { r = await parse(b); } catch { r = null; }
  if (key) cache.set(key, r);
  return r;
}
async function parse(b: Blob): Promise<ImagePdf | null> {
  if (b.size < 64) return null;
  if (!(await txt(b, 0, 8)).startsWith('%PDF-')) return null;
  const tail = await txt(b, Math.max(0, b.size - 1024), b.size);
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!sx) return null;
  const xo = +sx[1];
  if (!(xo > 0 && xo < b.size)) return null;
  const xr = await txt(b, xo, b.size);
  const m = /^xref\s+0\s+(\d+)[ \t]*\r?\n/.exec(xr);
  if (!m) return null;
  const n = +m[1];
  const offs: number[] = [];
  for (let k = 0; k < n; k++) {
    const em = /^(\d{10}) (\d{5}) ([nf])/.exec(xr.substr(m[0].length + k * 20, 20));
    if (!em) return null;
    offs[k] = em[3] === 'n' ? +em[1] : -1;
  }
  const tr = xr.slice(m[0].length + n * 20);
  const root = /\/Root (\d+) 0 R/.exec(tr), info = /\/Info (\d+) 0 R/.exec(tr);
  if (!/^\s*trailer/.test(tr) || !root || !info || /\/Encrypt|\/Prev/.test(tr)) return null;
  const sorted = [...offs.filter((o) => o > 0), xo].sort((a, c) => a - c);
  const endOf = (o: number) => { let lo = 0, hi = sorted.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] > o) hi = mid; else lo = mid + 1; } return sorted[lo] > o ? sorted[lo] : b.size; };
  const obj = async (k: number, max = Infinity) => {
    const o = offs[k];
    if (!(o > 0)) fail();
    const s = await txt(b, o, Math.min(endOf(o), o + max));
    if (!s.startsWith(`${k} 0 obj`)) fail();
    return s;
  };
  const inf = await obj(+info[1]);
  if (!/\/Producer \(yomiage\)/.test(inf)) return null;
  const cat = await obj(+root[1], 4096);
  const pg = /\/Pages (\d+) 0 R/.exec(cat);
  if (!pg) return null;
  const pagesObj = await obj(+pg[1]);
  const kids = /\/Kids \[([^\]]*)\]/.exec(pagesObj), count = /\/Count (\d+)/.exec(pagesObj);
  if (!kids || !count) return null;
  const ids = [...kids[1].matchAll(/(\d+) 0 R/g)].map((x) => +x[1]);
  if (!ids.length || +count[1] !== ids.length) return null;
  let ocr: Array<PageOcr | null> | null = null;
  const oi = inf.indexOf('/YomiageOCR (');
  if (oi >= 0) {
    let out = '';
    for (let i = oi + 13; i < inf.length; i++) { const c = inf[i]; if (c === '\\') { out += inf[++i]; continue; } if (c === ')') break; out += c; }
    ocr = parseEmbeddedOcr(out);
    if (!ocr || ocr.length !== ids.length) return null;
  }
  const pages: ImgRef[] = [];
  let imageBytes = 0;
  for (const id of ids) {
    const po = await obj(id, 4096);
    const mb = /\/MediaBox \[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(po);
    const xi = /\/XObject << \/Im0 (\d+) 0 R >>/.exec(po);
    const co = /\/Contents (\d+) 0 R/.exec(po);
    if (!mb || !xi || !co || /\/Annots|\/Rotate/.test(po)) return null;
    const cs = await obj(+co[1], 1 << 20);
    const cm = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(cs);
    if (!cm) return null;
    const IMG = /^q [\d.]+ 0 0 [\d.]+ 0 0 cm \/Im0 Do Q/;
    const content = cm[1].trim();
    if (!IMG.test(content)) return null;
    if (content.replace(IMG, '').trim() && !ocr) return null; // 文字の層があるのに読み取り結果が無い → 作り直すと文字が消えるのでそのまま
    const io = offs[+xi[1]];
    const ih = await obj(+xi[1], 2048);
    const si = ih.indexOf('stream');
    if (si < 0) return null;
    const dict = ih.slice(0, si);
    const w = /\/Width (\d+)/.exec(dict), h = /\/Height (\d+)/.exec(dict), len = /\/Length (\d+)\s*(?:\/|>>)/.exec(dict);
    const col = /\/ColorSpace \/(DeviceRGB|DeviceGray|DeviceCMYK)/.exec(dict);
    if (!/\/Subtype \/Image/.test(dict) || !/\/Filter \/DCTDecode/.test(dict) || !/\/BitsPerComponent 8/.test(dict) || /\/SMask|\/Mask|\/Decode/.test(dict) || !w || !h || !len || !col) return null;
    if (Math.abs(+mb[1] - +w[1] / 2) > 1 || Math.abs(+mb[2] - +h[1] / 2) > 1) return null; // makePdf と同じページの大きさ
    const start = io + si + 6 + (ih[si + 6] === '\r' ? 2 : 1);
    const L = +len[1];
    if (start + L > endOf(io)) return null;
    pages.push({ blob: b.slice(start, start + L, 'image/jpeg'), w: +w[1], h: +h[1], cs: col[1] as ImgRef['cs'] });
    imageBytes += L;
  }
  return { title: decodeTitle(inf), pages, ocr, imageBytes };
}

async function decode(f: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try { return await createImageBitmap(f); } catch { /* 古い Safari などは img で */ }
  const url = URL.createObjectURL(f);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
let cv: HTMLCanvasElement | null = null;
/** JPEG を同じ画素数のまま入れ直す（gray＝白黒）。小さくならなければ元のまま */
export async function reencodeJpeg(src: Blob, w: number, h: number, q: number, gray: boolean): Promise<{ blob: Blob; changed: boolean }> {
  const bm = await decode(src);
  try {
    if (!cv) cv = document.createElement('canvas');
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const x = cv.getContext('2d', { willReadFrequently: gray })!;
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    x.drawImage(bm, 0, 0, w, h);
    if (gray) {
      const d = x.getImageData(0, 0, w, h); const p = d.data;
      for (let i = 0; i < p.length; i += 4) { const v = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000; p[i] = p[i + 1] = p[i + 2] = v; }
      x.putImageData(d, 0, 0);
    }
    const out = await new Promise<Blob>((res, rej) => cv!.toBlob((bb) => (bb ? res(bb) : rej(new Error('画像の変換に失敗しました'))), 'image/jpeg', q));
    return out.size < src.size * KEEP_RATIO ? { blob: out, changed: true } : { blob: src, changed: false };
  } finally { if ('close' in bm) bm.close(); }
}
/** PDF を小さく作り直す。小さくならない・形が違う時は null */
export async function shrinkPdf(b: Blob, mode: Exclude<ShrinkMode, 'none'>, key?: string, onPage?: (done: number, total: number) => void): Promise<Blob | null> {
  const p = await parseImagePdf(b, key);
  if (!p) return null;
  const out: PdfPage[] = [];
  for (let i = 0; i < p.pages.length; i++) {
    const pg = p.pages[i];
    let blob = pg.blob, cs = pg.cs;
    try { const r = await reencodeJpeg(pg.blob, pg.w, pg.h, SHRINK_Q[mode], mode === 'gray'); if (r.changed) { blob = r.blob; cs = 'DeviceRGB'; } } catch (e) { console.warn('[SHRINK] page', i + 1, e); }
    out.push({ blob, w: pg.w, h: pg.h, cs, ocr: p.ocr?.[i] ?? null });
    onPage?.(i + 1, p.pages.length);
  }
  const pdf = makePdf(out, p.title);
  return pdf.size < b.size * 0.95 ? pdf : null;
}

/** 小さくした時の大きさの見積もり（数ページだけ作り直して比べる）。小さくできない PDF は null */
export async function estimateShrink(b: Blob, key?: string): Promise<{ small: number; gray: number } | null> {
  const p = await parseImagePdf(b, key);
  if (!p || !p.imageBytes) return null;
  const n = p.pages.length;
  const pick = [...new Set([Math.floor(n / 4), Math.floor(n / 2), Math.floor(n * 3 / 4)])];
  let orig = 0, small = 0, gray = 0;
  for (const i of pick) {
    const pg = p.pages[i];
    orig += pg.blob.size;
    small += (await reencodeJpeg(pg.blob, pg.w, pg.h, SHRINK_Q.small, false).catch(() => ({ blob: pg.blob }))).blob.size;
    gray += (await reencodeJpeg(pg.blob, pg.w, pg.h, SHRINK_Q.gray, true).catch(() => ({ blob: pg.blob }))).blob.size;
  }
  const rest = b.size - p.imageBytes;
  const est = (x: number) => Math.min(b.size, Math.round(rest + p.imageBytes * (x / orig)));
  return { small: est(small), gray: est(gray) };
}
