// 画像（JPEG）を1ページずつ入れた PDF を作る。読み取った文字（OCR）があれば：
// ・見えない文字の層（描画モード3）を行の位置に入れる → 他のアプリでも検索・コピー・読み上げができる（pdftotext でも取り出せる）
// ・文書情報（Info）の /YomiageOCR に行と枠をそのまま入れる → よみあげで開き直すと OCR をせずにそのまま読める（行の強調表示も同じ）
// 画像の Blob はつなぐだけ（メモリをほとんど使わない）
import type { OcrLine } from './ocr';

export interface PageOcr { lines: OcrLine[]; width: number; height: number; skip?: string; raw?: string }
export interface PdfPage { blob: Blob; w: number; h: number; ocr?: PageOcr | null; /** JPEG の色（省略時 DeviceRGB。白黒1色の JPEG をそのまま入れる時は DeviceGray） */ cs?: 'DeviceRGB' | 'DeviceGray' | 'DeviceCMYK' }
export const OCR_KEY = 'YomiageOCR';
export const OCR_VERSION = 1;

const enc = new TextEncoder();
const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();
/** UTF-16BE の16進（UniJIS-UTF16-H / -V の文字コード） */
function utf16hex(s: string): string { let h = ''; for (let i = 0; i < s.length; i++) h += hex4(s.charCodeAt(i)); return h; }
function pdfTextString(s: string): string { let h = 'FEFF'; for (let i = 0; i < s.length; i++) h += hex4(s.charCodeAt(i)); return `<${h}>`; }
/** ASCII だけの JSON（日本語は \uXXXX）を PDF の文字列 ( … ) に */
function asciiJsonLiteral(v: unknown): string {
  const j = JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `(${j.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}
// 文字コード（UTF-16）→ Unicode の対応表（同じ値）。最初のバイトごとに範囲を分ける
const TOUNICODE = (() => {
  const rows: string[] = [];
  for (let hi = 0; hi < 256; hi++) { if (hi >= 0xd8 && hi <= 0xdf) continue; const b = hi.toString(16).padStart(2, '0').toUpperCase(); rows.push(`<${b}00> <${b}FF> <${b}00>`); }
  const chunks: string[] = [];
  for (let i = 0; i < rows.length; i += 100) chunks.push(`${Math.min(100, rows.length - i)} beginbfrange\n${rows.slice(i, i + 100).join('\n')}\nendbfrange`);
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
})();

function textLayer(p: PdfPage, W: number, H: number): string {
  const o = p.ocr;
  if (!o || !o.lines.length || o.skip) return '';
  const sx = W / o.width, sy = H / o.height;
  const out: string[] = ['BT 3 Tr'];
  for (const l of o.lines) {
    const t = l.text.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const n = Math.max(1, t.length);
    const [x, y, w, h] = l.box;
    const bx = x * sx, bw = Math.max(1, w * sx), bh = Math.max(1, h * sy);
    const top = H - y * sy;
    if (l.vertical) {
      // 縦書き：上から下へ。文字の大きさ＝枠の幅、送り＝枠の高さ / 文字数
      out.push(`/F2 1 Tf ${bw.toFixed(2)} 0 0 ${(bh / n).toFixed(2)} ${(bx + bw / 2).toFixed(2)} ${top.toFixed(2)} Tm <${utf16hex(t)}> Tj`);
    } else {
      out.push(`/F1 1 Tf ${(bw / n).toFixed(2)} 0 0 ${bh.toFixed(2)} ${bx.toFixed(2)} ${(top - bh * 0.88).toFixed(2)} Tm <${utf16hex(t)}> Tj`);
    }
  }
  out.push('ET');
  return out.length > 2 ? `\n${out.join('\n')}` : '';
}

export function makePdf(pages: PdfPage[], title: string): Blob {
  const parts: BlobPart[] = []; const offs: number[] = []; let len = 0;
  const put = (x: string | Blob) => { if (typeof x === 'string') { const b = enc.encode(x); parts.push(b); len += b.length; } else { parts.push(x); len += x.size; } };
  const obj = (n: number, body: () => void) => { offs[n] = len; put(`${n} 0 obj\n`); body(); put('\nendobj\n'); };
  put('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
  const n = pages.length;
  const hasText = pages.some((p) => p.ocr && p.ocr.lines.length && !p.ocr.skip);
  // 1 カタログ 2 ページ一覧 3 情報 4〜7 フォント 8〜 ページ
  const FIRST = 8;
  const pageNo = (i: number) => FIRST + i * 3;
  obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => put(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageNo(i)} 0 R`).join(' ')}] >>`));
  const ocrData = pages.some((p) => p.ocr) ? {
    v: OCR_VERSION,
    pages: pages.map((p) => p.ocr ? { w: p.ocr.width, h: p.ocr.height, skip: p.ocr.skip || undefined, raw: p.ocr.skip ? p.ocr.raw : undefined, l: p.ocr.lines.map((l) => [l.text, l.box.map((v) => Math.round(v * 10) / 10), l.vertical ? 1 : 0]) } : null),
  } : null;
  obj(3, () => put(`<< /Title ${pdfTextString(title)} /Producer (yomiage)${hasText ? ' /Keywords (yomiage-ocr)' : ''}${ocrData ? ` /${OCR_KEY} ${asciiJsonLiteral(ocrData)}` : ''} >>`));
  // フォント（埋め込まない日本語フォント＋ToUnicode。描画モード3で見えないので形は使わない）
  const cid = '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor << /Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 6 /FontBBox [-123 -257 1001 910] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >> /DW 1000 >>';
  obj(4, () => put(`<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UTF16-H /DescendantFonts [${cid}] /ToUnicode 6 0 R >>`));
  obj(5, () => put(`<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UTF16-V /DescendantFonts [${cid}] /ToUnicode 6 0 R >>`));
  obj(6, () => put(`<< /Length ${enc.encode(TOUNICODE).length} >>\nstream\n${TOUNICODE}\nendstream`));
  obj(7, () => put('null'));
  pages.forEach((p, i) => {
    const W = +(p.w / 2).toFixed(2), H = +(p.h / 2).toFixed(2);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q${textLayer(p, W, H)}`;
    const cl = enc.encode(content).length;
    obj(pageNo(i), () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${pageNo(i) + 2} 0 R >> /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents ${pageNo(i) + 1} 0 R >>`));
    obj(pageNo(i) + 1, () => put(`<< /Length ${cl} >>\nstream\n${content}\nendstream`));
    obj(pageNo(i) + 2, () => { put(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /${p.cs || 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.blob.size} >>\nstream\n`); put(p.blob); put('\nendstream'); });
  });
  const total = FIRST + n * 3;
  const xref = len;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) x += `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  put(x);
  put(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/** /YomiageOCR（Info）を読み取る → ページごとの行 */
export function parseEmbeddedOcr(v: unknown): Array<PageOcr | null> | null {
  if (typeof v !== 'string' || !v.startsWith('{')) return null;
  try {
    const j = JSON.parse(v) as { v: number; pages: Array<{ w: number; h: number; skip?: string; raw?: string; l: Array<[string, number[], number]> } | null> };
    if (!j || j.v > OCR_VERSION || !Array.isArray(j.pages)) return null;
    return j.pages.map((p) => p ? { width: p.w, height: p.h, skip: p.skip, raw: p.raw, lines: p.l.map(([text, box, vt]) => ({ text, box: box as [number, number, number, number], vertical: !!vt })) } : null);
  } catch { return null; }
}
