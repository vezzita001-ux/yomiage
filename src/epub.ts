// ePub の読み込み（頑丈版）
// ・DRM／フォント難読化の判定（META-INF/encryption.xml, rights.xml など）
// ・OPF の読み取り（名前空間の接頭辞つき、XMLとして壊れているものは正規表現で読む）
// ・spine をすべてたどる（linear="no" も）。spine が無ければ nav / ncx / マニフェスト順
// ・本文の取り出し（XHTML → だめなら text/html、名前空間をまたぐ、ルビの読みを除く、body の textContent へのフォールバック）
// ・文字がほとんど無く画像がある章は「画像ページ」（PDFの画像ページと同じくOCRにかける）
// ・失敗した時のための構造の診断（本文そのものは含めない）
import JSZip from 'jszip';

export interface EpubPage {
  kind: 'text' | 'image';
  spine: number; // spine の何番目か
  text?: string;
  image?: string; // zip 内のパス
}

export interface EpubInfo {
  title: string;
  /** OPF の dc:title（無ければ ''） */
  metaTitle: string;
  pages: EpubPage[];
  diag: string;
  unit: string;
  hasImages: boolean;
  zip: JSZip;
}

export class EpubError extends Error {
  diag: string;
  constructor(msg: string, diag: string) { super(msg); this.diag = diag; this.name = 'EpubError'; }
}

const FONT_OBF = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);
const FONT_EXT = /\.(otf|ttf|woff2?|eot|odttf)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|bmp|avif)$/i;
const HTML_EXT = /\.(x?html?|xml)$/i;

// ---------------- パス ----------------
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** base（ディレクトリ）からの相対パス href を zip 内のパスにする */
export function resolvePath(base: string, href: string): string {
  let h = href.trim().split('#')[0].split('?')[0];
  h = h.replace(/\\/g, '/');
  const absolute = h.startsWith('/');
  const parts = (absolute || !base ? [] : base.split('/')).concat(safeDecode(h).split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

/** zip 内のファイルを探す（デコード済み・未デコード・大文字小文字違いも） */
function findFile(zip: JSZip, base: string, href: string): JSZip.JSZipObject | null {
  const decoded = resolvePath(base, href);
  const cand = [decoded];
  // 未デコードのまま（ファイル名自体に %xx が入っている ePub）
  const rawParts = (href.startsWith('/') || !base ? [] : base.split('/')).concat(href.split('#')[0].split('?')[0].split('/'));
  const raw: string[] = [];
  for (const p of rawParts) { if (p === '..') raw.pop(); else if (p !== '.' && p !== '') raw.push(p); }
  cand.push(raw.join('/'));
  for (const c of cand) { const f = zip.file(c); if (f) return f; }
  const lower = decoded.toLowerCase();
  const nfc = decoded.normalize('NFC');
  let hit: JSZip.JSZipObject | null = null;
  zip.forEach((path, file) => {
    if (hit || file.dir) return;
    const p = safeDecode(path);
    if (p.toLowerCase() === lower || p.normalize('NFC') === nfc) hit = file;
  });
  return hit;
}

// ---------------- 文字コード ----------------
async function readText(file: JSZip.JSZipObject): Promise<string> {
  const b = await file.async('uint8array');
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const head = new TextDecoder('latin1').decode(b.subarray(0, 300));
  const m = head.match(/encoding\s*=\s*["']([\w.-]+)["']/i) || head.match(/charset\s*=\s*["']?([\w.-]+)/i);
  const label = (m?.[1] || 'utf-8').toLowerCase();
  try { return new TextDecoder(label).decode(b); } catch { return new TextDecoder('utf-8').decode(b); }
}

/** 暗号化されたデータらしいか（文字として読めない） */
function looksBinary(s: string): boolean {
  const sample = s.slice(0, 2000);
  if (!sample) return false;
  const bad = (sample.match(/[\uFFFD\u0000-\u0008\u000E-\u001F]/g) || []).length;
  return bad / sample.length > 0.1 || !sample.includes('<');
}

// ---------------- XML ----------------
const parser = () => new DOMParser();

function parseXml(s: string): Document | null {
  const d = parser().parseFromString(s.replace(/^\uFEFF/, ''), 'application/xml');
  if (d.getElementsByTagName('parsererror').length || d.getElementsByTagNameNS('*', 'parsererror').length) return null;
  return d;
}

/** 名前空間や接頭辞（opf:item など）に関係なく要素を探す */
function byLocal(root: Document | Element, name: string): Element[] {
  const out = Array.from(root.getElementsByTagNameNS('*', name));
  if (out.length) return out;
  // 接頭辞つきで名前空間が宣言されていない場合など
  return Array.from(root.getElementsByTagName('*')).filter((e) => {
    const n = (e.localName || e.nodeName).toLowerCase();
    return n === name.toLowerCase() || n.endsWith(':' + name.toLowerCase());
  });
}

/** XMLとして壊れていても読めるよう、正規表現でタグの属性を拾う */
function regexTags(s: string, name: string): Array<Record<string, string>> {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*)>`, 'gi');
  const out: Array<Record<string, string>> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const attrs: Record<string, string> = {};
    const ar = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(m[1]))) attrs[a[1].replace(/^[\w-]+:(?=[\w-]+$)/, (p) => (p === 'xlink:' ? p : ''))] = decodeEntities(a[3] ?? a[4] ?? '');
    out.push(attrs);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function attrsOf(e: Element): Record<string, string> {
  const o: Record<string, string> = {};
  for (const a of Array.from(e.attributes)) o[a.localName || a.name] = a.value;
  return o;
}

// ---------------- DRM ----------------
interface DrmInfo { drm: string | null; obfuscatedFonts: number; encrypted: string[]; notes: string[] }

async function checkDrm(zip: JSZip): Promise<DrmInfo> {
  const info: DrmInfo = { drm: null, obfuscatedFonts: 0, encrypted: [], notes: [] };
  const has = (p: string) => !!findFile(zip, '', p);
  const rights = has('META-INF/rights.xml');
  if (rights) info.notes.push('rights.xml');
  if (has('META-INF/sinf.xml')) info.notes.push('sinf.xml(Apple)');
  if (has('META-INF/license.lcpl')) info.notes.push('license.lcpl(LCP)');
  const encFile = findFile(zip, '', 'META-INF/encryption.xml');
  if (!encFile) return info;
  const enc = await readText(encFile);
  const docx = parseXml(enc);
  const entries: Array<{ alg: string; uri: string; adept: boolean }> = [];
  if (docx) {
    for (const ed of byLocal(docx, 'EncryptedData')) {
      const alg = byLocal(ed, 'EncryptionMethod')[0]?.getAttribute('Algorithm') || '';
      const uri = byLocal(ed, 'CipherReference')[0]?.getAttribute('URI') || '';
      const adept = /ns\.adobe\.com\/adept/.test(new XMLSerializer().serializeToString(ed));
      entries.push({ alg, uri, adept });
    }
  } else {
    const algs = regexTags(enc, 'EncryptionMethod').map((a) => a.Algorithm || '');
    const uris = regexTags(enc, 'CipherReference').map((a) => a.URI || '');
    uris.forEach((u, k) => entries.push({ alg: algs[k] || '', uri: u, adept: /adept/.test(enc) }));
  }
  for (const e of entries) {
    const path = safeDecode(e.uri);
    if (FONT_OBF.has(e.alg) || (FONT_EXT.test(path) && !e.adept)) { info.obfuscatedFonts++; continue; }
    info.encrypted.push(path);
    if (!info.drm) {
      info.drm = e.adept || rights ? 'Adobe DRM' : info.notes.some((n) => n.startsWith('sinf')) ? 'Apple FairPlay'
        : info.notes.some((n) => n.startsWith('license.lcpl')) ? 'Readium LCP' : '暗号化';
    }
  }
  return info;
}

// ---------------- 本文 ----------------
const BLOCK_TAGS = new Set(['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'caption', 'blockquote', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'dt', 'dd', 'dl', 'figcaption', 'pre', 'hr', 'title', 'address']);
const SKIP_TAGS = new Set(['rt', 'rp', 'script', 'style', 'head', 'noscript', 'template']);

function parseHtml(raw: string): Document {
  const s = raw.replace(/^\uFEFF/, '');
  const x = parser().parseFromString(s, 'application/xhtml+xml');
  const bad = x.getElementsByTagName('parsererror').length || x.getElementsByTagNameNS('*', 'parsererror').length;
  if (!bad && x.documentElement) return x;
  return parser().parseFromString(s, 'text/html');
}

function bodyOf(d: Document): Element {
  return d.body || byLocal(d, 'body')[0] || d.documentElement;
}

export interface Chapter { text: string; images: string[]; chars: number }

/** 章（XHTML）から本文の文字と画像の参照を取り出す */
export function extractChapter(raw: string, dir: string): Chapter {
  const d = parseHtml(raw);
  const body = bodyOf(d);
  // 画像：<img src>, <svg><image xlink:href / href>, <object data>, <input type=image>
  const images: string[] = [];
  for (const el of Array.from(body.getElementsByTagName('*'))) {
    const n = (el.localName || '').toLowerCase();
    let src = '';
    if (n === 'img') src = el.getAttribute('src') || el.getAttribute('data-src') || '';
    else if (n === 'image') src = el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || el.getAttribute('xlink:href') || el.getAttribute('href') || '';
    else if (n === 'object' && /image/.test(el.getAttribute('type') || '')) src = el.getAttribute('data') || '';
    if (src && !/^data:/i.test(src)) images.push(resolvePath(dir, src));
  }
  // 本文（ルビの読みなどは除く）
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === 3 || node.nodeType === 4) { out += (node.nodeValue || '').replace(/[\r\n\t]+/g, ''); return; }
    if (node.nodeType !== 1) return;
    const tag = ((node as Element).localName || '').toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'svg') { // SVG 内の <text> だけ拾う
      for (const t of byLocal(node as Element, 'text')) out += '\n' + (t.textContent || '') + '\n';
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) out += '\n';
    node.childNodes.forEach(walk);
    if (block) out += '\n';
  };
  walk(body);
  let text = out.replace(/[ \u00a0\u3000]+\n/g, '\n').replace(/\n[ \u00a0]+/g, '\n').replace(/\n{2,}/g, '\n').trim();
  if (!text) {
    // フォールバック：ルビの読みを除いた body の textContent
    const clone = body.cloneNode(true) as Element;
    for (const t of ['rt', 'rp', 'script', 'style']) byLocal(clone, t).forEach((e) => e.remove());
    text = (clone.textContent || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  }
  if (!text && body === d.documentElement && /<body/i.test(raw) === false) {
    // どうにも読めない時：タグを取り除いただけの文字
    text = raw.replace(/<(rt|rp)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }
  return { text, images: Array.from(new Set(images)), chars: text.replace(/[\s\p{P}\p{S}]/gu, '').length };
}

/** 長い章は約3000文字ごとに段落の切れ目で分ける（6000文字を超える時だけ） */
function splitLong(text: string): string[] {
  if (text.length <= 6000) return [text];
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length > 3000 && cur.trim()) { out.push(cur.trim()); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------------- 本体 ----------------
export async function loadEpub(buf: ArrayBuffer, fileName: string): Promise<EpubInfo> {
  const diag: string[] = [`ePub診断: ${(buf.byteLength / 1048576).toFixed(2)}MB`];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    throw new EpubError('ePub（zip）として開けませんでした。ファイルが壊れているか、ePubではない可能性があります', `zip読み込み失敗: ${(e as Error).message}`);
  }
  const files: string[] = [];
  zip.forEach((p, f) => { if (!f.dir) files.push(p); });
  diag.push(`zip内のファイル: ${files.length}件（xhtml/html ${files.filter((p) => /\.x?html?$/i.test(p)).length}、画像 ${files.filter((p) => IMAGE_EXT.test(p)).length}）`);

  // DRM
  const drm = await checkDrm(zip);
  diag.push(`暗号化: ${drm.drm ? `あり（${drm.drm}、${drm.encrypted.length}ファイル）` : 'なし'}／フォント難読化: ${drm.obfuscatedFonts}件${drm.notes.length ? `／${drm.notes.join(', ')}` : ''}`);

  // OPF の場所
  let opfPath = '';
  const cf = findFile(zip, '', 'META-INF/container.xml');
  if (cf) {
    const c = await readText(cf);
    const cx = parseXml(c);
    opfPath = (cx ? byLocal(cx, 'rootfile').map(attrsOf) : regexTags(c, 'rootfile'))
      .map((a) => a['full-path'] || '').find((p) => p && /\.opf$/i.test(p)) || '';
    if (!opfPath) opfPath = regexTags(c, 'rootfile')[0]?.['full-path'] || '';
  }
  if (!opfPath || !findFile(zip, '', opfPath)) {
    const alt = files.find((p) => /\.opf$/i.test(p));
    diag.push(`container.xml: ${cf ? `OPFの指定 "${opfPath}" が見つからない` : 'なし'} → ${alt || 'OPFなし'}`);
    opfPath = alt || '';
  }
  diag.push(`OPF: ${opfPath || '（なし）'}`);
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  // マニフェスト・spine
  const manifest = new Map<string, { href: string; type: string; props: string; path: string }>();
  const spineRefs: Array<{ idref: string; linear: string; props: string }> = [];
  let title = '';
  let fixedLayout = false;
  let direction = '';
  let tocId = '';
  if (opfPath) {
    const opfText = await readText(findFile(zip, '', opfPath)!);
    const opf = parseXml(opfText);
    diag.push(`OPFの解析: ${opf ? 'XML' : 'XMLとして壊れている → 正規表現で読み取り'}`);
    const items = opf ? byLocal(opf, 'item').map(attrsOf) : regexTags(opfText, 'item');
    const refs = opf ? byLocal(opf, 'itemref').map(attrsOf) : regexTags(opfText, 'itemref');
    const effective = items.length ? items : regexTags(opfText, 'item');
    for (const a of effective) {
      if (!a.id && !a.href) continue;
      manifest.set(a.id || a.href, { href: a.href || '', type: (a['media-type'] || '').toLowerCase(), props: a.properties || '', path: resolvePath(opfDir, a.href || '') });
    }
    for (const a of (refs.length ? refs : regexTags(opfText, 'itemref'))) spineRefs.push({ idref: a.idref || '', linear: a.linear || '', props: a.properties || '' });
    const spineEl = opf ? byLocal(opf, 'spine')[0] : null;
    const spineAttrs = spineEl ? attrsOf(spineEl) : (regexTags(opfText, 'spine')[0] || {});
    direction = spineAttrs['page-progression-direction'] || '';
    tocId = spineAttrs.toc || '';
    title = decodeEntities(((opfText.match(/<(?:[\w-]+:)?title\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?title>/i) || [])[1] || '').replace(/<[^>]+>/g, '')).trim();
    fixedLayout = /rendition:layout"?\s*>\s*pre-paginated/.test(opfText) || /property\s*=\s*["']rendition:layout["'][^>]*>\s*pre-paginated/.test(opfText)
      || /name\s*=\s*["']fixed-layout["']\s+content\s*=\s*["']true/.test(opfText) || /content\s*=\s*["']true["']\s+name\s*=\s*["']fixed-layout/.test(opfText)
      || /name\s*=\s*["']original-resolution["']/.test(opfText);
  }
  diag.push(`マニフェスト: ${manifest.size}件／spine: ${spineRefs.length}件（linear=no ${spineRefs.filter((r) => r.linear === 'no').length}件）／固定レイアウト: ${fixedLayout ? 'あり' : 'なし'}／ページ送り: ${direction || '指定なし'}`);

  // 読む順（spine → nav/ncx → マニフェスト順 → zip内の html）
  let order: string[] = [];
  const missing: string[] = [];
  for (const r of spineRefs) {
    const m = manifest.get(r.idref);
    if (!m) { missing.push(r.idref); continue; }
    order.push(m.path);
  }
  if (missing.length) diag.push(`spineの参照先がマニフェストにない: ${missing.length}件`);
  if (!order.length) {
    // nav / ncx の目次の順
    const tocPaths: string[] = [];
    const ncx = (tocId && manifest.get(tocId)) || Array.from(manifest.values()).find((m) => m.type === 'application/x-dtbncx+xml' || /\.ncx$/i.test(m.href));
    const nav = Array.from(manifest.values()).find((m) => /\bnav\b/.test(m.props));
    for (const t of [nav, ncx]) {
      if (!t) continue;
      const tf = findFile(zip, '', t.path);
      if (!tf) continue;
      const s = await readText(tf);
      const tdir = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : '';
      const refs = t === nav ? regexTags(s, 'a').map((a) => a.href) : regexTags(s, 'content').map((a) => a.src);
      for (const h of refs) if (h) { const p = resolvePath(tdir, h); if (!tocPaths.includes(p)) tocPaths.push(p); }
    }
    if (tocPaths.length) { order = tocPaths; diag.push(`spineが空 → 目次（nav/ncx）の順: ${order.length}件`); }
  }
  if (!order.length) {
    order = Array.from(manifest.values()).filter((m) => /html|xml/.test(m.type) && !/ncx|nav/.test(m.type + m.props) && HTML_EXT.test(m.href)).map((m) => m.path);
    if (order.length) diag.push(`マニフェスト順で代用: ${order.length}件`);
  }
  if (!order.length) {
    order = files.filter((p) => /\.x?html?$/i.test(p)).sort();
    if (order.length) diag.push(`zip内のhtmlで代用: ${order.length}件`);
  }

  // DRM で本文が暗号化されていれば、分かりやすく止める
  const encSet = new Set(drm.encrypted.map((p) => p.replace(/^\//, '')));
  const contentEncrypted = order.some((p) => encSet.has(p)) || (drm.drm && drm.encrypted.length > 0);
  if (drm.drm && contentEncrypted) {
    throw new EpubError(
      `このePubはDRM（コピー防止：${drm.drm}）で保護されているため読めません。購入したストアのアプリで読んでください。DRMのない（DRMフリーの）ePubなら読めます。`,
      diag.join('\n'),
    );
  }

  // 章ごとに読む
  const pages: EpubPage[] = [];
  const chapterDiag: string[] = [];
  let binaryCount = 0;
  for (let si = 0; si < order.length; si++) {
    const path = order[si];
    const f = findFile(zip, '', path);
    const m = Array.from(manifest.values()).find((x) => x.path === path);
    const name = path.split('/').pop() || path;
    // 目次（nav）が linear="no" で spine に入っている場合は読まない
    if (m && /\bnav\b/.test(m.props) && spineRefs[si]?.linear === 'no') { chapterDiag.push(`${si + 1}. ${name}: 目次（nav・linear=no）なので読まない`); continue; }
    if (!f) { chapterDiag.push(`${si + 1}. ${name}: ファイルなし`); continue; }
    // spine に画像が直接入っている場合
    if (IMAGE_EXT.test(path) || (m && m.type.startsWith('image/'))) {
      pages.push({ kind: 'image', spine: si, image: path });
      chapterDiag.push(`${si + 1}. ${name}: 画像（spine直）`);
      continue;
    }
    let raw = '';
    try { raw = await readText(f); } catch { chapterDiag.push(`${si + 1}. ${name}: 読めない`); continue; }
    if (looksBinary(raw)) { binaryCount++; chapterDiag.push(`${si + 1}. ${name}: 文字として読めない（暗号化?）`); continue; }
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    let ch: Chapter;
    try { ch = extractChapter(raw, dir); } catch (e) { chapterDiag.push(`${si + 1}. ${name}: 解析失敗 ${(e as Error).message}`); continue; }
    const imgs = ch.images.filter((p) => findFile(zip, '', p));
    const lin = spineRefs[si]?.linear === 'no' ? ' linear=no' : '';
    chapterDiag.push(`${si + 1}. ${name}: ${ch.chars}文字・画像${ch.images.length}${imgs.length !== ch.images.length ? `（見つからない${ch.images.length - imgs.length}）` : ''}${lin}`);
    // 文字がほとんど無く画像がある章 → 画像ページ（1枚ずつ）
    if (ch.chars < 20 && imgs.length) {
      for (const p of imgs) pages.push({ kind: 'image', spine: si, image: p });
      continue;
    }
    if (ch.chars === 0) continue; // 空の章（区切りページなど）
    for (const t of splitLong(ch.text)) pages.push({ kind: 'text', spine: si, text: t });
  }
  // 章ごとの内訳は長くなるので、最大200件
  diag.push(`章（${order.length}件）: ${chapterDiag.length > 200 ? chapterDiag.slice(0, 200).join(' / ') + ` …ほか${chapterDiag.length - 200}件` : chapterDiag.join(' / ')}`);
  const nText = pages.filter((p) => p.kind === 'text').length;
  const nImg = pages.length - nText;
  diag.push(`ページ: 文字${nText}・画像${nImg}`);
  const diagText = diag.join('\n');
  if (!pages.length) {
    const msg = binaryCount && binaryCount >= order.length / 2
      ? '本文が暗号化されているようです（DRM付きの可能性があります）。購入したストアのアプリで読んでください。'
      : order.length
        ? 'ePubに本文の文字も画像も見つかりませんでした。「設定 → 診断ログ」をコピーして送ってください（本の文章はログに含まれません）。'
        : 'ePubの目次（spine）も本文のファイルも見つかりませんでした。ファイルが壊れている可能性があります。';
    throw new EpubError(msg, diagText);
  }
  const hasImages = nImg > 0;
  return {
    title: title || fileName.replace(/\.epub$/i, ''),
    metaTitle: title,
    pages,
    diag: diagText,
    unit: hasImages || pages.length !== new Set(pages.map((p) => p.spine)).size ? 'ページ' : '章',
    hasImages,
    zip,
  };
}

/** 画像の拡張子から MIME タイプ */
export function mimeOf(path: string): string {
  const e = (path.split('.').pop() || '').toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' } as Record<string, string>)[e] || 'application/octet-stream';
}

export async function epubImageBlob(zip: JSZip, path: string): Promise<Blob> {
  const f = findFile(zip, '', path);
  if (!f) throw new Error(`ePubの画像が見つかりません（${path.split('/').pop()}）`);
  const data = await f.async('arraybuffer');
  return new Blob([data], { type: mimeOf(path) });
}

/** dc:title だけを軽く読む（本棚から名前を変える時の「本のタイトルを使う」用） */
export async function epubMetaTitle(buf: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  let opfPath = '';
  const cf = findFile(zip, '', 'META-INF/container.xml');
  if (cf) opfPath = regexTags(await readText(cf), 'rootfile')[0]?.['full-path'] || '';
  if (!opfPath || !findFile(zip, '', opfPath)) { zip.forEach((p, f) => { if (!opfPath && !f.dir && /\.opf$/i.test(p)) opfPath = p; }); }
  if (!opfPath) return '';
  const opfText = await readText(findFile(zip, '', opfPath)!);
  return decodeEntities(((opfText.match(/<(?:[\w-]+:)?title\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?title>/i) || [])[1] || '').replace(/<[^>]+>/g, '')).trim();
}
