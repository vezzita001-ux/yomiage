// スクショ読み上げ：選んだスクリーンショットを撮影した順に並べる
// 撮影日時は EXIF（JPEG の APP1 / PNG の eXIf）か XMP から読み、無ければファイルの更新日時、それも同じなら名前の番号順。

function parseTiffDate(v: DataView, start: number): number | null {
  try {
    const le = v.getUint16(start) === 0x4949;
    const u16 = (o: number) => v.getUint16(start + o, le);
    const u32 = (o: number) => v.getUint32(start + o, le);
    const ascii = (o: number, n: number) => { let s = ''; for (let i = 0; i < n; i++) { const c = v.getUint8(start + o + i); if (!c) break; s += String.fromCharCode(c); } return s; };
    const readIfd = (off: number): Map<number, number> => {
      const m = new Map<number, number>();
      const n = u16(off);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        // ASCII（type 2）は4バイトを超えると値の位置、ポインタ（LONG）はそのまま
        m.set(tag, type === 2 && count <= 4 ? e + 8 : u32(e + 8));
        if (type === 2) m.set(tag + 0x10000, count);
      }
      return m;
    };
    const ifd0 = readIfd(u32(4));
    const exifPtr = ifd0.get(0x8769);
    const pick = (m: Map<number, number>, tag: number) => (m.has(tag) ? ascii(m.get(tag)!, m.get(tag + 0x10000) || 20) : '');
    let s = '';
    if (exifPtr) { const ex = readIfd(exifPtr); s = pick(ex, 0x9003) || pick(ex, 0x9004); }
    if (!s) s = pick(ifd0, 0x0132);
    return exifDateToMs(s);
  } catch { return null; }
}

function exifDateToMs(s: string): number | null {
  const m = /^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s.trim());
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

function xmpDate(text: string): number | null {
  const m = /(?:photoshop:DateCreated|xmp:CreateDate|exif:DateTimeOriginal)(?:>|=")([^<"]+)/.exec(text);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : exifDateToMs(m[1]);
}

export type TimeSource = 'exif' | 'xmp' | 'png';
/** 画像ファイルの撮影日時（ミリ秒）。分からなければ null */
export async function captureTime(f: Blob): Promise<number | null> {
  return (await captureInfo(f))?.t ?? null;
}
/** 撮影日時と、その情報の元（EXIF / XMP / PNG のテキスト） */
export async function captureInfo(f: Blob): Promise<{ t: number; src: TimeSource } | null> {
  const buf = await f.slice(0, 512 * 1024).arrayBuffer();
  const v = new DataView(buf);
  const b = new Uint8Array(buf);
  if (b.length < 16) return null;
  const latin = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 4 < b.length && b[p] === 0xff) {
      const marker = b[p + 1];
      const len = v.getUint16(p + 2);
      if (marker === 0xe1 && latin(p + 4, 6) === 'Exif\0\0') {
        const t = parseTiffDate(v, p + 10);
        if (t) return { t, src: 'exif' };
      } else if (marker === 0xe1 && latin(p + 4, 28) === 'http://ns.adobe.com/xap/1.0/') {
        const t = xmpDate(new TextDecoder().decode(b.subarray(p + 4, p + 2 + len)));
        if (t) return { t, src: 'xmp' };
      }
      if (marker === 0xda) break;
      p += 2 + len;
    }
    return null;
  }
  // PNG（iPhoneのスクリーンショット）
  if (b[0] === 0x89 && latin(1, 3) === 'PNG') {
    let p = 8;
    while (p + 8 < b.length) {
      const len = v.getUint32(p);
      const type = latin(p + 4, 4);
      if (type === 'eXIf') { const t = parseTiffDate(v, p + 8); if (t) return { t, src: 'exif' }; }
      if (type === 'iTXt' || type === 'tEXt') {
        const txt = new TextDecoder().decode(b.subarray(p + 8, Math.min(b.length, p + 8 + len)));
        const t = xmpDate(txt);
        if (t) return { t, src: 'xmp' };
        // PNG のテキスト（「Creation Time」「date:create」など）
        const m = /^(Creation Time|date:create|CreationTime)\0(?:[\0-\x01]\0[^\0]*\0[^\0]*\0)?(.+)$/s.exec(txt);
        if (m) { const v2 = m[2].trim(); const t2 = Date.parse(v2); const t3 = Number.isFinite(t2) ? t2 : exifDateToMs(v2); if (t3) return { t: t3, src: 'png' }; }
      }
      if (type === 'IDAT' || type === 'IEND') break;
      p += 12 + len;
    }
  }
  return null;
}

const natural = new Intl.Collator('ja', { numeric: true });

/** 撮影順に並べ替える。並べ方の説明も返す（全部に撮影日時がある時だけ日時順、それ以外はファイル名の番号順。
 *  ファイルの更新日時は iPhone では「取り込んだ時刻」になることが多いので使わない） */
export async function sortShots(files: File[]): Promise<{ files: File[]; how: string }> {
  const info: Array<{ f: File; i: number; t: number | null }> = [];
  for (let i = 0; i < files.length; i++) info.push({ f: files[i], i, t: await captureTime(files[i]).catch(() => null) });
  let how: string;
  if (info.length > 1 && info.every((x) => x.t !== null) && new Set(info.map((x) => x.t)).size > 1) {
    info.sort((a, b) => a.t! - b.t! || natural.compare(a.f.name, b.f.name) || a.i - b.i);
    how = '撮影日時の順';
  } else {
    info.sort((a, b) => natural.compare(a.f.name, b.f.name) || a.i - b.i);
    how = 'ファイル名の順';
  }
  return { files: info.map((x) => x.f), how };
}
export { natural };
