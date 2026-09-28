// 文章を読み上げ用の短いかたまり（文）に分割する

const TERMINALS = '。．！？!?｡';
const CLOSERS = '」』）)】〕〉》〙〛"\'’”｣';
const SOFT_BREAKS = '、，,・；;：: 　';
const SPEAKABLE = /[\p{L}\p{N}]/u;

export interface Sentence {
  text: string;
  para: number; // 段落番号
  speakable: boolean;
}

/** 1段落を文に分割（句点・感嘆符・疑問符で区切り、長すぎる文は読点などで分ける） */
export function splitParagraph(p: string, cap = 150): string[] {
  const out: string[] = [];
  let buf = '';
  const chars = Array.from(p);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    buf += ch;
    if (TERMINALS.includes(ch)) {
      // 連続する終端記号・閉じ括弧を同じ文に含める
      while (i + 1 < chars.length && (TERMINALS.includes(chars[i + 1]) || CLOSERS.includes(chars[i + 1]))) {
        buf += chars[++i];
      }
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  const capped: string[] = [];
  for (const s of out) capped.push(...capLength(s, cap));
  return capped.filter((s) => s.trim().length > 0);
}

function capLength(s: string, cap: number): string[] {
  const res: string[] = [];
  let rest = Array.from(s);
  while (rest.length > cap) {
    let cut = -1;
    for (let i = cap - 1; i >= Math.floor(cap * 0.4); i--) {
      if (SOFT_BREAKS.includes(rest[i])) { cut = i + 1; break; }
    }
    if (cut < 0) cut = cap;
    res.push(rest.slice(0, cut).join(''));
    rest = rest.slice(cut);
  }
  if (rest.length) res.push(rest.join(''));
  return res;
}

/** ページ全体のテキストを段落（改行）と文に分割 */
export function splitText(text: string, cap = 150): Sentence[] {
  const paras = text.replace(/\r\n?/g, '\n').split('\n');
  const result: Sentence[] = [];
  let paraNo = 0;
  for (const p of paras) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    for (const s of splitParagraph(trimmed, cap)) {
      const speakable = SPEAKABLE.test(s);
      // 記号だけのかたまりは直前の文にくっつける
      const prev = result[result.length - 1];
      if (!speakable && prev && prev.para === paraNo) {
        prev.text += s;
        continue;
      }
      result.push({ text: s, para: paraNo, speakable });
    }
    paraNo++;
  }
  return result;
}

/**
 * PDFやOCRの「見た目上の改行」をつなげる。
 * 空行は段落区切りとして残し、句点などで終わる行の改行は残す。
 */
export function joinLayoutLines(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // 典型的な行の長さ（長い方から1割の位置）。これより明らかに短い行は段落や見出しの終わりとみなす
  const lens = lines.map((l) => Array.from(l.trim()).length).filter((n) => n > 0).sort((a, b) => b - a);
  const typical = lens.length >= 3 ? lens[Math.floor(lens.length * 0.1)] : Infinity;
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/u, '');
    if (!line.trim()) {
      if (out && !out.endsWith('\n')) out += '\n';
      continue;
    }
    if (!out || out.endsWith('\n')) { out += line.trimStart(); }
    else {
      const prev = out[out.length - 1];
      const next = line.trimStart()[0];
      // 英単語どうしはスペースでつなぐ
      if (/[A-Za-z0-9,.;:]/.test(prev) && /[A-Za-z0-9]/.test(next)) out += ' ';
      out += line.trimStart();
    }
    const last = out[out.length - 1];
    const short = Array.from(line.trim()).length < typical * 0.7;
    if (TERMINALS.includes(last) || CLOSERS.includes(last) || short) out += '\n';
  }
  return out.trim();
}

/** OCR結果の、日本語文字の間に入る余計な空白を取り除く */
export function removeCjkSpaces(text: string): string {
  const cjk = '[\\u2014\\u2015\\u2026\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]';
  const re = new RegExp(`(${cjk})[ \\t]+(?=${cjk})`, 'gu');
  let prev = '';
  let cur = text;
  while (prev !== cur) { prev = cur; cur = cur.replace(re, '$1'); }
  return cur;
}
