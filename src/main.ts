import './polyfills';
import './style.css';
import { Speaker, type SpeakResult } from './speech';
import { ServerSpeaker } from './voicevox';
import { aivisCredit, shortName, styleJa, AIVIS_ORDER } from './aivis-credits';
import { applyDict, loadDict, saveDict, newId, checkRegex, exportDict, parseDictImport, type DictEntry } from './dict';
import { splitText, type Sentence } from './split';
import { openFiles, openScreenshots, docIdFor, parseBookName, bookLabel, type LoadedDoc, type BookName } from './docs';
import { trimKey, loadTrim, saveTrim, isScreen, trimQuery, trimSig, cropForDevice, type Trim } from './trim';
import { listItems as sbList, putItem as sbPut, putMany as sbPutMany, clearItems as sbClearAll, loadMeta as sbLoadMeta, saveMeta as sbStoreMeta, prepare as sbPrepare, unzipImages, isImage, isZip, classify as sbClassify, inBook as sbInBook, makePdfBlob as sbMakePdfBlob, memoryMode as sbMemoryMode, freezeOrder as sbFreeze, namesUseful as sbNamesUseful, splitRanges as sbSplitRanges, SORT_LABEL as SB_SORT_LABEL, HOW_LABEL as SB_HOW_LABEL, type ShotItem, type SortMode } from './shotbook';
import { uploadVideo, processVideo, getStatus, fetchPdf, pdfUrl, grpdfName, lastTitle, rememberTitle, savedUpload, mmss, type VideoStatus } from './video';
import { VIDEO_HELP_HTML } from './video-help';
import { ocrCanvas, prepareCanvas, serverOcr, linesToText, splitSpread, type OcrMode, type OcrLine } from './ocr';
import { dlog, installLogCapture, environmentReport, logText, BUILD } from './debuglog';
import { registerSW } from 'virtual:pwa-register';
import { loadFixes, saveFixes, applyToUnits, diffCore, replaceAllCount, type DocFixes } from './fixes';
import {
  loadSettings, saveSettings, loadPosition, savePosition, saveRecent, touchRecent, listRecent,
  getRecent, deleteRecent, getCachedPage, putCachedPage, clearAll, renameRecent, getRecentRecord, type Settings,
} from './storage';
import { loadName, saveName, fileNameFor, bookFor, displayFor, extOf, normVol, sanitize, pdfInfoTitle, type NameRec } from './rename';
import { epubMetaTitle } from './epub';
import { makePdf, type PdfPage } from './pdfwrite';
import { estimate as bkEstimate, buildBackup, restoreBackup, inspectBackup, LAST_KEY as BK_LAST } from './backup';
import { api, serverBase, getServerUrl, setServerUrl, normalizeServerUrl, checkServer, usingRemoteServer, autoUpdateServerUrl } from './server';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

installLogCapture();
// 上部バーの高さ（ページ画像をその下に固定表示するため）
const setTopbarH = () => {
  const tb = document.querySelector<HTMLElement>('.topbar');
  if (tb) document.documentElement.style.setProperty('--topbar-h', `${tb.offsetHeight}px`);
};
setTopbarH();
window.addEventListener('resize', setTopbarH);
dlog('INFO', `build ${BUILD}`, navigator.userAgent);
// Service Worker：新しい版があればすぐ切り替えて再読み込み
try {
  registerSW({ immediate: true, onRegisterError: (e) => console.warn('SW register failed', e) });
} catch (e) { console.warn('SW', e); }

// ---------------- 状態 ----------------
const settings: Settings = loadSettings();
const speaker = new Speaker();
const vv = new ServerSpeaker('/voicevox');
const av = new ServerSpeaker('/aivis', (character, style) => {
  const i = AIVIS_ORDER.findIndex((re) => re.test(character));
  return { label: `${shortName(character)}（${styleJa(style)}）`, order: i < 0 ? 99 : i };
});
const ENGINE_NAME = { browser: '端末の声', voicevox: 'VOICEVOX', aivis: 'AivisSpeech' } as const;
/** サーバー型エンジン（VOICEVOX / AivisSpeech）と選択中の話者ID */
function server(): { eng: ServerSpeaker; spk: number } | null {
  if (settings.engine === 'voicevox') return { eng: vv, spk: settings.vvSpeaker };
  if (settings.engine === 'aivis') return { eng: av, spk: settings.aivisSpeaker };
  return null;
}
function unlockAll() {
  speaker.unlock();
  server()?.eng.unlock();
}
const engine = () => server()?.eng ?? speaker;
const speakOpts = () => ({ voiceURI: settings.voiceURI, rate: settings.rate, pitch: settings.pitch, intonation: settings.intonation, volume: settings.volume, pause: settings.pause });
function speakSentence(original: string, idx: number): Promise<SpeakResult> {
  // 読み方辞書は読み上げる文字にだけ適用（表示はそのまま）
  const text = applyDict(original);
  const srv = server();
  if (srv) {
    const { eng, spk } = srv;
    const o = speakOpts();
    // 次の2文を先に合成しておき、途切れなく読む
    let ahead = 0;
    for (let j = idx + 1; j < sentences.length && ahead < 2; j++) {
      if (!sentences[j].speakable) continue;
      eng.prefetch(applyDict(sentences[j].text), spk, o).catch(() => undefined);
      ahead++;
    }
    // ページの終わりが近ければ、次のページの最初の文も先に合成しておく
    if (ahead < 2 && doc && pageIdx + 1 < doc.pageCount) {
      const need = 2 - ahead;
      getPageText(pageIdx + 1).then((t) => {
        splitText(pageView(pageIdx + 1, t).view.text).filter((x) => x.speakable).slice(0, need).forEach((x) => eng.prefetch(applyDict(x.text), spk, o).catch(() => undefined));
      }).catch(() => undefined);
    }
    return eng.speak(text, spk, o);
  }
  return speaker.speak(text, speakOpts());
}
let doc: LoadedDoc | null = null;
let docFiles: File[] = [];
let pageIdx = 0; // 表示・読み上げ中のページ
let loadedPage = -1; // sentences が対応しているページ
let sentences: Sentence[] = [];
let sentIdx = 0;
let playing = false;
let playToken = 0;
let pageToken = 0;
let fails = 0;
interface PageData {
  text: string;
  lines?: OcrLine[];
  ranges?: Array<[number, number]>;
  width?: number;
  height?: number;
  engine?: string;
  crop?: number[];
  /** 読まないページ（スクショの警告画面・前のページと同じ） */
  skip?: string;
  /** 読まないページの元の文字（重複の判定用） */
  raw?: string;
}
/** サーバーOCR結果のキャッシュのキー（スマホ画面モードは切り取り設定ごと） */
function serverKey(d: LoadedDoc, i: number): string {
  const t = loadTrim(trimKey(d));
  return isScreen(d, t) ? `${d.id}#${i}#shot2-${trimSig(t)}-${settings.spread}` : `${d.id}#${i}#ndl-${settings.spread}`;
}
const textCache = new Map<number, Promise<PageData>>();
/** 読み取り済みのページの文字（スクショの重複・警告画面の判定に使う） */
const resolvedText = new Map<number, string>();
const SHOT_DIALOG = /許可されていません|許可されていない|(スクリーンショット|スクショ|画面収録|録画|撮影|キャプチャ).{0,14}(できません|禁止|許可|ご遠慮)/;
const DIALOG_BTN = /^(OK|ＯＫ|はい|閉じる|キャンセル|了解)$/i;
const normT = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, '');
/** a の文字の並び（2文字ずつ）のうち b にも出てくる割合 */
function containedFrac(a: string, b: string): number {
  const x = normT(a), y = normT(b);
  if (x.length < 2 || y.length < 2) return 0;
  const set = new Set<string>();
  for (let i = 0; i + 1 < y.length; i++) set.add(y.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i + 1 < x.length; i++) if (set.has(x.slice(i, i + 2))) hit++;
  return hit / (x.length - 1);
}
/** スクショの本：警告のダイアログが写った画面・前のページと同じ画面は読まない */
function screenSkip(i: number, lines: OcrLine[], dropped: Array<{ text: string; why: string }> | undefined, prevText?: string): { skip?: string; lines: OcrLine[] } {
  const all = lines.map((l) => l.text).join('');
  const prev = prevText !== undefined ? prevText : resolvedText.get(i - 1);
  const dialog = (dropped || []).some((d) => SHOT_DIALOG.test(d.text)) || lines.some((l) => SHOT_DIALOG.test(l.text));
  if (dialog) {
    const rest = lines.filter((l) => !SHOT_DIALOG.test(l.text) && !DIALOG_BTN.test(l.text.trim()));
    const t = rest.map((l) => l.text).join('');
    if (normT(t).length < 40 || (prev && containedFrac(t, prev) > 0.8)) return { skip: 'warning', lines: [] };
    return { lines: rest };
  }
  if (prev && normT(all).length >= 20) {
    const a = normT(all).length, b = normT(prev).length;
    if (Math.abs(a - b) <= Math.max(a, b) * 0.3 && containedFrac(all, prev) > 0.9 && containedFrac(prev, all) > 0.9) return { skip: 'dup', lines: [] };
  }
  return { lines };
}
let pageData: PageData | null = null;
/** 文字の修正（このファイル分） */
let fixes: DocFixes = { v: 1, pages: {}, rules: [] };
/** 今のページの、修正前のデータ（OCRキャッシュそのまま） */
let pageRaw: PageData | null = null;
/** 今のページの単位（サーバーOCRは行、それ以外は段落）：本文中の位置・修正済みか・元の文字 */
let unitRanges: Array<[number, number]> = [];
let unitFixed: boolean[] = [];
let unitOrig: string[] = [];
let unitKind: '行' | '段落' = '行';
/** 各文の本文中の開始位置 */
let sentStarts: number[] = [];
/** 各文がどの行（画像上の枠）にあたるか */
let sentLines: number[][] = [];
const imageCache = new Map<number, Promise<HTMLCanvasElement>>();

// デバッグ・自動テスト用に内部状態を公開
(window as unknown as Record<string, unknown>).__yomiage = {
  get state() { return { page: pageIdx, sentence: sentIdx, playing, sentences: sentences.map((s) => s.text), pageCount: doc?.pageCount ?? 0 }; },
  get sentLines() { return sentLines; },
  speaker,
  vv,
  av,
};

// ---------------- 表示の基本 ----------------
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
}
applyTheme();

let toastTimer = 0;
function toast(msg: string, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, ms);
}

function setStatus(label: string | null, progress?: number) {
  const s = $('status');
  if (label === null) { s.hidden = true; return; }
  s.hidden = false;
  $('statusText').textContent = label;
  const p = $<HTMLProgressElement>('statusProg');
  if (progress === undefined) p.removeAttribute('value'); else p.value = progress;
}

function showView(which: 'home' | 'reader') {
  $('home').hidden = which !== 'home';
  $('reader').hidden = which !== 'reader';
  $('controls').hidden = which !== 'reader';
  $('btnHome').hidden = which !== 'reader';
  $('appTitle').textContent = 'よみあげ';
  if (which === 'home') renderRecent();
}

// ---------------- 最近のファイル ----------------
async function renderRecent() {
  const ul = $('recentList');
  ul.innerHTML = '';
  let list: Awaited<ReturnType<typeof listRecent>> = [];
  try { list = await listRecent(); } catch { /* IndexedDB が使えない */ }
  $('recentEmpty').hidden = list.length > 0;
  bkRemindCheck(list.length);
  // 「巻No.GrPDF.書籍名.pdf」は本棚として書籍名→巻の順に、それ以外は開いた順
  const coll = new Intl.Collator('ja', { numeric: true });
  const withBook = list.map((r) => ({ r, b: effBook(r.id, r.files[0]?.name || '') }));
  const shelf = withBook.filter((x) => x.b).sort((x, y) => coll.compare(x.b!.title, y.b!.title) || x.b!.volNum - y.b!.volNum || coll.compare(x.b!.vol, y.b!.vol) || coll.compare(x.r.name, y.r.name));
  const others = withBook.filter((x) => !x.b);
  const head = (t: string) => { const li = document.createElement('li'); li.className = 'shelf-head'; li.textContent = t; ul.append(li); };
  if (shelf.length) head(`📚 本棚（書籍名・巻の順）${shelf.length}冊`);
  shelf.concat(others).forEach(({ r, b }, idx) => {
    if (shelf.length && others.length && idx === shelf.length) head('そのほかのファイル（開いた順）');
    const pos = loadPosition(r.id);
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'recent-open';
    const prog = pos ? `${pos.page + 1} / ${pos.pageCount}` : '未読';
    open.innerHTML = `<span class="rn"></span><span class="rp"></span>`;
    const label = b ? (b.vol ? `${b.title}　${b.vol}巻` : b.title) : (loadName(r.id) ? displayFor(loadName(r.id)!) : r.name);
    (open.querySelector('.rn') as HTMLElement).textContent = label;
    (open.querySelector('.rp') as HTMLElement).textContent = `続きから（${prog}）`;
    open.setAttribute('aria-label', `${label} を続きから開く。${prog}`);
    open.onclick = async () => {
      const files = await getRecent(r.id);
      if (files) loadFiles(files, false, { screen: r.id.startsWith('shot|'), id: r.id });
    };
    const del = document.createElement('button');
    del.className = 'recent-del';
    del.textContent = '削除';
    del.setAttribute('aria-label', `${label} を一覧から削除`);
    del.onclick = async () => {
      if (!confirm(`「${label}」を一覧から削除しますか？（読書位置も消えます）`)) return;
      await deleteRecent(r.id);
      saveName(r.id, null); localStorage.removeItem(MTITLE + r.id);
      renderRecent();
    };
    const ren = document.createElement('button');
    ren.className = 'recent-ren';
    ren.innerHTML = '✏️<span>名前を変更</span>';
    ren.setAttribute('aria-label', `${label} の名前を変更`);
    ren.title = '名前を変更';
    ren.onclick = () => openRename({ id: r.id, fileName: r.files[0]?.name || r.name, files: r.files.length, getFile: async () => (await getRecent(r.id))?.[0] ?? null });
    li.append(open, ren, del);
    ul.append(li);
  });
}




// ---------------- 読み取った文字入りのPDFを保存 ----------------
// 全ページを OCR（読み取り済みはそのまま）→ ページ画像（JPEG）＋見えない文字の層＋/YomiageOCR の PDF
// → そのPDFだけで、よみあげでも他のアプリでもオフラインで読める（よみあげで開き直すと OCR しない）
let ocrPdfReady: { id: string; file: File } | null = null;
let ocrPdfBusy = false;
$('btnOcrPdf').onclick = async () => {
  const d = doc; if (!d || ocrPdfBusy) return;
  const btn = $('btnOcrPdf');
  const canShare = (f: File) => { try { return !!navigator.canShare?.({ files: [f] }); } catch { return false; } };
  if (ocrPdfReady?.id === d.id) {
    const f = ocrPdfReady.file;
    if (canShare(f)) { try { await navigator.share({ files: [f], title: f.name }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; } }
    shareOrDownloadFallback(f); return;
  }
  if (!confirm(`全${d.pageCount}${d.unit}の文字を入れたPDFを作ります。まだ読み取っていないページは読み取ります（時間がかかることがあります）。よろしいですか？`)) return;
  ocrPdfBusy = true;
  stopPlayback();
  const pages: PdfPage[] = [];
  let ocrd = 0;
  try {
    for (let i = 0; i < d.pageCount; i++) {
      if (doc !== d) throw new Error('別のファイルを開いたので中止しました');
      setStatus(`文字入りPDFを作っています… ${i + 1} / ${d.pageCount}`, i / d.pageCount);
      const data = await getPageText(i);
      const raw = await d.getRawPage(i);
      if (!raw.image) throw new Error('ページの画像がありません');
      const c = await raw.image();
      const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('画像の変換に失敗しました'))), 'image/jpeg', 0.85));
      const w = c.width, h = c.height;
      freeCanvas(c);
      let lines = data.lines && data.width ? data.lines : null;
      let ow = data.width || w, oh = data.height || h;
      if (!lines && data.text) { lines = [{ text: data.text.replace(/\s+/g, ' '), box: [0, 0, w, h * 0.05], vertical: false }]; ow = w; oh = h; } // 行の位置が無い（端末内OCR・PDFの文字）時は1行として
      if (lines?.length || data.skip) ocrd++;
      pages.push({ blob, w, h, ocr: lines || data.skip ? { lines: lines || [], width: ow, height: oh, skip: data.skip, raw: data.raw } : null });
    }
    const base = exportName(d.id, docOrig?.fileName || docFiles[0]?.name || d.name).replace(/\.[A-Za-z0-9]{1,5}$/, '');
    const file = new File([makePdf(pages, d.name)], `${base}.pdf`, { type: 'application/pdf', lastModified: Date.now() });
    console.info(`[OCRPDF] built ${file.name} ${Math.round(file.size / 1024)}KB, text on ${ocrd}/${d.pageCount} pages`);
    ocrPdfReady = { id: d.id, file };
    setStatus(null);
    if (canShare(file)) { btn.textContent = '📤 できた：押して保存'; toast(`文字入りPDFができました（${Math.round(file.size / 1024 / 1024 * 10) / 10}MB）。もう一度押して保存してください`, 6000); }
    else { shareOrDownloadFallback(file); btn.textContent = '💾 文字入りPDF（もう一度）'; }
  } catch (e) { setStatus(null); toast(`文字入りPDFを作れませんでした：${(e as Error)?.message || e}`, 6000); console.error('[OCRPDF]', e); }
  finally { ocrPdfBusy = false; }
};
function shareOrDownloadFallback(f: File) {
  const a = document.createElement('a');
  const u = URL.createObjectURL(f);
  a.href = u; a.download = f.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10 * 60000);
}

// ---------------- バックアップ・復元 ----------------
// URL（オリジン）が変わると端末の保存場所も別になるので、ファイルにまとめて持ち運ぶ（backup.ts）
const BK_SNOOZE = 'yomiage:backup:snooze';
let bkWhat: 'books' | 'settings' = 'books';
let bkMode: 'merge' | 'replace' = 'merge';
let bkBusy = false;
const fmtSize = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)}GB` : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
const fmtDate = (t: number) => new Date(t).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function bkLast(): { at: number; books: number } | null { try { return JSON.parse(localStorage.getItem(BK_LAST) || 'null'); } catch { return null; } }
function bkRemindCheck(books: number) {
  const box = $('bkRemind');
  const now = Date.now();
  const last = bkLast();
  const snooze = Number(localStorage.getItem(BK_SNOOZE) || 0);
  let msg = '';
  if (books > 0 && now >= snooze) {
    if (!last && books >= 3) msg = `本棚に${books}冊あります。URLが変わったり、ブラウザのデータが消えたりした時のために、バックアップを保存しておくと安心です。`;
    else if (last && books - last.books >= 5) msg = `前のバックアップのあと、本が${books - last.books}冊増えました。`;
    else if (last && now - last.at > 30 * 86400e3) msg = `前のバックアップから${Math.floor((now - last.at) / 86400e3)}日たちました。`;
  }
  $('bkRemindText').textContent = msg;
  box.hidden = !msg;
}
$('bkRemindLater').onclick = () => { localStorage.setItem(BK_SNOOZE, String(Date.now() + 14 * 86400e3)); $('bkRemind').hidden = true; };
$('bkRemindOpen').onclick = () => bkOpen();
function bkSeg() {
  document.querySelectorAll<HTMLButtonElement>('[data-bkwhat]').forEach((b) => { const on = b.dataset.bkwhat === bkWhat; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  document.querySelectorAll<HTMLButtonElement>('[data-bkmode]').forEach((b) => { const on = b.dataset.bkmode === bkMode; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  $('bkModeNote').textContent = bkMode === 'merge'
    ? '今の本棚・設定は残し、無い本や設定を足します。同じ本（同じファイル）は重ねません。読書位置は新しい方を使い、辞書は足し合わせます。'
    : '今の本棚・設定・読み取り結果を消して、バックアップと同じにします（新しい端末・新しいURLで使う時に）。';
}
let bkEst: Awaited<ReturnType<typeof bkEstimate>> | null = null;
const bkSel = new Set<string>();
let bkShotsOn = true;
const BK_SHRINK = 'yomiage:backup:shrink';
type BkShrink = 'small' | 'gray' | 'none';
const bkShrinkSel = () => $('bkShrink') as HTMLSelectElement;
bkShrinkSel().value = /^(small|gray|none)$/.test(localStorage.getItem(BK_SHRINK) || '') ? localStorage.getItem(BK_SHRINK)! : 'small';
const bkShrink = (): BkShrink => bkShrinkSel().value as BkShrink;
/** 小さくした時の本の大きさ（見積もり） */
const bkBookSize = (b: NonNullable<typeof bkEst>['books'][number], m = bkShrink()) => (m === 'none' ? b.size : b[m] ?? b.size);
function bkSelTotal(m = bkShrink()) {
  const e = bkEst; if (!e) return 0;
  const withBooks = bkWhat === 'books';
  let t = e.localBytes + e.pageBytes + 4096;
  if (withBooks) {
    for (const b of e.books) if (bkSel.has(b.id)) t += bkBookSize(b, m) + 400;
    if (e.shots && bkShotsOn) t += m === 'none' ? e.shotBytes : m === 'small' ? e.shotSmall : e.shotGray;
  }
  return t;
}
function bkRenderTotal() {
  const e = bkEst; if (!e) return;
  const withBooks = bkWhat === 'books';
  const total = bkSelTotal();
  const orig = bkSelTotal('none');
  const part = Number(($('bkPart') as HTMLSelectElement).value) * 1024 * 1024;
  const n = withBooks ? Math.max(1, Math.ceil(total / part)) : 1;
  const nb = e.books.filter((b) => bkSel.has(b.id)).length;
  $('bkEstimate').textContent = `合計 およそ ${fmtSize(total)}（${withBooks ? `本 ${nb} / ${e.books.length}冊${e.shots && bkShotsOn ? `＋作りかけのスクショ本 ${e.shots}枚` : ''}、` : '本は入れない、'}設定・辞書・読書位置、読み取り結果 ${e.pages}ページ分）${withBooks && orig > total * 1.05 ? `。画像を小さくした見積もりで、元のままなら ${fmtSize(orig)}` : ''}${n > 1 ? ` → ${n}個のファイルに分けます` : ''}`;
  $('bkShrinkRow').hidden = !(withBooks && (e.books.some((b) => b.small != null) || e.shots));
}
function bkRenderList() {
  const e = bkEst; if (!e) return;
  const box = $('bkList'); box.innerHTML = '';
  const row = (name: string, size: number, on: boolean, set: (v: boolean) => void, note = '', size2?: number) => {
    const l = document.createElement('label'); l.className = 'bk-item';
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = on;
    c.onchange = () => { set(c.checked); bkRenderTotal(); };
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = name;
    if (note) { const n = document.createElement('span'); n.className = 'note'; n.textContent = note; nm.append(n); nm.style.whiteSpace = 'normal'; }
    const sz = document.createElement('span'); sz.className = 'sz'; sz.textContent = size2 != null && size2 < size * 0.95 ? `${fmtSize(size)} → 約${fmtSize(size2)}` : fmtSize(size);
    l.append(c, nm, sz); box.append(l);
  };
  const m = bkShrink();
  for (const b of e.books) row(b.name, b.size, bkSel.has(b.id), (v) => { if (v) bkSel.add(b.id); else bkSel.delete(b.id); }, '', bkBookSize(b, m));
  if (e.shots) row(`📸 作りかけのスクショ本（${e.shots}枚）`, e.shotBytes, bkShotsOn, (v) => { bkShotsOn = v; },
    e.shotsBuiltOnShelf.length ? `作ったPDF（${e.shotsBuiltOnShelf.join('・')}）が本棚にあるので、同じ中身を二重に入れないよう外しています` : '', m === 'none' ? undefined : m === 'small' ? e.shotSmall : e.shotGray);
  $('bkListBox').hidden = bkWhat !== 'books' || !(e.books.length || e.shots);
}
async function bkUpdateEstimate(reload = true) {
  if (reload || !bkEst) {
    $('bkEstimate').textContent = '大きさを計算しています…';
    try {
      bkEst = await bkEstimate();
      bkSel.clear(); for (const b of bkEst.books) bkSel.add(b.id);
      bkShotsOn = !bkEst.shotsBuiltOnShelf.length;
    } catch (err) { $('bkEstimate').textContent = `大きさを計算できませんでした：${(err as Error).message}`; return; }
  }
  bkRenderList();
  bkRenderTotal();
}
$('bkAll').onclick = () => { bkEst?.books.forEach((b) => bkSel.add(b.id)); if (bkEst?.shots) bkShotsOn = true; bkRenderList(); bkRenderTotal(); };
$('bkNone').onclick = () => { bkSel.clear(); bkShotsOn = false; bkRenderList(); bkRenderTotal(); };
bkShrinkSel().addEventListener('change', () => { localStorage.setItem(BK_SHRINK, bkShrink()); bkRenderList(); bkRenderTotal(); });
async function bkStorageInfo() {
  const st = navigator.storage;
  let text = '';
  try {
    if (st?.estimate) { const e = await st.estimate(); if (e.usage != null) text += `使っている量 約${fmtSize(e.usage)}${e.quota ? `（上限の目安 ${fmtSize(e.quota)}）` : ''}。`; }
    const p = st?.persisted ? await st.persisted() : null;
    if (p === true) text += 'この端末では「消されにくい保存」になっています。';
    else if (p === false) text += '空き容量が少ない時や長く使わない時に、ブラウザがデータを消すことがあります。';
    $('bkPersist').hidden = !(p === false && st?.persist);
  } catch { /* 無し */ }
  text += ' データは「このURL」ごとに別々に保存されます（URLが変わると本棚は空になります）。';
  $('bkStorage').textContent = text.trim();
}
async function bkPersistQuiet() { try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* 無視 */ } }
async function bkOpen() {
  $('settings').hidden = true;
  $('bkSheet').hidden = false;
  $('bkReady').hidden = true; $('bkResult').textContent = '';
  const last = bkLast();
  $('bkLast').textContent = last ? `前にバックアップを保存した日時：${fmtDate(last.at)}（本 ${last.books}冊）` : 'この端末ではまだバックアップを保存していません。';
  bkSeg();
  bkUpdateEstimate();
  bkStorageInfo();
}
$('btnBackupHome').onclick = () => bkOpen();
$('btnBackupSettings').onclick = () => bkOpen();
$('btnCloseBk').onclick = () => { $('bkSheet').hidden = true; };
document.querySelectorAll<HTMLButtonElement>('[data-bkwhat]').forEach((b) => { b.onclick = () => { bkWhat = b.dataset.bkwhat as typeof bkWhat; bkSeg(); bkUpdateEstimate(false); }; });
document.querySelectorAll<HTMLButtonElement>('[data-bkmode]').forEach((b) => { b.onclick = () => { bkMode = b.dataset.bkmode as typeof bkMode; bkSeg(); }; });
$('bkPart').addEventListener('change', () => bkRenderTotal());
$('bkPersist').onclick = async () => {
  let ok = false;
  try { ok = await navigator.storage.persist(); } catch { /* 無視 */ }
  toast(ok ? '消されにくい保存にしました' : 'ブラウザが許可しませんでした（ホーム画面に追加したアプリでよく使うと許可されやすくなります）', 5000);
  bkStorageInfo();
};
function bkProg(label: string, done: number, total: number) {
  $('bkProgBox').hidden = false;
  ($('bkProg') as HTMLProgressElement).value = total ? Math.min(1, done / total) : 0;
  $('bkProgText').textContent = `${label}${total > 1 ? `（${Math.round(Math.min(1, done / total) * 100)}%）` : ''}`;
}
function bkError(msg: string, e: unknown) {
  console.error('[BACKUP]', msg, e);
  const mem = /memory|allocation|RangeError|QuotaExceeded/i.test(String((e as Error)?.message || e) + ((e as Error)?.name || ''));
  $('bkResult').textContent = `⚠ ${msg}${mem ? '（端末のメモリや空き容量が足りない可能性があります。「分けて保存」を小さくするか、他のアプリを閉じてからお試しください）' : ''}`;
  toast(msg, 6000);
}
function bkDownload(f: File) {
  const a = document.createElement('a');
  const u = URL.createObjectURL(f);
  a.href = u; a.download = f.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10 * 60000);
}
function bkMarkSaved(books: number) { localStorage.setItem(BK_LAST, JSON.stringify({ at: Date.now(), books })); $('bkLast').textContent = `前にバックアップを保存した日時：${fmtDate(Date.now())}（本 ${books}冊）`; }
const bkCanShare = (fs: File[]) => { try { return !!navigator.share && !!navigator.canShare?.({ files: fs }); } catch { return false; } };
/** できあがったファイルを1個ずつ保存するボタン。iPhone の共有シートは「ボタンを押した直後」でないと開けないので、押してもらってから開く */
function bkShowReady(files: File[], books: number) {
  const box = $('bkReadyBtns'); box.innerHTML = '';
  const share = bkCanShare(files);
  const n = files.length;
  $('bkReadyText').textContent = `できました：${n > 1 ? `${n}個のファイル・合計 ` : ''}${fmtSize(files.reduce((a, f) => a + f.size, 0))}。${share
    ? `下の「保存」ボタンを${n > 1 ? '1つずつ' : ''}押して、出てきた画面で「"ファイル"に保存」（またはGoogleドライブなど）を選んでください。`
    : `下の「保存」ボタンを${n > 1 ? '1つずつ' : ''}押すと、ダウンロードフォルダに保存されます。`}`;
  const st = document.createElement('p'); st.className = 'small'; st.setAttribute('aria-live', 'polite');
  const say = (t: string) => { st.textContent = t; $('bkResult').textContent = t; };
  const saved = new Set<number>();
  const done = (i: number, b: HTMLButtonElement, how: string) => {
    saved.add(i); b.classList.remove('primary'); b.textContent = `✅ ${n > 1 ? `${i + 1}/${n} ` : ''}${how}`;
    bkMarkSaved(books);
    say(saved.size >= n ? `✅ バックアップを保存しました（${n}個）。` : `${saved.size} / ${n} 個を保存しました。残りの「保存」ボタンも押してください。`);
  };
  files.forEach((f, i) => {
    const label = n > 1 ? `${i + 1}/${n} を保存` : '保存する';
    const b = document.createElement('button');
    b.className = 'wide-btn' + (i === 0 ? ' primary' : '');
    b.textContent = `${share ? '📤' : '⬇'} ${label}（${fmtSize(f.size)}）`;
    const nm = document.createElement('p'); nm.className = 'small bk-fname';
    nm.textContent = f.name;
    // 共有シートが使えない・うまくいかない時のための、ふつうのダウンロード
    const a = document.createElement('a');
    a.className = 'small'; a.textContent = '⬇ 共有でうまくいかない時はこちら（ダウンロード）';
    a.download = f.name;
    a.onclick = () => { if (!a.href) a.href = URL.createObjectURL(f); setTimeout(() => done(i, b, 'ダウンロードしました（ダウンロードフォルダ・「ファイル」アプリ）'), 300); };
    a.href = URL.createObjectURL(f);
    b.onclick = async () => {
      say('');
      if (!share) { a.click(); return; }
      try {
        await navigator.share({ files: [f] });
        done(i, b, '保存しました（共有シートで選んだ場所）');
      } catch (e) {
        const err = e as Error;
        console.warn('[BACKUP] share failed', err?.name, err?.message);
        if (err?.name === 'AbortError') say(`⚠ ${n > 1 ? `${i + 1}/${n} は` : ''}保存されていません（キャンセルされたか、共有シートが開けませんでした）。もう一度「${label}」を押すか、その下の「ダウンロード」を押してください。`);
        else { const m = `共有シートを開けませんでした：${err?.name || ''} ${err?.message || e}。その下の「ダウンロード」を押してください`; bkError(m, e); st.textContent = `⚠ ${m}`; }
      }
    };
    if (share) box.append(b, nm, a); else box.append(b, nm);
  });
  box.append(st);
}
$('bkMake').onclick = async () => {
  if (bkBusy) return;
  bkBusy = true; ($('bkMake') as HTMLButtonElement).disabled = true;
  $('bkReady').hidden = true;
  try {
    const t0 = performance.now();
    const files = await buildBackup({ books: bkWhat === 'books', bookIds: new Set(bkSel), shots: bkShotsOn, shrink: bkShrink(), partBytes: Number(($('bkPart') as HTMLSelectElement).value) * 1024 * 1024, build: BUILD, onProgress: bkProg });
    const books = bkWhat === 'books' ? bkSel.size : bkLast()?.books ?? 0;
    console.info(`[BACKUP] built ${files.map((f) => `${f.name} ${fmtSize(f.size)}`).join(', ')} in ${Math.round(performance.now() - t0)}ms`);
    // iPhone の共有シートに渡すファイルは、ひとつながりのメモリ上のデータにしておく
    // （本棚の Blob をつないだだけの File だと、共有シートが中身を読めず「何も起きない」ことがある）。ここで読めなければエラーを出す
    let ready = files;
    const sum = files.reduce((a, f) => a + f.size, 0);
    if (sum <= 200 * 1024 * 1024) {
      ready = [];
      for (let i = 0; i < files.length; i++) {
        bkProg(`保存の準備をしています（${i + 1} / ${files.length}）`, i, files.length);
        const f = files[i];
        const buf = await f.arrayBuffer();
        if (buf.byteLength !== f.size) throw new Error(`ファイルを最後まで読めませんでした（${f.name}）`);
        ready.push(new File([buf], f.name, { type: 'application/zip', lastModified: f.lastModified }));
      }
    }
    bkShowReady(ready, books);
    $('bkReady').hidden = false;
    $('bkProgBox').hidden = true;
    bkPersistQuiet();
  } catch (e) { bkError(`バックアップを作れませんでした：${(e as Error)?.message || e}`, e); $('bkProgBox').hidden = true; }
  finally { bkBusy = false; ($('bkMake') as HTMLButtonElement).disabled = false; }
};
$('bkRestore').onclick = () => { if (!bkBusy) $('bkInput').click(); };
$('bkInput').addEventListener('change', async (ev) => {
  const input = ev.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length || bkBusy) return;
  bkBusy = true;
  $('bkResult').textContent = '';
  try {
    const { manifest: m } = await inspectBackup(files[0]);
    const c = m.counts;
    const what = `${fmtDate(m.created)} に作ったバックアップ${m.parts > 1 ? `（${m.parts}個のうち ${files.length}個）` : ''}：本 ${files.length === 1 ? c.books : '複数'}冊${c.shots ? `・スクショ本の画像 ${c.shots}枚` : ''}・読み取り結果 ${c.pages}ページ分${c.localKeys ? '・設定/辞書/読書位置' : ''}`;
    const msg = bkMode === 'replace'
      ? `${what}\n\n今の本棚・設定・読み取り結果を消して、このバックアップと同じにします。よろしいですか？`
      : `${what}\n\n今のデータに足します（同じ本は重ねません）。よろしいですか？`;
    if (!confirm(msg)) return;
    stopPlayback();
    const t0 = performance.now();
    const r = await restoreBackup(files, bkMode, bkProg);
    console.info(`[BACKUP] restored ${JSON.stringify({ ...r, manifest: undefined })} in ${Math.round(performance.now() - t0)}ms`);
    const missing = r.manifest.parts > r.parts ? `\nこのバックアップは${r.manifest.parts}個に分かれています。残りのファイルも「復元」で読み込んでください（同じ方法を選べば、先に戻した分は消えません）。` : '';
    $('bkResult').textContent = `復元しました：本 ${r.books}冊${r.skippedBooks ? `（同じ本 ${r.skippedBooks}冊は重ねませんでした）` : ''}・読み取り結果 ${r.pages}ページ分${r.shots ? `・スクショ本の画像 ${r.shots}枚` : ''}・設定など ${r.localKeys}件。${missing} 少しあとに読み込み直します。`;
    await bkPersistQuiet();
    setTimeout(() => location.reload(), missing ? 6000 : 2500);
  } catch (e) { bkError(`復元できませんでした：${(e as Error)?.message || e}`, e); }
  finally { bkBusy = false; $('bkProgBox').hidden = true; }
});

// ---------------- 名前を変更 ----------------
// ファイルID（位置・OCR結果・修正のキー）は変えず、表示名・書籍名/巻・保存するファイル名だけを覚える（rename.ts）
const MTITLE = 'yomiage:mtitle:';
let docOrig: { name: string; book: BookName | null; fileName: string } | null = null;
/** 名前を変えていればそれ、無ければファイル名「NN.GrPDF.書籍名.pdf」から */
function effBook(id: string, fileName: string): BookName | null {
  const r = loadName(id);
  if (r) return r.mode === 'book' ? bookFor(r) : null;
  return parseBookName(fileName);
}
function applyName(d: LoadedDoc) {
  const r = loadName(d.id);
  if (!r) { if (docOrig && d === doc) { d.name = docOrig.name; d.book = docOrig.book; } return; }
  d.name = displayFor(r);
  d.book = r.mode === 'book' ? bookFor(r) : null;
}
/** 今の保存用ファイル名 */
function exportName(id: string, fileName: string): string {
  const r = loadName(id);
  return r ? fileNameFor(r, extOf(fileName)) : fileName;
}
async function shareOrDownload(file: File) {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  const u = URL.createObjectURL(file);
  a.href = u; a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
interface RenameTarget { id: string; fileName: string; files: number; getFile: () => Promise<File | null> }
let rnT: RenameTarget | null = null;
let rnMode: NameRec['mode'] = 'book';
let rnMetaTitle = '';
function rnRec(): NameRec {
  return { mode: rnMode, vol: ($('rnVol') as HTMLInputElement).value, title: ($('rnTitle') as HTMLInputElement).value, free: ($('rnFree') as HTMLInputElement).value };
}
function rnRender() {
  document.querySelectorAll<HTMLButtonElement>('[data-rnmode]').forEach((b) => { const on = b.dataset.rnmode === rnMode; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  $('rnBookBox').hidden = rnMode !== 'book';
  $('rnFreeBox').hidden = rnMode !== 'free';
  if (!rnT) return;
  const r = rnRec();
  const ok = rnMode === 'book' ? !!sanitize(r.title) : !!sanitize(r.free);
  const volBad = rnMode === 'book' && r.vol.trim() !== '' && !normVol(r.vol);
  $('rnPreview').textContent = ok
    ? `表示：${displayFor(r)}　／　ファイル名：${fileNameFor(r, extOf(rnT.fileName))}${volBad ? '　⚠ 巻No.は数字（例 3、3-2）で入れてください' : ''}`
    : (rnMode === 'book' ? '書籍名を入れてください' : '名前を入れてください');
  ($('rnSave') as HTMLButtonElement).disabled = !ok || volBad;
}
async function openRename(t: RenameTarget) {
  rnT = t;
  const cur = loadName(t.id);
  const fromFile = parseBookName(t.fileName);
  const base = t.fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  rnMode = cur?.mode || 'book';
  ($('rnVol') as HTMLInputElement).value = cur ? cur.vol : fromFile ? fromFile.vol : '';
  ($('rnTitle') as HTMLInputElement).value = cur ? cur.title : fromFile ? fromFile.title : sanitize(base);
  ($('rnFree') as HTMLInputElement).value = cur ? (cur.free || displayFor(cur)) : base;
  $('rnNow').textContent = `今の名前：${cur ? displayFor(cur) : (doc?.id === t.id && docOrig ? docOrig.name : t.fileName)}（元のファイル名：${t.fileName}）`;
  ($('rnReset') as HTMLButtonElement).disabled = !cur;
  $('rnExport').hidden = t.files !== 1;
  $('rnMeta').hidden = true;
  $('rnSheet').hidden = false;
  rnRender();
  // 本のタイトル（PDF の Info・ePub の dc:title）
  rnMetaTitle = (doc?.id === t.id ? doc.metaTitle : '') || localStorage.getItem(MTITLE + t.id) || '';
  if (!rnMetaTitle && t.files === 1) {
    try {
      const f = await t.getFile();
      if (f && rnT === t) {
        if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') rnMetaTitle = pdfInfoTitle(new Uint8Array(await f.arrayBuffer())) || '';
        else if (/\.epub$/i.test(f.name)) rnMetaTitle = await epubMetaTitle(await f.arrayBuffer());
        if (rnMetaTitle) localStorage.setItem(MTITLE + t.id, rnMetaTitle);
      }
    } catch (e) { console.warn('[RENAME] meta title', e); }
  }
  rnMetaTitle = sanitize(rnMetaTitle);
  if (rnT === t && rnMetaTitle) { $('rnMeta').hidden = false; $('rnMeta').textContent = `本のタイトルを使う（${rnMetaTitle}）`; }
}
document.querySelectorAll<HTMLButtonElement>('[data-rnmode]').forEach((b) => { b.onclick = () => { rnMode = b.dataset.rnmode as NameRec['mode']; rnRender(); }; });
for (const id of ['rnVol', 'rnTitle', 'rnFree']) $(id).addEventListener('input', rnRender);
$('rnMeta').onclick = () => {
  if (rnMode === 'book') ($('rnTitle') as HTMLInputElement).value = rnMetaTitle; else ($('rnFree') as HTMLInputElement).value = rnMetaTitle;
  rnRender();
};
$('btnCloseRn').onclick = () => { $('rnSheet').hidden = true; rnT = null; };
const trimKeyOf = (id: string, b: BookName | null) => (b ? `book:${b.title}` : `doc:${id}`);
/** 名前を変えた後の片付け：本棚の表示名・開いている本・書籍名ごとの切り取り設定 */
async function rnApplied(t: RenameTarget, oldBook: BookName | null, orig?: string) {
  const r = loadName(t.id);
  const newBook = r ? (r.mode === 'book' ? bookFor(r) : null) : parseBookName(t.fileName);
  const oldKey = trimKeyOf(t.id, oldBook), newKey = trimKeyOf(t.id, newBook);
  if (doc && doc.id === t.id) {
    applyName(doc);
    $('docName').textContent = doc.name;
  }
  if (oldKey !== newKey) {
    const has = (k: string) => localStorage.getItem('yomiage:trim:' + k) != null;
    if (has(oldKey) && !has(newKey)) {
      if (confirm(`切り取り・スマホ画面モードの設定を${newBook ? `新しい書籍名「${newBook.title}」` : 'このファイル'}にも引き継ぎますか？`)) saveTrim(newKey, loadTrim(oldKey));
    } else if (has(newKey) && newBook) toast(`「${newBook.title}」の切り取り設定（ほかの巻と共通）を使います`, 4000);
    if (doc && doc.id === t.id) { textCache.clear(); resolvedText.clear(); }
  }
  const pb = parseBookName(t.fileName);
  const name = r ? displayFor(r) : (orig || (doc?.id === t.id && docOrig ? docOrig.name : pb ? bookLabel(pb) : t.fileName));
  try { await renameRecent(t.id, name); } catch (e) { console.warn('[RENAME] recent', e); }
  if (!$('home').hidden) renderRecent();
}
$('rnSave').onclick = async () => {
  const t = rnT; if (!t) return;
  const oldBook = effBook(t.id, t.fileName);
  const r = rnRec();
  r.vol = normVol(r.vol); r.title = sanitize(r.title); r.free = sanitize(r.free).replace(new RegExp(`\\.${extOf(t.fileName)}$`, 'i'), '');
  const prevRec = loadName(t.id);
  r.orig = prevRec?.orig ?? (doc?.id === t.id && docOrig ? docOrig.name : (await getRecentRecord(t.id).catch(() => undefined))?.name);
  saveName(t.id, r);
  await rnApplied(t, oldBook);
  $('rnSheet').hidden = true; rnT = null;
  toast(`名前を「${displayFor(r)}」にしました`);
};
$('rnReset').onclick = async () => {
  const t = rnT; if (!t) return;
  const oldBook = effBook(t.id, t.fileName);
  const orig = loadName(t.id)?.orig;
  saveName(t.id, null);
  await rnApplied(t, oldBook, orig);
  $('rnSheet').hidden = true; rnT = null;
  toast('元の名前に戻しました');
};
$('rnExport').onclick = async () => {
  const t = rnT; if (!t) return;
  try {
    const f = await t.getFile();
    if (!f) throw new Error('ファイルが見つかりません（本棚から消えている可能性）');
    // まだ「この名前にする」を押していなくても、入力中の名前で保存する
    const r = rnRec();
    const ok = rnMode === 'book' ? !!sanitize(r.title) : !!sanitize(r.free);
    const name = ok ? fileNameFor(r, extOf(t.fileName)) : exportName(t.id, t.fileName);
    await shareOrDownload(new File([f], name, { type: f.type || (extOf(name) === 'epub' ? 'application/epub+zip' : 'application/pdf'), lastModified: Date.now() }));
  } catch (e) { showError(`ファイルを保存できませんでした：${(e as Error)?.message || e}`, e); }
};
$('btnRename').onclick = () => {
  if (!doc || !docFiles.length) return;
  const files = docFiles;
  openRename({ id: doc.id, fileName: docOrig?.fileName || files[0].name, files: files.length, getFile: async () => files[0] });
};

// ---------------- ファイルを開く ----------------
async function loadFiles(files: File[], isNew = true, opt: { screen?: boolean; how?: string; id?: string } = {}) {
  if (!files.length) return;
  stopPlayback();
  doc?.destroy?.();
  doc = null;
  pageRaw = null;
  textCache.clear();
  resolvedText.clear();
  imageCache.clear();
  loadedPage = -1;
  sentences = [];
  showView('reader');
  $('text').innerHTML = '';
  $('pageImg').innerHTML = '';
  $('docName').textContent = files[0].name;
  setStatus('ファイルを読み込み中…');
  try {
    doc = opt.screen ? openScreenshots(files) : await openFiles(files);
  } catch (e) {
    setStatus(null);
    console.error('[OPEN] failed', files.map((f) => `${f.name} ${f.type} ${f.size}B`).join(', '), e);
    showError(`開けませんでした：${(e as Error).message || e}`, e);
    return;
  }
  // バックアップで小さくして戻した PDF は大きさが元と違うので、本棚の ID（読書位置・読み取り結果のキー）を使う
  if (opt.id && doc.kind === 'pdf' && opt.id.startsWith('pdf|') && doc.id !== opt.id) { console.info(`[OPEN] shelf id ${opt.id} (file ${doc.id})`); doc.id = opt.id; }
  docFiles = files;
  // 普通に開いた画像でも、スマホの画面の比率（縦長・横長）ならスマホ画面モードにする（Android のスクリーンショットなども）
  if (doc.kind === 'image' && !doc.screen) {
    try {
      const c = await getImageOf(doc, 0);
      if (Math.max(c.width, c.height) / Math.min(c.width, c.height) >= 1.65) { doc.screen = true; console.info('[OPEN] phone-shaped images → screen OCR mode'); }
    } catch { /* 判定できなければそのまま */ }
  }
  fixes = loadFixes(doc.id);
  docOrig = { name: doc.name, book: doc.book ?? null, fileName: files[0].name };
  if (doc.metaTitle) try { localStorage.setItem(MTITLE + doc.id, doc.metaTitle); } catch { /* 無視 */ }
  applyName(doc);
  $('docName').textContent = doc.name;
  $('ocrBar').hidden = !doc.hasImages;
  ocrPdfReady = null; $('btnOcrPdf').textContent = '💾 文字入りPDF';
  $('btnOcrPdf').hidden = !(doc.kind === 'image' || doc.kind === 'pdf');
  updateOcrButtons();
  try {
    if (isNew) { await saveRecent(doc.id, doc.name, files); bkPersistQuiet(); } else await touchRecent(doc.id);
  } catch (e) { console.warn('[RECENT] could not save file (private browsing?)', e); /* 保存できなくても読むことはできる */ }
  const pos = loadPosition(doc.id);
  let page = 0;
  let sent = 0;
  if (pos && pos.page < doc.pageCount) {
    page = pos.page; sent = pos.sentence;
    if (page > 0 || sent > 0) toast(`前回の続き（${page + 1}${doc.unit === '枚目' ? '枚目' : doc.unit}）から`);
  } else if (opt.how && files.length > 1) toast(`スクショ${files.length}枚を${opt.how}に並べました`);
  await showPage(page, sent);
}

$('fileInput').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  loadFiles(files);
});
const pick = () => { unlockAll(); $('fileInput').click(); };
// ---------------- スクショから本を作る ----------------
// 何回かに分けて追加 → 並び順（ファイル名／撮影日時／取り込んだ順／手で並べた順）で並べ、重複・真っ黒/真っ白を除く
// → 「NN.GrPDF.書籍名.pdf」（多い時は「NN-1…」「NN-2…」に分ける）にして本棚へ。読み込みが終わった順には決して並べない
const SB_SPLIT_WARN = 200;
let sbBusy = false;
let sbItems: ShotItem[] = [];
let sbMode: SortMode = 'name-asc';
let sbSelKey: number | null = null;
let sbArrange = false;
const sbThumbUrl = new Map<number, string>();
let sbParts: { key: string; files: File[] } | null = null;
const sbTitle = () => ($('sbTitleIn') as HTMLInputElement).value;
const sbVolStr = () => ($('sbVol') as HTMLInputElement).value;
function sbFileName() { return grpdfName(sbVolStr(), sbTitle()); }
function sbPartName(k: number) { return grpdfName(sbVolStr(), sbTitle()).replace(/^(\d+)\./, `$1-${k}.`); }
function sbBookPages() { return sbItems.filter(sbInBook); }
function sbRanges() {
  const m = sbLoadMeta();
  return sbSplitRanges(sbBookPages().length, m.split, m.splitVal);
}
function sbSaveMeta() {
  const m = sbLoadMeta();
  m.title = sbTitle().trim();
  m.vol = Math.floor(Number(sbVolStr()) || 1);
  m.sort = sbMode;
  m.split = ($('sbSplit') as HTMLSelectElement).value as 'none' | 'every' | 'ranges';
  m.splitVal = ($('sbSplitVal') as HTMLInputElement).value.trim();
  sbStoreMeta(m);
  sbParts = null;
  sbNames();
}
function sbNames() {
  const r = sbRanges();
  $('sbName').textContent = r.length > 1 ? `ファイル名：${sbPartName(1)} ほか（${r.length}冊）` : `ファイル名：${sbFileName()}`;
  $('sbSplitNote').textContent = r.length > 1 ? `→ ${r.length}冊に分けます：${r.map(([a, b], k) => `${sbPartName(k + 1).replace(/\.GrPDF\..*$/, '')}（${a}〜${b}）`).join('、')}` : '';
}
function sbSortNote() {
  const it = sbItems;
  let note = `並び順：${SB_SORT_LABEL[sbMode]}`;
  if (sbMode.startsWith('name')) {
    note += '（番号は数の順：1, 2, …, 10, …）';
    if (!sbNamesUseful(it)) note += '。⚠ 同じ名前の画像があるため、その部分は取り込んだ順です（写真から選ぶと名前が「image.jpg」などになることがあります）。「撮影/保存日時」にするか、手で並べてください';
  } else if (sbMode.startsWith('time')) {
    const cnt = new Map<string, number>();
    for (const x of it) cnt.set(x.how, (cnt.get(x.how) || 0) + 1);
    note += `。日時の元：${[...cnt].map(([h, n]) => `${SB_HOW_LABEL[h as keyof typeof SB_HOW_LABEL]} ${n}枚`).join('、')}`;
    if (cnt.get('file')) note += '。⚠「ファイルの日時」はiPhoneでは取り込んだ時刻のことがあり、順番が正しくないことがあります';
  } else if (sbMode === 'import') note += '（選んだ回の順・選んだ画面での順）';
  $('sbSortNote').textContent = note;
}
function sbApply() {
  sbClassify(sbItems, sbMode);
  sbParts = null;
  sbRender();
}
function sbThumb(it: ShotItem) {
  let u = sbThumbUrl.get(it.key!);
  if (!u) { u = URL.createObjectURL(it.thumb); sbThumbUrl.set(it.key!, u); }
  return u;
}
function sbRender() {
  const box = $('sbThumbs'); box.innerHTML = '';
  const n = sbBookPages().length;
  const dup = sbItems.filter((x) => !sbInBook(x) && x.state === 'dup').length;
  const blank = sbItems.filter((x) => !sbInBook(x) && x.state === 'blank').length;
  const manual = sbItems.filter((x) => x.manual === 'out').length;
  $('sbSummary').textContent = sbItems.length
    ? `本に入るページ：${n}枚（追加した画像 ${sbItems.length}枚${dup ? `・重複 ${dup}` : ''}${blank ? `・空白 ${blank}` : ''}${manual ? `・手で外した ${manual}` : ''}）`
      + (sbMemoryMode() ? '（この端末では一時保存できないため、アプリを閉じると追加した画像は消えます。先に「本にして読む」を押してください）' : '')
    : 'まだ画像がありません。';
  ($('sbSort') as HTMLSelectElement).value = sbMode;
  sbSortNote();
  let page = 0;
  const frag = document.createDocumentFragment();
  sbItems.forEach((it, idx) => {
    const b = document.createElement('button');
    const inb = sbInBook(it);
    if (inb) page++;
    b.className = 'vthumb' + (inb ? '' : ' off') + (!inb && it.state === 'dup' && !it.manual ? ' dup' : '') + (!inb && it.state === 'blank' && !it.manual ? ' blank' : '') + (it.key === sbSelKey ? ' sel' : '');
    b.dataset.idx = String(idx);
    b.title = it.name;
    b.setAttribute('aria-label', `${inb ? `${page}ページ目` : '入れていない画像'}（${it.name}）`);
    const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.src = sbThumb(it); img.draggable = false;
    const sp = document.createElement('span'); sp.textContent = inb ? String(page) : '–';
    b.append(img, sp);
    frag.append(b);
  });
  box.append(frag);
  box.classList.toggle('arrange', sbArrange);
  ($('sbRead') as HTMLButtonElement).disabled = !n;
  ($('sbSave') as HTMLButtonElement).disabled = !n;
  sbNames();
  sbShowSel();
}
function sbShowSel() {
  const idx = sbItems.findIndex((x) => x.key === sbSelKey);
  $('sbActions').hidden = idx < 0;
  if (idx < 0) return;
  const it = sbItems[idx];
  const page = sbItems.slice(0, idx + 1).filter(sbInBook).length;
  const when = new Date(it.ts).toLocaleString('ja-JP');
  $('sbSel').textContent = `選択中：${sbInBook(it) ? `${page}ページ目` : '（本に入れていない）'}・${it.name}・${when}（${SB_HOW_LABEL[it.how]}）`;
  $('sbToggle').textContent = sbInBook(it) ? '本に入れない' : '本に入れる';
}
/** 並びを手で変える（今の並びを「手で並べた順」にしてから） */
async function sbMove(from: number, to: number) {
  if (from < 0 || from >= sbItems.length) return;
  to = Math.max(0, Math.min(sbItems.length - 1, to));
  if (sbMode !== 'manual') { sbFreeze(sbItems); sbMode = 'manual'; }
  const [it] = sbItems.splice(from, 1);
  sbItems.splice(to, 0, it);
  sbFreeze(sbItems);
  sbSaveMeta();
  sbApply();
  await sbPutMany(sbItems);
}
async function sbAdd(picked: File[]) {
  if (sbBusy || !picked.length) return;
  sbBusy = true; sbParts = null;
  const prog = $('sbProg') as HTMLProgressElement;
  $('sbProgBox').hidden = false;
  const skipped: string[] = [];
  try {
    // 選ばれた順（input.files の順）に番号を付けてから1枚ずつ処理（読み込みが終わった順には並べない）
    const files: File[] = [];
    for (const f of picked) {
      if (isZip(f)) {
        $('sbProgText').textContent = `zip を開いています：${f.name}`;
        try { files.push(...await unzipImages(f)); } catch (e) { skipped.push(`${f.name}（zipを開けません）`); console.warn('[SHOTBOOK] zip', e); }
      } else if (isImage(f)) files.push(f);
      else skipped.push(f.name);
    }
    const base = sbItems.reduce((m, x) => Math.max(m, x.seq), 0) + 1;
    let ok = 0;
    const t0 = performance.now();
    for (let i = 0; i < files.length; i++) {
      $('sbProgText').textContent = `取り込み中… ${i + 1} / ${files.length}（縮小して保存しています）`;
      prog.value = i / files.length;
      try { await sbPut(await sbPrepare(files[i], base + i)); ok++; } catch (e) { skipped.push(`${files[i].name}（${(e as Error)?.message || e}）`); console.warn('[SHOTBOOK] prepare failed', files[i].name, e); }
      files[i] = null as unknown as File; // 早めに手放す
    }
    console.info(`[SHOTBOOK] added ${ok}/${files.length} images in ${Math.round(performance.now() - t0)}ms`);
    sbItems = await sbList();
    sbApply();
    // ページが多い時は分けるのをすすめる（最初の1回は「150枚ごと」にしておく）
    const m = sbLoadMeta();
    if (sbBookPages().length > SB_SPLIT_WARN && (!m.split || m.split === 'none') && !m.splitOffered) {
      m.split = 'every'; m.splitVal = '150'; m.splitOffered = true; sbStoreMeta(m);
      ($('sbSplit') as HTMLSelectElement).value = 'every'; ($('sbSplitVal') as HTMLInputElement).value = '150';
      sbNames();
      toast(`ページが${SB_SPLIT_WARN}枚を超えたので、iPhoneの負担が少ないよう「150枚ごと」に分けて作るようにしました（「分けて作る」で変えられます）`, 8000);
    } else toast(`${ok}枚を追加しました${skipped.length ? `（読み込めなかったもの ${skipped.length}件：${skipped.slice(0, 3).join('、')}）` : ''}`, 5000);
  } catch (e) {
    showError(`画像を追加できませんでした：${(e as Error)?.message || e}`, e);
  } finally { sbBusy = false; $('sbProgBox').hidden = true; }
}
async function sbOpen() {
  $('sbSheet').hidden = false;
  const m = sbLoadMeta();
  ($('sbTitleIn') as HTMLInputElement).value = m.title || '';
  ($('sbVol') as HTMLInputElement).value = String(m.vol || 1);
  ($('sbSplit') as HTMLSelectElement).value = m.split || 'none';
  ($('sbSplitVal') as HTMLInputElement).value = m.splitVal || '';
  sbMode = m.sort || 'name-asc';
  try { sbItems = await sbList(); } catch (e) { console.warn('[SHOTBOOK] list failed', e); sbItems = []; }
  sbApply();
}
/** 本に入れるページの文字を読み取っておく（PDF に見えない文字として入れる → PDF だけでオフラインでも読める）。一度読んだページは覚えておく */
async function sbOcrPages(pages: ShotItem[]): Promise<{ done: number; failed: number }> {
  const res = { done: 0, failed: 0 };
  if (!($('sbOcr') as HTMLInputElement).checked || !pages.some((p) => p.ocr === undefined)) return res;
  const title = parseBookName(sbFileName())?.title || sbTitle().trim();
  const trim = loadTrim(`book:${title}`);
  const prog = $('sbProg') as HTMLProgressElement;
  $('sbProgBox').hidden = false;
  let prev: string | undefined;
  let streak = 0;
  try {
    for (let k = 0; k < pages.length; k++) {
      const it = pages[k];
      if (it.ocr !== undefined) { prev = it.ocr ? (it.ocr.skip ? it.ocr.raw : linesToText(it.ocr.lines).text) : undefined; continue; }
      $('sbProgText').textContent = `文字を読み取っています… ${k + 1} / ${pages.length}（PDFに文字を入れるため。次からは読み取り済みのページは飛ばします）`;
      prog.value = k / pages.length;
      try {
        const src = await createImageBitmap(it.blob);
        const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
        c.getContext('2d')!.drawImage(src, 0, 0); src.close();
        const r = await serverOcr(c, () => {}, settings.spread, trimQuery(trim));
        freeCanvas(c);
        const sk = screenSkip(k, r.lines, r.dropped, prev ?? '');
        const raw = linesToText(r.lines).text;
        it.ocr = { lines: sk.lines, width: r.width, height: r.height, skip: sk.skip, raw: sk.skip ? raw : undefined };
        prev = sk.skip ? raw : linesToText(sk.lines).text;
        await sbPut(it);
        res.done++; streak = 0;
      } catch (e) {
        res.failed++; streak++;
        console.warn('[SHOTBOOK] OCR failed', it.name, e);
        if (streak >= 3) { toast('サーバーで文字を読み取れないため、文字なしのPDFにします（読むときにOCRします）', 6000); break; }
      }
    }
  } finally { $('sbProgBox').hidden = true; }
  console.info(`[SHOTBOOK] OCR for PDF: ${res.done} pages, failed ${res.failed}`);
  return res;
}
/** 本のPDF（分ける時は複数）。画像は Blob をつなぐだけなので、何百枚でもメモリをほとんど使わない */
/** ocrAll：まだ読み取っていないページも読み取ってから作る（保存用）。「読む」の時は読み取り済みの分だけ入れて、残りは読みながら読み取る */
async function sbMakeParts(ocrAll = true): Promise<File[]> {
  const pages = sbBookPages();
  if (!pages.length) throw new Error('本に入るページがありません');
  const withText = ($('sbOcr') as HTMLInputElement).checked;
  if (withText && ocrAll) await sbOcrPages(pages);
  const ranges = sbRanges();
  const key = `${sbFileName()}|${JSON.stringify(ranges)}|${pages.map((p) => `${p.key}${withText && p.ocr ? 't' : ''}`).join(',')}`;
  if (sbParts?.key === key) return sbParts.files;
  const files = ranges.map(([a, b], k) => {
    const name = ranges.length > 1 ? sbPartName(k + 1) : sbFileName();
    const pp = pages.slice(a - 1, b).map((p) => ({ blob: p.blob, w: p.w, h: p.h, ocr: withText ? p.ocr : null }));
    return new File([sbMakePdfBlob(pp, name.replace(/\.pdf$/, ''))], name, { type: 'application/pdf', lastModified: Date.now() });
  });
  sbParts = { key, files };
  return files;
}
for (const id of ['shotInput', 'shotFileInput']) {
  $(id).addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    sbAdd(files);
  });
}
$('btnShot').onclick = () => { unlockAll(); sbOpen(); };
$('sbAddPhoto').onclick = () => $('shotInput').click();
$('sbAddFile').onclick = () => $('shotFileInput').click();
$('btnCloseSb').onclick = () => { $('sbSheet').hidden = true; };
for (const id of ['sbVol', 'sbTitleIn', 'sbSplitVal']) $(id).addEventListener('input', sbSaveMeta);
$('sbSplit').addEventListener('change', () => {
  const v = ($('sbSplit') as HTMLSelectElement).value;
  const inp = $('sbSplitVal') as HTMLInputElement;
  if (v === 'every' && !/^\d+$/.test(inp.value.trim())) inp.value = '150';
  if (v === 'ranges' && !/-/.test(inp.value)) { const n = sbBookPages().length; inp.value = `1-${Math.ceil(n / 2)},${Math.ceil(n / 2) + 1}-${n}`; }
  sbSaveMeta();
  const m = sbLoadMeta(); m.splitOffered = true; sbStoreMeta(m); // 自分で選んだ分け方は自動で変えない
});
$('sbSort').addEventListener('change', () => {
  const v = ($('sbSort') as HTMLSelectElement).value as SortMode;
  if (v === 'manual' && !sbItems.some((x) => x.pos != null)) sbFreeze(sbItems);
  sbMode = v; sbSaveMeta(); sbApply();
});
$('sbReverse').onclick = async () => {
  const flip: Partial<Record<SortMode, SortMode>> = { 'name-asc': 'name-desc', 'name-desc': 'name-asc', 'time-asc': 'time-desc', 'time-desc': 'time-asc' };
  if (flip[sbMode]) { sbMode = flip[sbMode]!; sbSaveMeta(); sbApply(); return; }
  sbItems.reverse(); sbFreeze(sbItems); sbMode = 'manual'; sbSaveMeta(); sbApply(); await sbPutMany(sbItems);
};
$('sbArrange').onclick = () => {
  sbArrange = !sbArrange;
  $('sbArrange').setAttribute('aria-pressed', String(sbArrange));
  $('sbThumbs').classList.toggle('arrange', sbArrange);
  if (sbArrange) toast('サムネイルを指で押さえたまま、入れたい場所まで動かしてください', 4000);
};
// タップで選択（並べ替えモードではドラッグ）
$('sbThumbs').addEventListener('click', (e) => {
  if (sbArrange) return;
  const el = (e.target as Element).closest<HTMLElement>('.vthumb');
  if (!el) return;
  const it = sbItems[Number(el.dataset.idx)];
  sbSelKey = sbSelKey === it.key ? null : it.key!;
  document.querySelectorAll('#sbThumbs .vthumb.sel').forEach((x) => x.classList.remove('sel'));
  if (sbSelKey != null) el.classList.add('sel');
  sbShowSel();
});
{
  let from = -1; let target = -1; let el: HTMLElement | null = null; let scrollTimer = 0; let lastY = 0;
  const grid = () => $('sbThumbs');
  const clearMarks = () => grid().querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  const at = (x: number, y: number) => {
    clearMarks();
    const t = document.elementFromPoint(x, y)?.closest<HTMLElement>('#sbThumbs .vthumb');
    if (!t) return;
    const r = t.getBoundingClientRect();
    const after = x > r.left + r.width / 2;
    const i = Number(t.dataset.idx);
    t.classList.add(after ? 'drop-after' : 'drop-before');
    target = after ? i + 1 : i;
  };
  grid().addEventListener('pointerdown', (e) => {
    if (!sbArrange) return;
    el = (e.target as Element).closest<HTMLElement>('.vthumb');
    if (!el) return;
    e.preventDefault();
    from = Number(el.dataset.idx); target = from;
    el.classList.add('dragging');
    lastY = e.clientY;
    // 端に近づいたら自動でスクロール
    scrollTimer = window.setInterval(() => {
      const r = grid().getBoundingClientRect();
      if (lastY < r.top + 40) grid().scrollTop -= 14; else if (lastY > r.bottom - 40) grid().scrollTop += 14;
    }, 30);
  });
  window.addEventListener('pointermove', (e) => { if (from < 0) return; lastY = e.clientY; at(e.clientX, e.clientY); });
  const end = async (ok: boolean) => {
    if (from < 0) return;
    clearInterval(scrollTimer); clearMarks(); el?.classList.remove('dragging');
    const f = from, t = target; from = -1; el = null;
    if (ok && t >= 0 && t !== f && t !== f + 1) await sbMove(f, t > f ? t - 1 : t);
  };
  window.addEventListener('pointerup', () => { end(true); });
  window.addEventListener('pointercancel', () => { end(false); });
}
const sbSelIdx = () => sbItems.findIndex((x) => x.key === sbSelKey);
$('sbPrevPos').onclick = () => { const i = sbSelIdx(); if (i > 0) sbMove(i, i - 1); };
$('sbNextPos').onclick = () => { const i = sbSelIdx(); if (i >= 0 && i < sbItems.length - 1) sbMove(i, i + 1); };
$('sbCover').onclick = async () => {
  const i = sbSelIdx(); if (i < 0) return;
  const it = sbItems[i];
  if (!sbInBook(it)) it.manual = it.state === 'ok' ? undefined : 'in';
  await sbMove(i, 0);
  toast('1ページ目（表紙）にしました');
};
$('sbMoveTo').onclick = async () => {
  const i = sbSelIdx(); if (i < 0) return;
  const pages = sbBookPages();
  const v = prompt(`何ページ目へ移動しますか？（1〜${pages.length}）`, '1');
  const k = Math.floor(Number(v));
  if (!v || !(k >= 1)) return;
  const dest = k > pages.length ? sbItems.length - 1 : sbItems.indexOf(pages[k - 1]);
  await sbMove(i, dest > i ? dest : dest);
};
$('sbToggle').onclick = async () => {
  const i = sbSelIdx(); if (i < 0) return;
  const it = sbItems[i];
  it.manual = sbInBook(it) ? 'out' : 'in';
  if ((it.manual === 'in' && it.state === 'ok') || (it.manual === 'out' && it.state !== 'ok')) it.manual = undefined;
  await sbPut(it);
  sbApply();
};
$('sbUnsel').onclick = () => { sbSelKey = null; sbRender(); };
$('sbRead').onclick = async () => {
  if (sbBusy) return;
  const btn = $('sbRead') as HTMLButtonElement; btn.disabled = true;
  try {
    sbSaveMeta();
    const parts = await sbMakeParts(false);
    const pages = sbBookPages();
    const ranges = sbRanges();
    const meta = sbLoadMeta();
    const built = meta.builtParts || {};
    const oldSig = meta.builtSig || {};
    const title = sbTitle().trim() || '無題';
    const vol = String(Math.floor(Number(sbVolStr()) || 1)).padStart(2, '0');
    const sameBook = new RegExp(`^${vol}(?:-\\d+)?\\.GrPDF\\.${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.pdf$`);
    let openIdx = 0; let newest = 0;
    const ids = parts.map((f) => docIdFor([f], 'pdf'));
    const newIds = new Set(ids);
    // 各冊の中身（どの画像がどの順で入っているか）。本の ID は「ファイル名＋大きさ」なので、並べ替えただけだと同じ ID になる
    const sigs = ranges.map(([a, b]) => pages.slice(a - 1, b).map((p) => p.key).join(','));
    // 同じ巻を作り直した時：中身（ページの並び）が前と全く同じ冊だけ、読んでいた位置を引き継ぐ。
    // 中身が変わった冊（並べ替え・分け方の変更・画像の追加）は、前の位置と読み取り結果（ページ番号ごと）を消して1ページ目から
    for (let k = 0; k < parts.length; k++) {
      const f = parts[k], newId = ids[k], count = ranges[k][1] - ranges[k][0] + 1;
      if (oldSig[f.name] !== sigs[k]) {
        try { await deleteRecent(newId); } catch (e) { console.warn('[SHOTBOOK] reset part failed', e); }
        console.info(`[SHOTBOOK] ${f.name}: pages changed → start from page 1`);
        continue;
      }
      const old = built[f.name];
      let pos = loadPosition(newId);
      if (!pos && old && old !== newId && (pos = loadPosition(old))) {
        pos = { ...pos, page: Math.min(pos.page, count - 1), sentence: pos.page >= count ? 0 : pos.sentence, pageCount: count };
        savePosition(newId, pos);
      }
      if (pos && (pos.page > 0 || pos.sentence > 0) && pos.updated > newest) { newest = pos.updated; openIdx = k; }
    }
    try {
      for (const r of await listRecent()) {
        const fn = r.files[0]?.name || '';
        if (newIds.has(r.id) || !sameBook.test(fn)) continue;
        await deleteRecent(r.id);
        console.info(`[SHOTBOOK] replaced ${r.id}`);
      }
    } catch (e) { console.warn('[SHOTBOOK] replace old failed', e); }
    meta.builtParts = Object.fromEntries(parts.map((f, k) => [f.name, ids[k]]));
    meta.builtSig = Object.fromEntries(parts.map((f, k) => [f.name, sigs[k]]));
    meta.built = ids[0]; meta.builtName = parts[0].name;
    sbStoreMeta(meta);
    // 開かない分も本棚に入れておく
    for (let k = 0; k < parts.length; k++) {
      if (k === openIdx) continue;
      const b = parseBookName(parts[k].name);
      try { await saveRecent(docIdFor([parts[k]], 'pdf'), b ? bookLabel(b) : parts[k].name, [parts[k]]); } catch (e) { console.warn('[SHOTBOOK] save part failed', e); }
    }
    console.info(`[SHOTBOOK] built ${parts.length} part(s): ${parts.map((f) => `${f.name} ${Math.round(f.size / 1024)}KB`).join(', ')}`);
    $('sbSheet').hidden = true;
    await loadFiles([parts[openIdx]]);
    if (parts.length > 1) toast(`${parts.length}冊に分けて本棚に入れました（${parts[openIdx].name}を開いています）`, 5000);
  } catch (e) { showError(`本を作れませんでした：${(e as Error)?.message || e}`, e); }
  finally { btn.disabled = false; }
};
$('sbSave').onclick = async () => {
  const btn = $('sbSave') as HTMLButtonElement;
  try {
    sbSaveMeta();
    const ready = !(($('sbOcr') as HTMLInputElement).checked && sbBookPages().some((p) => p.ocr === undefined)); // 読み取りで時間がかかるか
    const files = await sbMakeParts();
    if (navigator.canShare?.({ files })) {
      // iPhone：時間のかかる準備（文字の読み取り）のあとは共有シートを開けないので、もう一度押してもらう
      if (!ready) { btn.textContent = '📤 できました：押して保存'; toast('PDFができました。もう一度「保存」を押してください', 5000); return; }
      try { await navigator.share({ files, title: files[0].name }); btn.textContent = '💾 PDFを保存（ファイル・Googleドライブへ）'; return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
    }
    for (const file of files) {
      const a = document.createElement('a');
      const u = URL.createObjectURL(file);
      a.href = u; a.download = file.name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
      await sleep(400);
    }
  } catch (e) { showError(`PDFを保存できませんでした：${(e as Error)?.message || e}`, e); }
};
$('sbClear').onclick = async () => {
  if (!sbItems.length || !confirm('追加した画像を消して、次の本を始めますか？（作った本は本棚に残ります）')) return;
  await sbClearAll();
  sbThumbUrl.forEach((u) => URL.revokeObjectURL(u)); sbThumbUrl.clear();
  const m = sbLoadMeta(); m.vol = (m.vol || 1) + 1; m.built = undefined; m.builtName = undefined; m.builtParts = undefined; m.builtSig = undefined; m.splitOffered = false; sbStoreMeta(m);
  sbItems = []; sbParts = null; sbSelKey = null;
  await sbOpen();
};
// ---------------- 画面収録（動画）から読む ----------------
let vAbort: AbortController | null = null;
let vStatus: VideoStatus | null = null;
const vSkip = new Set<number>();
let vPdf: { key: string; file: File } | null = null;
$('vHelpBody').innerHTML = VIDEO_HELP_HTML;
const vShow = (mode: 'prog' | 'result' | 'help') => {
  $('videoSheet').hidden = false;
  $('vProgBox').hidden = mode !== 'prog';
  $('vResult').hidden = mode !== 'result';
  ($('vHelp') as HTMLDetailsElement).open = mode === 'help';
};
const vSetProg = (stage: string, v: number | null, note?: string) => {
  $('vStage').textContent = stage;
  const pr = $('vProg') as HTMLProgressElement;
  if (v == null) pr.removeAttribute('value'); else pr.value = v;
  if (note != null) $('vProgNote').textContent = note;
};
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)}MB`;
function vName(): string {
  return grpdfName(($('vVol') as HTMLInputElement).value, ($('vTitle') as HTMLInputElement).value);
}
function vRenderResult(s: VideoStatus) {
  vStatus = s; vPdf = null;
  const warnAt = new Set<number>();
  const pageAt = (t: number) => s.pages.find((p) => t >= p.start - 0.3 && t < p.end + 1.2)?.n;
  s.warnings.forEach((w) => { const n = pageAt(w.t); if (n) warnAt.add(n); });
  $('vSummary').textContent = `${s.pages.length}ページ見つかりました（動画 ${mmss(s.duration || 0)}${s.interval ? `・1ページ約${s.interval.toFixed(1)}秒` : ''}）。`;
  const ul = $('vWarn'); ul.innerHTML = '';
  for (const w of s.warnings) { const li = document.createElement('li'); li.textContent = `${mmss(w.t)} ${w.msg}`; ul.append(li); }
  const box = $('vThumbs'); box.innerHTML = '';
  for (const p of s.pages) {
    const b = document.createElement('button');
    b.className = 'vthumb' + (vSkip.has(p.n) ? ' off' : '') + (warnAt.has(p.n) ? ' warn' : '');
    b.setAttribute('aria-label', `${p.n}ページ目（${mmss(p.t)}）${vSkip.has(p.n) ? '外す' : '入れる'}`);
    const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.src = api(`/video/thumb/${s.id}/${p.n}.jpg`);
    const sp = document.createElement('span'); sp.textContent = String(p.n);
    b.append(img, sp);
    b.onclick = () => { if (vSkip.has(p.n)) vSkip.delete(p.n); else vSkip.add(p.n); b.classList.toggle('off', vSkip.has(p.n)); vPdf = null; };
    box.append(b);
  }
  const lt = lastTitle();
  const vol = $('vVol') as HTMLInputElement, ti = $('vTitle') as HTMLInputElement;
  if (!ti.value) ti.value = lt.title;
  if (!vol.value) vol.value = String(lt.title ? lt.vol + 1 : 1);
  $('vName').textContent = `ファイル名：${vName()}`;
  vShow('result');
}
async function vRun(file: File) {
  vAbort = new AbortController();
  vSkip.clear(); vPdf = null;
  ($('vVol') as HTMLInputElement).value = ''; ($('vTitle') as HTMLInputElement).value = '';
  $('vFile').textContent = `${file.name}（${mb(file.size)}）`;
  vShow('prog');
  try {
    const t0 = Date.now();
    const id = await uploadVideo(file, (sent, total) => {
      const sec = (Date.now() - t0) / 1000;
      vSetProg(`動画を送っています… ${Math.floor(sent / total * 100)}%（${mb(sent)} / ${mb(total)}）`, sent / total,
        sec > 3 && sent > 0 ? `送信中はこの画面のままにしてください。止まったら同じ動画を選び直すと続きから送ります。` : undefined);
    }, vAbort.signal);
    const s = await processVideo(id, (st) => {
      const stage = st.state === 'queued' ? '順番待ち…' : `${st.stage || '処理中'}… ${Math.floor((st.progress || 0) * 100)}%`;
      vSetProg(stage, st.progress || 0, 'サーバーで動画からページを取り出しています（30分の動画で数分かかります）。この画面を閉じても続きます。');
    }, vAbort.signal);
    console.info(`[VIDEO] ${s.id}: ${s.pages.length} pages, warnings ${s.warnings.length}, ${s.codec} ${s.width}x${s.height} ${s.duration}s`);
    vRenderResult(s);
  } catch (e) {
    if (vAbort?.signal.aborted) { $('videoSheet').hidden = true; return; }
    console.error('[VIDEO] failed', e);
    vSetProg(`できませんでした：${(e as Error).message}`, 0, '');
  } finally { vAbort = null; }
}
async function vMakePdf(): Promise<File> {
  const s = vStatus!;
  const name = vName();
  const skip = [...vSkip].sort((a, b) => a - b);
  const key = `${s.id}|${name}|${skip.join(',')}`;
  if (vPdf?.key === key) return vPdf.file;
  if (skip.length >= s.pages.length) throw new Error('ページが全部外されています');
  const file = await fetchPdf(s.id, name, skip);
  vPdf = { key, file };
  return file;
}
function vRemember() {
  const t = ($('vTitle') as HTMLInputElement).value.trim();
  if (t) rememberTitle(t, Math.floor(Number(($('vVol') as HTMLInputElement).value) || 1));
}
$('videoInput').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (f) vRun(f);
});
$('btnVideo').onclick = async () => {
  unlockAll();
  // 前回の処理が終わっていれば結果を出す（アプリを閉じても24時間はサーバーに残る）
  const prev = savedUpload();
  if (prev && !vAbort) {
    try {
      const s = await getStatus(prev.id);
      if (s.state === 'done' && confirm(`前回の動画「${prev.name}」の結果（${s.pages.length}ページ）を開きますか？\n「キャンセル」で新しい動画を選びます。`)) {
        $('vFile').textContent = prev.name; vRenderResult(s); return;
      }
      if (s.state === 'queued' || s.state === 'analyzing' || s.state === 'extracting') {
        $('vFile').textContent = prev.name; vShow('prog');
        vAbort = new AbortController();
        try { vRenderResult(await processVideo(prev.id, (st) => vSetProg(`${st.stage || '処理中'}… ${Math.floor((st.progress || 0) * 100)}%`, st.progress || 0), vAbort.signal)); }
        catch (e) { vSetProg(`できませんでした：${(e as Error).message}`, 0, ''); } finally { vAbort = null; }
        return;
      }
    } catch { /* 消えていれば新しく */ }
  }
  if (vAbort) { vShow('prog'); return; }
  $('videoInput').click();
};
$('lnkVideoHelp').onclick = (e) => { e.preventDefault(); $('vFile').textContent = ''; vShow('help'); $('vProgBox').hidden = true; };
$('btnCloseVideo').onclick = () => { $('videoSheet').hidden = true; };
$('vCancel').onclick = () => { vAbort?.abort(); $('videoSheet').hidden = true; };
$('vVol').addEventListener('input', () => { $('vName').textContent = `ファイル名：${vName()}`; });
$('vTitle').addEventListener('input', () => { $('vName').textContent = `ファイル名：${vName()}`; });
$('vRead').onclick = async () => {
  const btn = $('vRead') as HTMLButtonElement;
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'PDFを作っています…';
  try {
    const file = await vMakePdf();
    vRemember();
    $('videoSheet').hidden = true;
    await loadFiles([file]);
  } catch (e) { showError(`PDFを作れませんでした：${(e as Error).message}`, e); }
  finally { btn.disabled = false; btn.textContent = label; }
};
$('vSave').onclick = async () => {
  const s = vStatus; if (!s) return;
  vRemember();
  const skip = [...vSkip].sort((a, b) => a - b);
  const file = vPdf && vPdf.key === `${s.id}|${vName()}|${skip.join(',')}` ? vPdf.file : null;
  if (file && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  if (!file && typeof navigator.canShare === 'function') {
    // 共有シートはボタンを押した直後しか開けないので、先に作ってからもう一度押してもらう
    const btn = $('vSave') as HTMLButtonElement; btn.disabled = true; btn.textContent = 'PDFを準備しています…';
    try { await vMakePdf(); toast('準備できました。もう一度「PDFを保存」を押すと、保存先（ファイル・Googleドライブなど）を選べます。', 6000); }
    catch (e) { showError(`PDFを作れませんでした：${(e as Error).message}`, e); }
    finally { btn.disabled = false; btn.textContent = '💾 PDFを保存（ファイル・Googleドライブへ）'; }
    return;
  }
  // 共有が使えない端末：ダウンロード
  const a = document.createElement('a');
  a.href = pdfUrl(s.id, vName(), skip, true); a.download = vName();
  document.body.append(a); a.click(); a.remove();
};
$('btnOpenBig').onclick = pick;
$('btnOpenTop').onclick = pick;
$('btnHome').onclick = () => { stopPlayback(); showView('home'); };
// パソコン用：ドラッグ＆ドロップ
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length) loadFiles(files);
});

// ---------------- ページの文字を取得（テキスト or OCR） ----------------
function freeCanvas(c: HTMLCanvasElement) { c.width = 0; c.height = 0; }
/** そのページに元の画像があるか（ePubは文字の章と画像の章が混ざることがある） */
function pageHasImage(i: number): boolean {
  if (!doc) return false;
  return doc.pageHasImage ? doc.pageHasImage(i) : doc.hasImages;
}
/** 先頭の画像の大きさを調べる（判定用・キャッシュしない） */
async function getImageOf(d: LoadedDoc, i: number): Promise<{ width: number; height: number }> {
  const r = await d.getRawPage(i);
  if (!r.image) throw new Error('no image');
  const c = await r.image();
  const size = { width: c.width, height: c.height };
  c.width = 0; c.height = 0;
  return size;
}
function getImage(i: number): Promise<HTMLCanvasElement> {
  let p = imageCache.get(i);
  if (!p) {
    p = doc!.getRawPage(i).then((r) => {
      if (!r.image) throw new Error('画像がありません');
      return r.image();
    });
    p.catch(() => imageCache.delete(i));
    imageCache.set(i, p);
    // メモリ節約：今のページと次のページだけ保持し、捨てる画像はすぐ解放（iOS Safari はcanvasの合計メモリに上限がある）
    for (const [k, old] of imageCache) {
      if (k === i || k === i + 1) continue;
      imageCache.delete(k);
      old.then(freeCanvas).catch(() => undefined);
    }
  }
  return p;
}

function getPageText(i: number): Promise<PageData> {
  let p = textCache.get(i);
  if (!p) {
    const d = doc!;
    const mode = settings.ocrMode;
    const engine = settings.ocrEngine;
    p = (async (): Promise<PageData> => {
      const raw = await d.getRawPage(i);
      if (raw.ocr) { // PDF に入っていた読み取り結果（OCR しない）
        const o = raw.ocr;
        if (o.skip) return { text: '', lines: [], ranges: [], width: o.width, height: o.height, engine: 'ndl', skip: o.skip, raw: o.raw };
        const { text, ranges } = linesToText(o.lines);
        return { text, lines: o.lines, ranges, width: o.width, height: o.height, engine: 'ndl' };
      }
      if (raw.text !== null) return { text: raw.text };
      const label = `${i + 1}${d.unit === '枚目' ? '枚目' : d.unit}`;
      const progress = (pr: { label: string; progress: number }) => {
        if (doc === d && pageIdx === i) setStatus(`${label}：${pr.label}`, pr.progress);
      };
      const trim = loadTrim(trimKey(d));
      const screen = isScreen(d, trim);
      if (engine === 'server') {
        const spread = settings.spread;
        const key = serverKey(d, i);
        const cached = await getCachedPage(key);
        if (cached) return { text: cached.text, lines: cached.lines, ranges: cached.ranges, width: cached.width, height: cached.height, engine: 'ndl', crop: cached.crop, skip: cached.skip, raw: cached.raw };
        const canvas = await getImage(i);
        if (doc !== d) return { text: '' };
        try {
          const t0 = performance.now();
          const r = await serverOcr(canvas, progress, spread, screen ? trimQuery(trim) : false);
          const sk = screen ? screenSkip(i, r.lines, r.dropped) : { lines: r.lines } as { skip?: string; lines: OcrLine[] };
          const { text, ranges } = linesToText(sk.lines);
          console.info(`[OCR] page ${i + 1} NDLOCR-Lite ${r.lines.length} lines, spread=${r.spread}, server ${r.ms}ms, total ${Math.round(performance.now() - t0)}ms, vertical=${r.vertical}${sk.skip ? `, skip=${sk.skip}` : ''}`);
          const data: PageData = { text, lines: sk.lines, ranges, width: r.width, height: r.height, engine: 'ndl', crop: r.crop, skip: sk.skip, raw: sk.skip ? linesToText(r.lines).text : undefined };
          await putCachedPage(key, { ...data, method: 'ocr' });
          return data;
        } catch (e) {
          console.warn(`[OCR] page ${i + 1} server OCR failed → device OCR`, e);
          if (doc === d && pageIdx === i) toast('サーバーのOCRに接続できないため、端末内のOCR（精度は低め）を使います', 5000);
        }
      }
      const key = `${d.id}#${i}#${mode}-${settings.spread}${screen ? `-scr${trimSig(trim)}` : ''}`;
      const cached = await getCachedPage(key);
      if (cached) return { text: cached.text, engine: 'tesseract' };
      const canvas = await getImage(i);
      if (doc !== d) return { text: '' };
      // 見開きは右ページ→左ページの順に別々に読む
      const parts = splitSpread(screen ? cropForDevice(canvas, trim) : canvas, settings.spread);
      const texts: string[] = [];
      let conf = 0;
      let orient = '';
      for (const part of parts) {
        const prepared = prepareCanvas(part);
        const res = await ocrCanvas(prepared, mode, progress);
        freeCanvas(prepared);
        if (part !== canvas) freeCanvas(part);
        texts.push(res.text);
        conf += res.confidence / parts.length;
        orient = res.orientation;
      }
      const text = texts.join('\n');
      console.info(`[OCR] page ${i + 1} tesseract mode=${mode} parts=${parts.length} → ${orient} conf=${conf.toFixed(1)}`);
      await putCachedPage(key, { text, method: 'ocr', confidence: conf, orientation: orient as 'horizontal' | 'vertical' });
      return { text, engine: 'tesseract' };
    })();
    p.catch(() => textCache.delete(i));
    p.then((d) => { if (doc) resolvedText.set(i, d.skip ? d.raw || '' : d.text); }, () => undefined);
    textCache.set(i, p);
  }
  return p;
}

function prefetch(i: number) {
  if (!doc || i >= doc.pageCount || textCache.has(i)) return;
  getPageText(i).catch(() => undefined);
}

function pageLabel(i: number) {
  if (!doc) return '';
  return doc.unit === '枚目' ? `${i + 1}枚目 / ${doc.pageCount}枚` : `${i + 1} / ${doc.pageCount} ${doc.unit}`;
}

async function showPage(i: number, sent = 0): Promise<boolean> {
  if (!doc) return false;
  const d = doc;
  const token = ++pageToken;
  pageIdx = i;
  loadedPage = -1;
  sentences = [];
  pageData = null;
  pageRaw = null;
  sentLines = [];
  $('btnPageNo').textContent = pageLabel(i);
  $<HTMLButtonElement>('btnPrevPage').disabled = i <= 0;
  $<HTMLButtonElement>('btnNextPage').disabled = i >= d.pageCount - 1;
  $('text').innerHTML = '<p class="muted">読み込み中…</p>';
  renderImage(i);
  setStatus('文字を取り出し中…');
  let data: PageData;
  try {
    data = await getPageText(i);
  } catch (e) {
    if (token !== pageToken) return false;
    setStatus(null);
    console.error(`[PAGE] page ${i + 1} failed`, e);
    showError(`このページを読み取れませんでした：${(e as Error).message || e}`, e);
    loadedPage = i;
    return true;
  }
  if (token !== pageToken || doc !== d) return false;
  setStatus(null);
  pageRaw = data;
  applyView(i);
  loadedPage = i;
  sentIdx = sent < 0 ? Math.max(0, sentences.length - 1) : Math.min(sent, Math.max(0, sentences.length - 1));
  renderText();
  highlight(false);
  savePos();
  prefetch(i + 1);
  return true;
}

/** ページのデータに「文字の修正」と「一括置換」を当てた、表示・読み上げ用のデータを作る */
function pageView(i: number, data: PageData) {
  const page = fixes.pages[String(i)];
  if (data.lines && data.lines.length) {
    const r = applyToUnits(data.lines.map((l) => l.text), page, fixes.rules);
    const lines = data.lines.map((l, k) => ({ ...l, text: r.units[k] }));
    const { text, ranges } = linesToText(lines);
    return { view: { ...data, text, lines, ranges } as PageData, ranges, fixed: r.fixed, orig: r.orig, kind: '行' as const };
  }
  const paras = data.text.split('\n');
  const r = applyToUnits(paras, page, fixes.rules);
  let pos = 0;
  const ranges = r.units.map((u) => { const a = pos; pos += u.length + 1; return [a, a + u.length] as [number, number]; });
  return { view: { ...data, text: r.units.join('\n') } as PageData, ranges, fixed: r.fixed, orig: r.orig, kind: '段落' as const };
}

/** 今のページに修正を当て直して、文の区切りを作り直す */
function applyView(i: number) {
  if (!pageRaw) return;
  const pv = pageView(i, pageRaw);
  pageData = pv.view;
  unitRanges = pv.ranges;
  unitFixed = pv.fixed;
  unitOrig = pv.orig;
  unitKind = pv.kind;
  sentences = splitText(pv.view.text);
  sentLines = mapSentencesToLines(pv.view, sentences);
  sentStarts = [];
  let cursor = 0;
  for (const st of sentences) {
    let a = pv.view.text.indexOf(st.text, cursor);
    if (a < 0) a = cursor;
    sentStarts.push(a);
    cursor = a + st.text.length;
  }
}

/** 本文中の位置 → 単位（行・段落）の番号 */
function unitAt(offset: number): number {
  let best = -1, bestD = Infinity;
  unitRanges.forEach(([a, b], k) => {
    const d = offset < a ? a - offset : offset > b ? offset - b : 0;
    if (d < bestD) { bestD = d; best = k; }
  });
  return best;
}

async function renderImage(i: number) {
  const box = $('pageImg');
  box.innerHTML = '';
  box.classList.toggle('large', settings.imgLarge);
  if (!doc?.hasImages || !pageHasImage(i) || !settings.showImage) { box.hidden = true; return; }
  box.hidden = false;
  try {
    const c = await getImage(i);
    if (pageIdx !== i) return;
    const wrap = document.createElement('div');
    wrap.className = 'imgwrap';
    const img = document.createElement('img');
    img.alt = `${i + 1}ページ目の元の画像`;
    img.src = c.toDataURL('image/jpeg', 0.85);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${c.width} ${c.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('overlay');
    svg.setAttribute('aria-hidden', 'true');
    svg.dataset.w = String(c.width);
    svg.dataset.h = String(c.height);
    svg.addEventListener('click', onImageTap);
    wrap.append(img, svg);
    box.innerHTML = '';
    box.append(wrap);
    drawBoxes();
  } catch (e) { console.warn('[IMG] render failed', e); }
}

/** 文の位置と、OCRの行（枠）を対応づける */
function mapSentencesToLines(data: PageData, sents: Sentence[]): number[][] {
  if (!data.lines || !data.ranges) return [];
  const out: number[][] = [];
  let cursor = 0;
  for (const s of sents) {
    let start = data.text.indexOf(s.text, cursor);
    if (start < 0) start = data.text.indexOf(s.text.slice(0, 6), cursor);
    if (start < 0) { out.push([]); continue; }
    const end = start + s.text.length;
    cursor = end;
    const ids: number[] = [];
    data.ranges.forEach(([a, b], li) => { if (a < end && b > start) ids.push(li); });
    out.push(ids);
  }
  return out;
}

/** 画像の上に、今読んでいる文の行の枠を描く */
function drawBoxes() {
  const svg = document.querySelector<SVGSVGElement>('#pageImg svg.overlay');
  if (!svg) return;
  svg.innerHTML = '';
  const lines = pageData?.lines;
  if (!lines || !pageData?.width) return;
  const sx = Number(svg.dataset.w) / pageData.width;
  const sy = Number(svg.dataset.h) / (pageData.height || pageData.width);
  const cur = new Set(sentLines[sentIdx] || []);
  lines.forEach((l, li) => {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const [x, y, w, h] = l.box;
    r.setAttribute('x', String(x * sx)); r.setAttribute('y', String(y * sy));
    r.setAttribute('width', String(w * sx)); r.setAttribute('height', String(h * sy));
    r.setAttribute('class', cur.has(li) ? 'box cur' : 'box');
    svg.append(r);
  });
  // 今の行が画像の見える範囲に入るようにスクロール（大きい画像表示のとき）
  const first = svg.querySelector<SVGRectElement>('rect.cur');
  const box = $('pageImg');
  if (first && (box.scrollHeight > box.clientHeight + 4 || box.scrollWidth > box.clientWidth + 4)) {
    const br = box.getBoundingClientRect();
    const rr = first.getBoundingClientRect();
    if (rr.top < br.top || rr.bottom > br.bottom) box.scrollTop += rr.top - br.top - Math.max(8, (br.height - rr.height) * 0.15);
    if (rr.left < br.left || rr.right > br.right) box.scrollLeft += rr.left - br.left - (br.width - rr.width) * 0.6;
  }
}

/** 画像の行をタップ → その行を含む文から読む */
function onImageTap(ev: MouseEvent) {
  const svg = ev.currentTarget as SVGSVGElement;
  const lines = pageData?.lines;
  if (!lines || !pageData?.width) return;
  const rect = svg.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * pageData.width;
  const y = ((ev.clientY - rect.top) / rect.height) * (pageData.height || pageData.width);
  // 指でのタップは細い行からずれやすいので、いちばん近い行を選ぶ
  let li = -1;
  let bestD = Infinity;
  lines.forEach((l, k) => {
    const [bx, by, bw, bh] = l.box;
    const dx = Math.max(bx - x, 0, x - (bx + bw));
    const dy = Math.max(by - y, 0, y - (by + bh));
    const d = Math.hypot(dx, dy);
    if (d < bestD) { bestD = d; li = k; }
  });
  const typical = Math.min(...lines.map((l) => Math.min(l.box[2], l.box[3])));
  if (bestD > typical * 1.5) li = -1;
  if (li < 0) return;
  const si = sentLines.findIndex((ids) => ids.includes(li));
  if (si < 0) return;
  unlockAll();
  jump(pageIdx, si, true);
}

function showError(msg: string, e: unknown) {
  const art = $('text');
  art.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'errbox';
  const p = document.createElement('p');
  p.className = 'error';
  const name = (e as Error)?.name || '';
  const hint = name === 'InvalidPDFException' ? '（PDFが壊れているか、PDFではないファイルです）'
    : name === 'PasswordException' ? '（パスワード付きのPDFは開けません）'
    : /memory|allocation|RangeError/i.test(String((e as Error)?.message || e)) ? '（端末のメモリが足りない可能性があります。他のアプリを閉じてから、もう一度お試しください）'
    : '';
  p.textContent = msg + hint;
  const det = document.createElement('pre');
  det.className = 'errdetail';
  const err = e as Error;
  det.textContent = `build ${BUILD}\n${err?.name || ''} ${err?.message || String(e)}\n${(err?.stack || '').split('\n').slice(0, 6).join('\n')}`;
  const btn = document.createElement('button');
  btn.className = 'wide-btn';
  btn.textContent = '診断ログをコピー（不具合の報告用）';
  btn.onclick = copyDebug;
  div.append(p, det, btn);
  art.append(div);
}

async function debugText(): Promise<string> {
  return `${await environmentReport()}\n--- ログ ---\n${logText()}`;
}
async function copyDebug() {
  const t = await debugText();
  try { await navigator.clipboard.writeText(t); toast('診断ログをコピーしました'); }
  catch {
    // コピーできない場合は選択状態にして表示
    $('settings').hidden = false;
    const d = $('dbg') as HTMLDetailsElement; d.open = true;
    $('dbgText').textContent = t;
    toast('自動でコピーできませんでした。表示された文字を長押しでコピーしてください', 5000);
  }
}

function renderText() {
  const art = $('text');
  art.innerHTML = '';
  if (!sentences.length) {
    const why = pageRaw?.skip === 'warning' ? 'スクリーンショットの警告が写った画面なので読みません（次のページへ進みます）' : pageRaw?.skip === 'dup' ? '前のページと同じ画面なので読みません（次のページへ進みます）' : 'このページには読み上げる文字が見つかりませんでした';
    art.innerHTML = `<p class="muted">（${why}）</p>`;
    return;
  }
  let para = -1;
  let p: HTMLElement | null = null;
  sentences.forEach((s, idx) => {
    if (s.para !== para || !p) {
      p = document.createElement('p');
      art.append(p);
      para = s.para;
    }
    const span = document.createElement('span');
    span.className = 's';
    span.dataset.i = String(idx);
    span.textContent = s.text;
    const a = sentStarts[idx] ?? -1;
    if (a >= 0 && unitRanges.some(([ua, ub], k) => unitFixed[k] && ua < a + s.text.length && ub > a)) span.classList.add('fixed');
    p.append(span);
  });
}

function highlight(scroll = true) {
  document.querySelectorAll('.s.cur').forEach((e) => e.classList.remove('cur'));
  const el = document.querySelector<HTMLElement>(`.s[data-i="${sentIdx}"]`);
  updateInfo();
  drawBoxes();
  if (!el) return;
  el.classList.add('cur');
  if (!scroll) {
    if (sentIdx > 0) el.scrollIntoView({ block: 'center' });
    return;
  }
  const r = el.getBoundingClientRect();
  const bottomLimit = window.innerHeight - $('controls').offsetHeight - 24;
  // 上に固定表示しているページ画像の下端より下に見えるようにする
  const imgBox = $('pageImg');
  const topLimit = imgBox.hidden || !imgBox.firstChild ? 70 : imgBox.getBoundingClientRect().bottom + 8;
  if (r.top < topLimit || r.bottom > bottomLimit) {
    const visibleMid = topLimit + (bottomLimit - topLimit) * 0.3;
    window.scrollTo({ top: window.scrollY + r.top - visibleMid, behavior: 'smooth' });
  }
}

function updateInfo() {
  const total = sentences.length;
  $('ctlInfo').textContent = doc ? `${pageLabel(pageIdx)} ・ ${total ? sentIdx + 1 : 0} / ${total} 文` : '';
}

function savePos() {
  if (doc) savePosition(doc.id, { page: pageIdx, sentence: sentIdx, pageCount: doc.pageCount, updated: Date.now() });
}

// ---------------- 読み上げループ ----------------
function updatePlayBtn() {
  const b = $('btnPlay');
  b.querySelector('.ic')!.textContent = playing ? '⏸' : '▶';
  b.querySelector('.lb')!.textContent = playing ? '一時停止' : '再生';
  b.setAttribute('aria-label', playing ? '一時停止' : '再生');
}

async function runLoop(token: number) {
  while (token === playToken && playing && doc) {
    if (loadedPage !== pageIdx) {
      const ok = await showPage(pageIdx, sentIdx);
      if (token !== playToken) return;
      if (!ok) { await sleep(100); continue; }
    }
    if (sentIdx >= sentences.length) {
      if (pageIdx + 1 >= doc.pageCount) {
        playing = false;
        sentIdx = Math.max(0, sentences.length - 1);
        savePos();
        updatePlayBtn();
        releaseWake();
        toast('最後まで読み終わりました');
        return;
      }
      pageIdx++;
      sentIdx = 0;
      continue;
    }
    const s = sentences[sentIdx];
    highlight(true);
    savePos();
    if (!s.speakable) { sentIdx++; continue; }
    const r: SpeakResult = await speakSentence(s.text, sentIdx);
    if (token !== playToken) return;
    if (r === 'cancel') {
      // 他の要因（画面ロック・通話など）で止められた → 一時停止扱い（位置はそのまま）
      playing = false;
      updatePlayBtn();
      releaseWake();
      return;
    }
    if (r === 'error' || (r === 'timeout' && !engine().lastStarted)) {
      fails++;
      if (fails >= 3) {
        playing = false;
        updatePlayBtn();
        releaseWake();
        sentIdx = Math.max(0, sentIdx - 2);
        highlight(true);
        savePos();
        toast(server() ? `${ENGINE_NAME[settings.engine]}の音声を再生できませんでした（サーバーが止まっている可能性があります）。設定で「端末の声」に切り替えられます。` : speaker.jaVoices.length ? '音声を再生できませんでした。設定で別の声を選んでみてください。' : '音声を再生できませんでした。この端末・ブラウザには日本語の読み上げ音声が無いようです。', 6000);
        fails = 0;
        return;
      }
      await sleep(300);
    } else {
      fails = 0;
      if (settings.gap > 0) await sleep(settings.gap * 1000);
    }
    if (token !== playToken) return;
    sentIdx++;
  }
}

function play() {
  if (!doc) return;
  if (settings.engine === 'browser' && !speaker.supported) { toast('このブラウザは読み上げ（Web Speech API）に対応していません'); return; }
  unlockAll();
  playing = true;
  fails = 0;
  const token = ++playToken;
  updatePlayBtn();
  requestWake();
  setMediaSession();
  runLoop(token);
}

function stopPlayback() {
  playing = false;
  ++playToken;
  speaker.cancel();
  vv.cancel();
  av.cancel();
  updatePlayBtn();
  releaseWake();
}

/** 設定を変えた時など、今のページを読み取り直す（jump は同じページだと読み直さない） */
function reloadPage() {
  if (!doc) return;
  stopPlayback();
  loadedPage = -1;
  showPage(pageIdx, 0);
}
async function jump(page: number, sent: number, forcePlay?: boolean) {
  if (!doc) return;
  const wasPlaying = playing;
  stopPlayback();
  if (page !== loadedPage || page !== pageIdx) {
    const ok = await showPage(page, sent);
    if (!ok) return;
  } else {
    sentIdx = Math.max(0, Math.min(sent, sentences.length - 1));
    highlight(true);
    savePos();
  }
  if (forcePlay ?? wasPlaying) play();
}

$('btnPlay').onclick = () => { unlockAll(); if (playing) stopPlayback(); else play(); };
$('btnStop').onclick = () => { stopPlayback(); sentIdx = 0; highlight(false); window.scrollTo({ top: 0 }); savePos(); };
$('btnNext').onclick = () => {
  unlockAll();
  if (!doc) return;
  if (sentIdx + 1 < sentences.length) jump(pageIdx, sentIdx + 1);
  else if (pageIdx + 1 < doc.pageCount) jump(pageIdx + 1, 0);
};
$('btnPrev').onclick = () => {
  unlockAll();
  if (!doc) return;
  if (sentIdx > 0) jump(pageIdx, sentIdx - 1);
  else if (pageIdx > 0) jump(pageIdx - 1, -1);
};
$('btnPrevPage').onclick = () => { if (doc && pageIdx > 0) jump(pageIdx - 1, 0); };
$('btnNextPage').onclick = () => { if (doc && pageIdx + 1 < doc.pageCount) jump(pageIdx + 1, 0); };
$('btnPageNo').onclick = () => {
  if (!doc) return;
  const v = prompt(`移動先（1〜${doc.pageCount}）`, String(pageIdx + 1));
  const n = Number((v || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
  if (Number.isInteger(n) && n >= 1 && n <= doc.pageCount) jump(n - 1, 0);
};
// 文をタップ → そこから読む
$('text').addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.s');
  if (!el) return;
  unlockAll();
  jump(pageIdx, Number(el.dataset.i), true);
});

// 文字を長押しで選ぶ → 読み方辞書に登録 ／ この行の文字を修正
let selText = '';
let selUnit = -1;
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  const t = (sel?.toString() || '').replace(/\s+/g, '').trim();
  const inText = !!sel && sel.rangeCount > 0 && $('text').contains(sel.getRangeAt(0).commonAncestorContainer);
  const bar = $('selBar');
  if (inText && t && Array.from(t).length <= 40) {
    selText = t;
    // 選んだ位置（文の番号＋文の中の位置）から、本文中の位置 → 行を求める
    const r = sel!.getRangeAt(0);
    const node = r.startContainer;
    const span = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>('.s');
    selUnit = -1;
    if (span) {
      const si = Number(span.dataset.i);
      const off = node.nodeType === 3 ? r.startOffset : 0;
      selUnit = unitAt((sentStarts[si] ?? 0) + off);
    }
    $('btnSelDict').textContent = `「${t.length > 12 ? t.slice(0, 12) + '…' : t}」の読み方を登録`;
    $('btnSelFix').textContent = `✏️ この${unitKind}の文字を修正`;
    $('btnSelFix').hidden = selUnit < 0;
    bar.hidden = false;
    placeSelBar(r);
  } else if (!t) {
    bar.hidden = true;
  }
});
/** 選んだ文字を隠さない位置にボタンを出す（下に余裕があれば選択の下、なければ上。iPhoneのコピー等のメニューは選択の上に出るので、その分あける） */
function placeSelBar(r: Range) {
  const bar = $('selBar');
  const rect = r.getBoundingClientRect();
  const h = bar.offsetHeight || 120;
  const ctlTop = $('controls').hidden ? window.innerHeight : $('controls').getBoundingClientRect().top;
  const topMin = (document.querySelector('.topbar') as HTMLElement | null)?.getBoundingClientRect().bottom ?? 0;
  let top: number | null = null;
  if (rect.bottom + 24 + h < ctlTop - 8) top = rect.bottom + 24;
  else if (rect.top - 64 - h > topMin + 8) top = rect.top - 64 - h;
  if (top === null) { bar.style.top = ''; bar.style.bottom = ''; return; }
  top = Math.max(topMin + 8, Math.min(top, ctlTop - h - 8));
  bar.style.top = `${Math.round(top)}px`;
  bar.style.bottom = 'auto';
}
window.addEventListener('scroll', () => {
  const sel = document.getSelection();
  if (!$('selBar').hidden && sel && sel.rangeCount) placeSelBar(sel.getRangeAt(0));
}, { passive: true });
$('btnSelDict').addEventListener('click', () => {
  $('selBar').hidden = true;
  if (playing) stopPlayback();
  openDictWith(selText);
  document.getSelection()?.removeAllRanges();
});
$('btnSelFix').addEventListener('click', () => {
  $('selBar').hidden = true;
  if (playing) stopPlayback();
  const u = selUnit;
  document.getSelection()?.removeAllRanges();
  openFix(u, selText);
});
$('btnFix').addEventListener('click', () => {
  if (!pageRaw || !unitRanges.length) { toast('このページには直せる文字がありません'); return; }
  if (playing) stopPlayback();
  openFix(unitAt(sentStarts[sentIdx] ?? 0));
});

// ---------------- 文字の修正（スキャン・OCRの読み取り間違い） ----------------
let fixUnit = -1;
let fixShown = '';
function fixPageKey() { return String(pageIdx); }

function openFix(u: number, hint = '') {
  if (!doc || !pageRaw || u < 0 || u >= unitRanges.length) { toast('直す行が見つかりませんでした'); return; }
  fixUnit = u;
  const [a, b] = unitRanges[u];
  fixShown = pageData!.text.slice(a, b);
  const ta = $<HTMLTextAreaElement>('fixText');
  ta.value = fixShown;
  $('fixWhere').textContent = `${pageLabel(pageIdx)}・${u + 1}${unitKind}目（全${unitRanges.length}${unitKind}）${unitFixed[u] ? '・修正済み' : ''}`;
  $('fixOrigBox').hidden = !unitFixed[u];
  $('fixOrig').textContent = unitOrig[u];
  $('fixUndo').hidden = !unitFixed[u];
  $<HTMLButtonElement>('fixPrev').disabled = u <= 0;
  $<HTMLButtonElement>('fixNext').disabled = u >= unitRanges.length - 1;
  $<HTMLInputElement>('bFrom').value = hint && fixShown.includes(hint) ? hint : '';
  $<HTMLInputElement>('bTo').value = '';
  resetBulkPreview();
  renderRules();
  drawFixImage(u);
  $('settings').hidden = true;
  $('fixSheet').hidden = false;
  // 選んだ文字の位置にカーソルを置く
  setTimeout(() => {
    const pos = hint ? fixShown.indexOf(hint) : -1;
    if (pos >= 0) { ta.focus(); ta.setSelectionRange(pos, pos + hint.length); }
  }, 60);
}

/** この行の元の画像を、読みやすいように折り返して表示（縦書きは右から左へ並べる） */
async function drawFixImage(u: number) {
  const box = $('fixImgBox');
  box.hidden = true;
  const line = pageData?.lines?.[u];
  if (!line || !doc?.hasImages || !pageHasImage(pageIdx)) return;
  try {
    const src = await getImage(pageIdx);
    if (fixUnit !== u) return;
    const k = src.width / (pageData!.width || src.width);
    let [x, y, w, h] = line.box.map((v) => v * k);
    const vertical = h > w;
    const thick = vertical ? w : h;
    const pad = thick * 0.15;
    x = Math.max(0, x - pad); y = Math.max(0, y - pad);
    w = Math.min(src.width - x, w + pad * 2); h = Math.min(src.height - y, h + pad * 2);
    const seg = thick * 12; // 約12文字ずつ折り返す
    const len = vertical ? h : w;
    // 文字の途中で切れないよう、切れ目は文字と文字のすき間（インクの少ない所）を探す
    const cuts = [0];
    try {
      const tmp = document.createElement('canvas');
      tmp.width = Math.max(1, Math.round(w)); tmp.height = Math.max(1, Math.round(h));
      const tctx = tmp.getContext('2d', { willReadFrequently: true })!;
      tctx.drawImage(src, x, y, w, h, 0, 0, tmp.width, tmp.height);
      const d = tctx.getImageData(0, 0, tmp.width, tmp.height).data;
      const L = vertical ? tmp.height : tmp.width;
      const ink = new Float32Array(L);
      for (let yy = 0; yy < tmp.height; yy++) for (let xx = 0; xx < tmp.width; xx++) {
        const o = (yy * tmp.width + xx) * 4;
        const v = 255 - (d[o] * 0.3 + d[o + 1] * 0.59 + d[o + 2] * 0.11);
        ink[vertical ? yy : xx] += v;
      }
      tmp.width = 0; tmp.height = 0;
      let at = 0;
      while (len - at > seg * 1.15) {
        const t = at + seg;
        let best = Math.round(t), bestV = Infinity;
        for (let q = Math.round(t - thick * 0.7); q <= Math.round(t + thick * 0.2); q++) {
          if (q > at && q < L && ink[q] < bestV) { bestV = ink[q]; best = q; }
        }
        cuts.push(best);
        at = best;
      }
    } catch {
      for (let at = seg; at < len - seg * 0.15; at += seg) cuts.push(at);
    }
    cuts.push(len);
    const pieces = cuts.slice(1).map((e, j) => [cuts[j], e - cuts[j]] as [number, number]);
    const longest = Math.max(...pieces.map((p) => p[1]));
    const c = $<HTMLCanvasElement>('fixImg');
    const ctx = c.getContext('2d')!;
    if (vertical) {
      const n = pieces.length;
      const colW = w + thick * 0.4;
      c.width = Math.round(colW * n); c.height = Math.round(longest);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      pieces.forEach(([o, l], j) => ctx.drawImage(src, x, y + o, w, l, c.width - (j + 1) * colW, 0, w, l));
    } else {
      const n = pieces.length;
      const rowH = h + thick * 0.4;
      c.width = Math.round(longest); c.height = Math.round(rowH * n);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      pieces.forEach(([o, l], j) => ctx.drawImage(src, x + o, y, l, h, 0, j * rowH, l, h));
    }
    // 1文字がおよそ22px（CSS）になる大きさで表示
    const scale = 22 / thick;
    c.style.width = `${Math.round(c.width * scale)}px`;
    c.style.height = `${Math.round(c.height * scale)}px`;
    box.hidden = false;
  } catch (e) { console.warn('[FIX] image', e); }
}

/** 入力中の文字を保存（変わっていなければ何もしない）。保存したら true */
function saveFixUnit(showToast = true): boolean {
  if (!doc || fixUnit < 0) return false;
  const v = $<HTMLTextAreaElement>('fixText').value.replace(/\r?\n/g, '');
  if (v === fixShown) return false;
  const key = fixPageKey();
  const page = fixes.pages[key] || (fixes.pages[key] = {});
  if (v === unitOrig[fixUnit]) delete page[String(fixUnit)];
  else page[String(fixUnit)] = { orig: unitOrig[fixUnit], text: v, at: Date.now() };
  saveFixes(doc.id, fixes);
  console.info(`[FIX] page ${pageIdx + 1} ${unitKind} ${fixUnit + 1}: ${JSON.stringify(fixShown)} → ${JSON.stringify(v)}`);
  refreshAfterFix();
  if (showToast) toast('保存しました（表示と読み上げに反映）');
  return true;
}

/** 修正後に今のページを作り直す（読み上げ位置はなるべく保つ） */
function refreshAfterFix() {
  const keep = sentIdx;
  applyView(pageIdx);
  sentIdx = Math.min(keep, Math.max(0, sentences.length - 1));
  renderText();
  highlight(false);
  drawBoxes();
}

$('fixSave').onclick = () => {
  if (!saveFixUnit()) toast('変更はありません');
  openFix(fixUnit);
};
$('fixUndo').onclick = () => {
  if (!doc || fixUnit < 0) return;
  const page = fixes.pages[fixPageKey()];
  if (page) delete page[String(fixUnit)];
  saveFixes(doc.id, fixes);
  refreshAfterFix();
  toast('元の読み取り結果に戻しました');
  openFix(fixUnit);
};
$('fixPrev').onclick = () => { saveFixUnit(); openFix(fixUnit - 1); };
$('fixNext').onclick = () => { saveFixUnit(); openFix(fixUnit + 1); };
$('btnCloseFix').onclick = () => {
  const v = $<HTMLTextAreaElement>('fixText').value.replace(/\r?\n/g, '');
  if (v !== fixShown && confirm('直した文字を保存しますか？')) saveFixUnit();
  $('fixSheet').hidden = true;
};
// 入力に合わせて、一括置換の候補（違う部分）を入れておく
$('fixText').addEventListener('input', () => {
  const d = diffCore(fixShown, $<HTMLTextAreaElement>('fixText').value.replace(/\r?\n/g, ''));
  if (d && d.from) {
    $<HTMLInputElement>('bFrom').value = d.from;
    $<HTMLInputElement>('bTo').value = d.to;
    resetBulkPreview();
  }
});
['bFrom', 'bTo'].forEach((id) => $(id).addEventListener('input', resetBulkPreview));

function resetBulkPreview() {
  $('bResult').innerHTML = '';
  $<HTMLButtonElement>('bApply').disabled = true;
}

/** 本全体（読み取り済みのページ）の、今表示している形の文字を集める */
async function collectBook(): Promise<{ total: number; pages: Array<{ i: number; units: string[]; fixed: boolean[] }> }> {
  const d = doc!;
  const pages: Array<{ i: number; units: string[]; fixed: boolean[] }> = [];
  for (let i = 0; i < d.pageCount; i++) {
    let data: PageData | null = null;
    if (i === pageIdx && pageRaw) data = pageRaw;
    const p = textCache.get(i);
    if (!data && p) data = await Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 30))]);
    const imgPage = d.pageHasImage ? d.pageHasImage(i) : d.hasImages;
    if (!data && d.kind !== 'pdf' && !imgPage) {
      try { const raw = await d.getRawPage(i); if (raw.text !== null) data = { text: raw.text }; } catch { /* 無視 */ }
    }
    if (!data && imgPage) {
      const k1 = await getCachedPage(serverKey(d, i));
      const k2 = k1 ? null : await getCachedPage(`${d.id}#${i}#${settings.ocrMode}-${settings.spread}`);
      const c = k1 || k2;
      if (c) data = { text: c.text, lines: c.lines, ranges: c.ranges, width: c.width, height: c.height };
    }
    if (!data) continue;
    const pv = pageView(i, data);
    const us = pv.view.lines ? pv.view.lines.map((l) => l.text) : pv.view.text.split('\n');
    pages.push({ i, units: us, fixed: pv.fixed });
  }
  return { total: d.pageCount, pages };
}

$('bPreview').onclick = async () => {
  const from = $<HTMLInputElement>('bFrom').value;
  const to = $<HTMLInputElement>('bTo').value;
  const out = $('bResult');
  if (!from) { out.textContent = '「置き換える文字」を入れてください。'; return; }
  if (from === to) { out.textContent = '置き換える前と後が同じです。'; return; }
  out.textContent = '数えています…';
  const book = await collectBook();
  let n = 0, here = 0, pagesHit = 0;
  const samples: string[] = [];
  for (const pg of book.pages) {
    let hit = 0;
    pg.units.forEach((u, k) => {
      const c = replaceAllCount(u, from, to).n;
      if (!c) return;
      hit += c;
      if (samples.length < 5) {
        const at = u.indexOf(from);
        const pre = u.slice(Math.max(0, at - 8), at), post = u.slice(at + from.length, at + from.length + 8);
        samples.push(`${pg.i + 1}${doc!.unit === '枚目' ? '枚目' : 'ページ'}：…${esc(pre)}<mark>${esc(from)}</mark>→<mark>${esc(to)}</mark>${esc(post)}…`);
      }
    });
    if (hit) pagesHit++;
    if (pg.i === pageIdx) here = hit;
    n += hit;
  }
  const unread = book.total - book.pages.length;
  out.innerHTML = `<b>${n}か所</b>が変わります（${pagesHit}ページ。このページは${here}か所）。` +
    `<br>読み取り済み ${book.pages.length} / 全${book.total}${doc!.unit === '枚目' ? '枚' : 'ページ'}で数えました。` +
    (unread ? `まだ読み取っていない${unread}${doc!.unit === '枚目' ? '枚' : 'ページ'}にも、開いた時に同じように適用されます。` : '') +
    (samples.length ? `<ul>${samples.map((x) => `<li>${x}</li>`).join('')}</ul>` : '');
  $<HTMLButtonElement>('bApply').disabled = n === 0 && !unread;
  $<HTMLButtonElement>('bApply').dataset.n = String(n);
};

$('bApply').onclick = () => {
  if (!doc) return;
  const from = $<HTMLInputElement>('bFrom').value;
  const to = $<HTMLInputElement>('bTo').value;
  if (!from || from === to) return;
  // 入力中の行の修正を先に保存
  const typed = $<HTMLTextAreaElement>('fixText').value.replace(/\r?\n/g, '');
  if (typed !== fixShown) saveFixUnit(false);
  fixes.rules.push({ id: Math.random().toString(36).slice(2, 10), from, to, at: Date.now() });
  saveFixes(doc.id, fixes);
  refreshAfterFix();
  toast(`本全体に適用しました（${$('bApply').dataset.n || 0}か所）`);
  ($('fixBulk') as HTMLDetailsElement).open = false;
  openFix(fixUnit);
};

function renderRules() {
  const ul = $('bList');
  ul.innerHTML = '';
  $('bCount').textContent = fixes.rules.length ? `（${fixes.rules.length}件）` : '';
  $('bEmpty').hidden = fixes.rules.length > 0;
  fixes.rules.forEach((r) => {
    const li = document.createElement('li');
    const w = document.createElement('span');
    w.className = 'dw';
    w.style.flex = '1';
    w.textContent = `「${r.from}」→「${r.to}」`;
    const del = document.createElement('button');
    del.textContent = '元に戻す';
    del.setAttribute('aria-label', `一括置換「${r.from}」→「${r.to}」を元に戻す`);
    del.onclick = () => {
      if (!doc) return;
      fixes.rules = fixes.rules.filter((x) => x.id !== r.id);
      saveFixes(doc.id, fixes);
      refreshAfterFix();
      toast(`一括置換「${r.from}」→「${r.to}」を元に戻しました`);
      openFix(Math.min(fixUnit, unitRanges.length - 1));
    };
    li.append(w, del);
    ul.append(li);
  });
}

function esc(t: string) { return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }


// 画面に戻ってきた時、読み上げ中のはずなのに止まっていたら今の文から再開
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (playing) requestWake();
  if (playing && !engine().busy) {
    setTimeout(() => {
      if (playing && !engine().busy) { const t = ++playToken; runLoop(t); }
    }, 1200);
  }
});

// ---------------- 画面を消さない（Wake Lock） ----------------
let wake: { release(): Promise<void> } | null = null;
async function requestWake() {
  if (!settings.wakeLock || wake) return;
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void>; addEventListener(t: string, f: () => void): void }> } };
    const w = await nav.wakeLock?.request('screen');
    if (w) { wake = w; w.addEventListener('release', () => { wake = null; }); }
  } catch { /* 非対応・拒否 */ }
}
function releaseWake() { wake?.release().catch(() => undefined); wake = null; }

// ---------------- OCRの書字方向 ----------------
function updateOcrButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-ocr]').forEach((b) => {
    const on = b.dataset.ocr === settings.ocrMode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    b.setAttribute('aria-pressed', String(on));
  });
  $('btnToggleImg').textContent = settings.showImage ? '画像を隠す' : '画像を表示';
  $('btnImgSize').textContent = settings.imgLarge ? '画像を縮小' : '画像を拡大';
  $('btnImgSize').hidden = !settings.showImage;
  document.querySelectorAll<HTMLButtonElement>('[data-ocreng]').forEach((b) => {
    const on = b.dataset.ocreng === settings.ocrEngine;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-spread]').forEach((b) => {
    const on = b.dataset.spread === settings.spread;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll<HTMLElement>('.dirOnly').forEach((e) => { e.hidden = settings.ocrEngine !== 'device'; });
}
document.querySelectorAll<HTMLButtonElement>('[data-ocreng]').forEach((b) => {
  b.onclick = () => {
    const m = b.dataset.ocreng as Settings['ocrEngine'];
    if (m === settings.ocrEngine) return;
    settings.ocrEngine = m;
    saveSettings(settings);
    updateOcrButtons();
    textCache.clear();
    if (doc && doc.hasImages && !$('reader').hidden) reloadPage();
  };
});
document.querySelectorAll<HTMLButtonElement>('[data-spread]').forEach((b) => {
  b.onclick = () => {
    const m = b.dataset.spread as Settings['spread'];
    if (m === settings.spread) return;
    settings.spread = m;
    saveSettings(settings);
    updateOcrButtons();
    textCache.clear();
    if (doc && doc.hasImages && !$('reader').hidden) reloadPage();
  };
});
// ---------- 画面の切り取り（スマホのスクリーンショット） ----------
let trimEdit: Trim | null = null;
let trimImg: HTMLCanvasElement | null = null;
const TRIM_SIDES = [['trimTop', 'top'], ['trimBottom', 'bottom'], ['trimLeft', 'left'], ['trimRight', 'right']] as const;
function drawTrim() {
  const t = trimEdit, src = trimImg;
  if (!t) return;
  document.querySelectorAll<HTMLButtonElement>('[data-tmode]').forEach((b) => b.classList.toggle('on', b.dataset.tmode === t.mode));
  document.querySelectorAll<HTMLButtonElement>('[data-tscreen]').forEach((b) => b.classList.toggle('on', b.dataset.tscreen === t.screen));
  $<HTMLFieldSetElement>('trimManual').disabled = t.mode !== 'manual';
  for (const [id, k] of TRIM_SIDES) { $<HTMLInputElement>(id).value = String(t[k]); $(`${id}Out`).textContent = `${t[k]}%`; }
  const c = $<HTMLCanvasElement>('trimCanvas');
  if (!src) { c.hidden = true; return; }
  c.hidden = false;
  const k = Math.min(1, 520 / src.height);
  c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  // 読む範囲（手動の値、自動なら直前のOCRで見つけた範囲）
  let r: [number, number, number, number] | null = null;
  if (t.mode === 'manual') r = [c.width * t.left / 100, c.height * t.top / 100, c.width * (1 - t.right / 100), c.height * (1 - t.bottom / 100)];
  else if (pageData?.crop && pageData.width) { const s = c.width / pageData.width; r = [pageData.crop[0] * s, pageData.crop[1] * s, pageData.crop[2] * s, pageData.crop[3] * s]; }
  $('trimNote').textContent = t.mode === 'manual' ? '暗い部分は読みません。' : r ? '自動で見つけた範囲です（暗い部分は読みません）。' : '自動：読み取りの時に、上のステータスバーと下のホームバーを見つけて除きます。';
  if (!r) return;
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(0, 0, c.width, r[1]);
  ctx.fillRect(0, r[3], c.width, c.height - r[3]);
  ctx.fillRect(0, r[1], r[0], r[3] - r[1]);
  ctx.fillRect(r[2], r[1], c.width - r[2], r[3] - r[1]);
  ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 2;
  ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
}
$('btnTrim').onclick = async () => {
  if (!doc) return;
  const d = doc;
  trimEdit = loadTrim(trimKey(d));
  $('trimFor').textContent = d.book ? `「${d.book.title}」の全巻に使います。` : `このファイル（${d.name}）に使います。`;
  trimImg = null;
  drawTrim();
  $('trimSheet').hidden = false;
  try { if (pageHasImage(pageIdx)) { trimImg = await getImage(pageIdx); drawTrim(); } } catch { /* 画像なし */ }
};
$('btnCloseTrim').onclick = () => { $('trimSheet').hidden = true; trimImg = null; };
document.querySelectorAll<HTMLButtonElement>('[data-tmode]').forEach((b) => { b.onclick = () => { if (trimEdit) { trimEdit.mode = b.dataset.tmode as Trim['mode']; drawTrim(); } }; });
document.querySelectorAll<HTMLButtonElement>('[data-tscreen]').forEach((b) => { b.onclick = () => { if (trimEdit) { trimEdit.screen = b.dataset.tscreen as Trim['screen']; drawTrim(); } }; });
for (const [id, k] of TRIM_SIDES) $<HTMLInputElement>(id).oninput = (e) => { if (trimEdit) { trimEdit[k] = Number((e.target as HTMLInputElement).value); drawTrim(); } };
$('trimReset').onclick = () => { trimEdit = { mode: 'auto', top: 5, bottom: 4, left: 0, right: 0, screen: 'auto' }; drawTrim(); };
$('trimSave').onclick = () => {
  if (!doc || !trimEdit) return;
  saveTrim(trimKey(doc), trimEdit);
  console.info(`[TRIM] ${trimKey(doc)} ${JSON.stringify(trimEdit)}`);
  $('trimSheet').hidden = true;
  trimImg = null;
  textCache.clear();
  toast('切り取りを保存しました。このページから読み直します');
  reloadPage();
};

$('btnImgSize').onclick = () => {
  settings.imgLarge = !settings.imgLarge;
  saveSettings(settings);
  updateOcrButtons();
  $('pageImg').classList.toggle('large', settings.imgLarge);
  drawBoxes();
};
document.querySelectorAll<HTMLButtonElement>('[data-ocr]').forEach((b) => {
  b.onclick = () => {
    const m = b.dataset.ocr as OcrMode;
    if (m === settings.ocrMode) return;
    settings.ocrMode = m;
    saveSettings(settings);
    updateOcrButtons();
    textCache.clear();
    if (doc && doc.hasImages && !$('reader').hidden) reloadPage();
  };
});
$('btnToggleImg').onclick = () => {
  settings.showImage = !settings.showImage;
  saveSettings(settings);
  $<HTMLInputElement>('chkImg').checked = settings.showImage;
  updateOcrButtons();
  renderImage(pageIdx);
};

// ---------------- 設定画面 ----------------
function fillVoices() {
  const sel = $<HTMLSelectElement>('voiceSel');
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = `自動（${speaker.preferred()?.name || '端末の既定の日本語音声'}）`;
  sel.append(def);
  for (const v of speaker.jaVoices) {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = `${v.name}${/o[-‐‑ ]?ren|オーレン/i.test(v.name) ? '（おすすめ）' : ''}${v.localService === false ? '（オンライン）' : ''}`;
    sel.append(o);
  }
  sel.value = settings.voiceURI && speaker.jaVoices.some((v) => v.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
  const note = $('voiceNote');
  if (!speaker.supported) note.textContent = 'このブラウザは読み上げに対応していません。';
  else if (!speaker.jaVoices.length) note.textContent = `日本語の音声が見つかりません（全音声 ${speaker.voices.length} 件）。iPhoneでは「設定 → アクセシビリティ → 読み上げコンテンツ → 声 → 日本語」で声を追加できます。`;
  else note.textContent = `日本語の音声 ${speaker.jaVoices.length} 件。※Siriの声はWebアプリからは使えません。`;
}
speaker.onVoicesChanged = fillVoices;

// ---------- VOICEVOX / AivisSpeech ----------
function creditOf(): { short: string; full: string } | null {
  const srv = server();
  if (!srv || !srv.eng.available) return null;
  const ch = srv.eng.characterOf(srv.spk);
  if (!ch) return null;
  if (settings.engine === 'aivis') return aivisCredit(ch);
  return { short: `VOICEVOX:${ch}`, full: `VOICEVOX:${ch}（キャラクターごとの利用規約に従ってください）` };
}
function fillVv() {
  const srv = server();
  if (!srv) return;
  const { eng, spk } = srv;
  const name = ENGINE_NAME[settings.engine];
  $('vvLabel').textContent = `${name}の声`;
  const sel = $<HTMLSelectElement>('vvSel');
  sel.innerHTML = '';
  for (const st of eng.styles) {
    const o = document.createElement('option');
    o.value = String(st.id);
    o.textContent = st.label;
    sel.append(o);
  }
  if (eng.styles.some((s) => s.id === spk)) sel.value = String(spk);
  else if (eng.styles.length) {
    // 保存していた声が無ければ先頭（おすすめ順）を選ぶ
    if (settings.engine === 'aivis') settings.aivisSpeaker = eng.styles[0].id; else settings.vvSpeaker = eng.styles[0].id;
    sel.value = String(eng.styles[0].id);
  }
  const note = $('vvNote');
  const c = creditOf();
  if (eng.available === null) note.textContent = `${name}に接続中…`;
  else if (!eng.available) note.textContent = `${name}のサーバーに接続できません（${usingRemoteServer() ? '設定の「サーバーURL」が古いか、' : 'このアプリの配信元で'}${name} Engineが動いていない可能性があります）。「端末の声」を使ってください。`;
  else note.textContent = `クレジット：${c?.full ?? ''}　※音声は配信元サーバーで作られるため、通信が必要です。`;
}
function updateCredit() {
  $('credit').textContent = creditOf()?.short ?? '';
}
function updateEngineUI() {
  document.querySelectorAll<HTMLButtonElement>('#engineSeg button').forEach((b) => {
    const on = b.dataset.engine === settings.engine;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('browserBox').hidden = settings.engine !== 'browser';
  $('vvBox').hidden = settings.engine === 'browser';
  syncSliders();
  fillVv();
  updateCredit();
}
document.querySelectorAll<HTMLButtonElement>('#engineSeg button').forEach((b) => {
  b.onclick = async () => {
    stopPlayback();
    settings.engine = b.dataset.engine as Settings['engine'];
    saveSettings(settings);
    const srv = server();
    if (srv) { srv.eng.unlock(); if (!srv.eng.available) { srv.eng.available = null; updateEngineUI(); await srv.eng.load(); } }
    updateEngineUI();
  };
});
$<HTMLSelectElement>('vvSel').onchange = (e) => {
  const id = Number((e.target as HTMLSelectElement).value);
  if (settings.engine === 'aivis') settings.aivisSpeaker = id; else settings.vvSpeaker = id;
  saveSettings(settings);
  fillVv();
  updateCredit();
};
vv.load().then(() => { fillVv(); updateCredit(); });
av.load().then(() => { fillVv(); updateCredit(); });

// ---------- 音声の診断 ----------
function renderDiag() {
  speaker.refreshVoices();
  const body = $('diagBody');
  body.innerHTML = '';
  const head = document.createElement('p');
  head.textContent = speaker.supported
    ? `全部で ${speaker.voices.length} 件（日本語 ${speaker.jaVoices.length} 件）。ブラウザ：${navigator.userAgent}`
    : 'このブラウザは speechSynthesis に対応していません。';
  body.append(head);
  const sorted = [...speaker.voices].sort((a, b) => Number((b.lang || '').startsWith('ja')) - Number((a.lang || '').startsWith('ja')));
  for (const v of sorted) {
    const div = document.createElement('div');
    div.className = 'v' + ((v.lang || '').replace('_', '-').toLowerCase().startsWith('ja') ? ' ja' : '');
    const dl = document.createElement('dl');
    for (const [k, val] of [['名前', v.name], ['言語', v.lang], ['端末内', String(v.localService)], ['既定', String(v.default)], ['voiceURI', v.voiceURI]]) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = val;
      dl.append(dt, dd);
    }
    div.append(dl);
    body.append(div);
  }
}
$('diag').addEventListener('toggle', () => { if (($('diag') as HTMLDetailsElement).open) renderDiag(); });
$('btnDiagRefresh').onclick = renderDiag;

// ---------- 画面ロック画面などの操作（Media Session） ----------
function setMediaSession() {
  const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
  if (!ms || !doc) return;
  try {
    ms.metadata = new MediaMetadata({ title: doc.name, artist: 'よみあげ' });
    ms.setActionHandler('play', () => { if (!playing) play(); });
    ms.setActionHandler('pause', () => { if (playing) stopPlayback(); });
    ms.setActionHandler('nexttrack', () => $('btnNext').click());
    ms.setActionHandler('previoustrack', () => $('btnPrev').click());
  } catch { /* 非対応 */ }
}

function syncSettingsUI() {
  fillVoices();
  updateEngineUI();
  syncSliders();
  renderDict();
  $<HTMLInputElement>('rate').value = String(settings.rate);
  $('rateOut').textContent = `${settings.rate.toFixed(2)}倍`;
  $<HTMLInputElement>('pitch').value = String(settings.pitch);
  $('pitchOut').textContent = settings.pitch.toFixed(2);
  $<HTMLInputElement>('font').value = String(settings.fontSize);
  $('fontOut').textContent = `${settings.fontSize}px`;
  $<HTMLInputElement>('chkImg').checked = settings.showImage;
  $<HTMLInputElement>('chkWake').checked = settings.wakeLock;
  document.querySelectorAll<HTMLButtonElement>('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === settings.theme));
  updateOcrButtons();
}

$('btnSettings').onclick = () => { unlockAll(); speaker.refreshVoices(); syncSettingsUI(); syncServerUI(); $('settings').hidden = false; $('btnCloseSettings').focus(); };
$('btnCloseSettings').onclick = () => { $('settings').hidden = true; };
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });
$<HTMLSelectElement>('voiceSel').onchange = (e) => { settings.voiceURI = (e.target as HTMLSelectElement).value || null; saveSettings(settings); };
$<HTMLInputElement>('rate').oninput = (e) => { settings.rate = Number((e.target as HTMLInputElement).value); $('rateOut').textContent = `${settings.rate.toFixed(2)}倍`; saveSettings(settings); };
$<HTMLInputElement>('pitch').oninput = (e) => { settings.pitch = Number((e.target as HTMLInputElement).value); $('pitchOut').textContent = settings.pitch.toFixed(2); saveSettings(settings); };
$<HTMLInputElement>('font').oninput = (e) => { settings.fontSize = Number((e.target as HTMLInputElement).value); $('fontOut').textContent = `${settings.fontSize}px`; applyTheme(); saveSettings(settings); };
$<HTMLInputElement>('chkImg').onchange = (e) => { settings.showImage = (e.target as HTMLInputElement).checked; saveSettings(settings); updateOcrButtons(); if (doc) renderImage(pageIdx); };
$<HTMLInputElement>('chkWake').onchange = (e) => { settings.wakeLock = (e.target as HTMLInputElement).checked; saveSettings(settings); if (!settings.wakeLock) releaseWake(); };
document.querySelectorAll<HTMLButtonElement>('#themeSeg button').forEach((b) => {
  b.onclick = () => { settings.theme = b.dataset.theme as Settings['theme']; saveSettings(settings); applyTheme(); syncSettingsUI(); };
});
$('btnTest').onclick = async () => {
  unlockAll();
  const wasPlaying = playing;
  if (wasPlaying) stopPlayback();
  const t = applyDict($<HTMLInputElement>('testText').value.trim() || 'こんにちは。これは読み上げのテストです。');
  const r = await previewSpeak(t);
  if (r === 'error' || (r === 'timeout' && !engine().lastStarted)) toast('音声を再生できませんでした');
  else if (server() && r === 'end') toast(`合成にかかった時間：約${(server()!.eng.lastLatency / 1000).toFixed(1)}秒`);
};
async function previewSpeak(t: string): Promise<SpeakResult> {
  speaker.cancel(); vv.cancel(); av.cancel();
  const srv = server();
  return srv ? srv.eng.speak(t, srv.spk, speakOpts()) : speaker.speak(t, speakOpts());
}

// ---------- 抑揚など ----------
const sliders: Array<[keyof Settings, (v: number) => string]> = [
  ['intonation', (v) => v.toFixed(2)],
  ['volume', (v) => v.toFixed(2)],
  ['pause', (v) => `${v.toFixed(2)}倍`],
  ['gap', (v) => `${v.toFixed(1)}秒`],
];
for (const [k, fmt] of sliders) {
  $<HTMLInputElement>(k).oninput = (e) => {
    (settings as unknown as Record<string, number>)[k] = Number((e.target as HTMLInputElement).value);
    $(`${k}Out`).textContent = fmt(settings[k] as number);
    saveSettings(settings);
  };
}
function syncSliders() {
  for (const [k, fmt] of sliders) {
    $<HTMLInputElement>(k).value = String(settings[k]);
    $(`${k}Out`).textContent = fmt(settings[k] as number);
  }
  const fs = $<HTMLFieldSetElement>('vvAdjust');
  fs.disabled = settings.engine === 'browser';
  $('vvAdjNote').hidden = settings.engine !== 'browser';
  $('aivisAdjNote').hidden = settings.engine !== 'aivis';
}

// ---------- 読み方辞書 ----------
let dict: DictEntry[] = loadDict();
let editingId: string | null = null;
function renderDict() {
  const ul = $('dList');
  ul.innerHTML = '';
  $('dCount').textContent = `（${dict.length}件）`;
  $('btnDict').textContent = `読み方辞書（読み間違いの修正・${dict.length}件）`;
  dict.forEach((e, i) => {
    const li = document.createElement('li');
    li.className = e.enabled ? '' : 'off';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = e.enabled;
    chk.setAttribute('aria-label', `「${e.from}」を使う`);
    chk.onchange = () => { e.enabled = chk.checked; saveDict(dict); renderDict(); };
    const w = document.createElement('span');
    w.className = 'dw';
    w.textContent = `${e.from} → ${e.to || '（読まない）'}`;
    if (e.regex) { const b = document.createElement('span'); b.className = 're'; b.textContent = '正規表現'; w.append(b); }
    const up = document.createElement('button');
    up.textContent = '↑'; up.setAttribute('aria-label', `「${e.from}」を上へ`); up.disabled = i === 0;
    up.onclick = () => { [dict[i - 1], dict[i]] = [dict[i], dict[i - 1]]; saveDict(dict); renderDict(); };
    const ed = document.createElement('button');
    ed.textContent = '編集'; ed.setAttribute('aria-label', `「${e.from}」を編集`);
    ed.onclick = () => {
      editingId = e.id;
      $<HTMLInputElement>('dFrom').value = e.from;
      $<HTMLInputElement>('dTo').value = e.to;
      $<HTMLInputElement>('dRegex').checked = e.regex;
      $('dSave').textContent = '更新する';
      $('dCancel').hidden = false;
      $('dFrom').focus();
    };
    const del = document.createElement('button');
    del.textContent = '削除'; del.setAttribute('aria-label', `「${e.from}」を削除`);
    del.onclick = () => {
      if (!confirm(`「${e.from} → ${e.to}」を削除しますか？`)) return;
      dict = dict.filter((x) => x.id !== e.id); saveDict(dict); renderDict();
    };
    li.append(chk, w, up, ed, del);
    ul.append(li);
  });
}
function resetDictForm() {
  editingId = null;
  $<HTMLInputElement>('dFrom').value = '';
  $<HTMLInputElement>('dTo').value = '';
  $<HTMLInputElement>('dRegex').checked = false;
  $('dSave').textContent = '追加する';
  $('dCancel').hidden = true;
  $('dErr').hidden = true;
}
$('btnDict').onclick = () => { renderDict(); $('settings').hidden = true; $('dictSheet').hidden = false; };
function openDictWith(from: string) {
  renderDict();
  resetDictForm();
  const existing = dict.find((e) => !e.regex && e.from === from);
  if (existing) {
    editingId = existing.id;
    $<HTMLInputElement>('dTo').value = existing.to;
    $('dSave').textContent = '更新する';
    $('dCancel').hidden = false;
  }
  $<HTMLInputElement>('dFrom').value = from;
  $<HTMLInputElement>('dTest').value = sentences[sentIdx]?.text.includes(from) ? sentences[sentIdx].text : from;
  $('settings').hidden = true;
  $('dictSheet').hidden = false;
  setTimeout(() => $('dTo').focus(), 50);
}
$('btnCloseDict').onclick = () => { $('dictSheet').hidden = true; };
$('dCancel').onclick = resetDictForm;
$('dSave').onclick = () => {
  const from = $<HTMLInputElement>('dFrom').value;
  const to = $<HTMLInputElement>('dTo').value;
  const regex = $<HTMLInputElement>('dRegex').checked;
  const err = $('dErr');
  if (!from.trim()) { err.textContent = '表記を入れてください'; err.hidden = false; return; }
  if (regex) { const m = checkRegex(from); if (m) { err.textContent = `正規表現が正しくありません：${m}`; err.hidden = false; return; } }
  if (editingId) {
    const e = dict.find((x) => x.id === editingId);
    if (e) Object.assign(e, { from, to, regex });
  } else {
    dict.push({ id: newId(), from, to, regex, enabled: true });
  }
  saveDict(dict);
  resetDictForm();
  renderDict();
  toast('辞書に保存しました');
};
$('dTestBtn').onclick = async () => {
  unlockAll();
  const src = $<HTMLInputElement>('dTest').value.trim() || $<HTMLInputElement>('dFrom').value.trim();
  if (!src) { toast('試す文を入れてください'); return; }
  const out = applyDict(src, dict);
  $('dTestOut').textContent = `読み上げる文字：${out}`;
  await previewSpeak(out);
};
$('dExport').onclick = async () => {
  const json = exportDict(dict);
  const blob = new Blob([json], { type: 'application/json' });
  const file = new File([blob], 'yomiage-dictionary.json', { type: 'application/json' });
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  try {
    if (nav.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'よみあげ 読み方辞書' }); return; }
  } catch (e) { if ((e as Error).name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'yomiage-dictionary.json';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};
$('dImport').onclick = () => $('dImportFile').click();
$('dImportFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    const items = parseDictImport(await f.text());
    const replace = dict.length > 0 && confirm(`${items.length}件を読み込みます。\n「OK」＝今の辞書を置き換える／「キャンセル」＝今の辞書に追加する`);
    if (replace) dict = items;
    else {
      const seen = new Set(dict.map((d) => `${d.regex}|${d.from}`));
      for (const it of items) if (!seen.has(`${it.regex}|${it.from}`)) dict.push(it);
    }
    saveDict(dict);
    renderDict();
    toast(`${items.length}件を読み込みました`);
  } catch (err) {
    toast(`読み込めませんでした：${(err as Error).message}`);
  }
});
(window as unknown as Record<string, unknown>).__dict = { applyDict, get dict() { return dict; } };

$('buildInfo').textContent = `build ${BUILD}`;
$('homeBuild').textContent = `build ${BUILD}`;
$('dbg').addEventListener('toggle', async () => { if (($('dbg') as HTMLDetailsElement).open) $('dbgText').textContent = await debugText(); });
$('btnDbgCopy').onclick = copyDebug;
$('btnUpdate').onclick = async () => {
  // 古い版が残っている場合の強制更新：Service Worker とアプリ本体のキャッシュを消して読み込み直す（OCRデータは残す）
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
    for (const r of regs) await r.unregister();
    const keys = await caches.keys();
    for (const k of keys) if (!/yomiage-ocr-lang|yomiage-engine/.test(k)) await caches.delete(k);
  } catch (e) { console.warn('update', e); }
  location.reload();
};

$('btnClear').onclick = async () => {
  if (!confirm('最近のファイル・読書位置・設定・OCR結果をすべて消しますか？（読み方辞書と文字の修正は残ります）')) return;
  stopPlayback();
  await clearAll();
  Object.assign(settings, loadSettings());
  applyTheme();
  syncSettingsUI();
  $('settings').hidden = true;
  showView('home');
  toast('すべて消しました');
};

// ---------- iPhoneショートカット用（スクショ読み上げ） ----------
const SYNC_KEY = 'yomiage:shotDictId';
function shortcutParams(dictId: string | null): URLSearchParams {
  const q = new URLSearchParams();
  const eng = settings.engine === 'voicevox' ? 'voicevox' : 'aivis';
  q.set('engine', eng);
  q.set('speaker', String(eng === 'voicevox' ? settings.vvSpeaker : settings.aivisSpeaker));
  q.set('speed', settings.rate.toFixed(2));
  q.set('pitch', ((settings.pitch - 1) * 0.15).toFixed(3));
  q.set('intonation', String(settings.intonation));
  q.set('volume', String(settings.volume));
  q.set('pause', String(settings.pause));
  if (dictId) q.set('dict', dictId);
  return q;
}
function renderShortcutUrls(dictId: string | null) {
  const q = shortcutParams(dictId).toString();
  const base = serverBase();
  const box = $('scUrls');
  box.innerHTML = '';
  const items: Array<[string, string]> = [
    ['① 音声で返す（基本の作り方で使うURL）', `${base}/shot/audio?${q}`],
    ['② 分けて返す（早く読み始める作り方で使うURL）', `${base}/shot/read?${q}`],
    ['③ 文字だけ返す（iPhoneの声で読む作り方で使うURL）', `${base}/shot/text?format=text${dictId ? `&dict=${dictId}` : ''}`],
  ];
  for (const [label, u] of items) {
    const div = document.createElement('div');
    div.className = 'field';
    const l = document.createElement('span'); l.className = 'small'; l.textContent = label;
    const inp = document.createElement('input'); inp.type = 'text'; inp.readOnly = true; inp.className = 'text-in'; inp.value = u;
    inp.onfocus = () => inp.select();
    const b = document.createElement('button'); b.className = 'wide-btn'; b.textContent = 'このURLをコピー';
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(u); toast('コピーしました。ショートカットの「URL」に貼り付けてください'); }
      catch { inp.focus(); inp.select(); toast('選択しました。「コピー」を押してください'); }
    };
    div.append(l, inp, b);
    box.append(div);
  }
  $('scNote').textContent = `今の声の設定（${ENGINE_NAME[settings.engine === 'voicevox' ? 'voicevox' : 'aivis']}・速さ${settings.rate.toFixed(2)}倍）${dictId ? `と読み方辞書（${dict.length}件）` : ''}が入っています。${new URL(serverBase()).hostname.endsWith('trycloudflare.com') ? '※サーバーを起動し直すとURLの前半（https://〜.trycloudflare.com）が変わります。その時はここで作り直してください。' : ''}`;
}
$('btnScMake').onclick = async () => {
  let id = localStorage.getItem(SYNC_KEY);
  try {
    const r = await fetch(api(`/shot/dict${id ? `?id=${encodeURIComponent(id)}` : ''}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: exportDict(dict) });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json() as { id: string; count: number };
    id = j.id;
    localStorage.setItem(SYNC_KEY, id);
    toast(`辞書（${j.count}件）をサーバーに送りました`);
  } catch (e) {
    console.warn('[SHOT] dict upload failed', e);
    toast('辞書を送れませんでした（辞書なしのURLを作ります）');
    id = null;
  }
  renderShortcutUrls(id);
};

// ショートカットから開かれた時（/?shot=<id>）：サーバーに残っている結果（30分）を表示
async function openShotFromUrl(): Promise<boolean> {
  const id = new URLSearchParams(location.search).get('shot');
  if (!id || !/^[A-Za-z0-9_-]{16,40}$/.test(id)) return false;
  history.replaceState(null, '', location.pathname);
  try {
    const [rr, ri] = await Promise.all([fetch(api(`/shot/result/${id}`)), fetch(api(`/shot/image/${id}`))]);
    if (!rr.ok || !ri.ok) throw new Error(rr.status === 404 ? '結果が見つかりません（30分で消えます）' : `サーバーのエラー（${rr.status}）`);
    const j = await rr.json() as { text: string; lines: OcrLine[]; ranges: Array<[number, number]>; width: number; height: number };
    const blob = await ri.blob();
    const now = new Date();
    const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
    const file = new File([blob], `shortcut-${id.slice(0, 6)}.${ext}`, { type: blob.type, lastModified: now.getTime() });
    // OCRはサーバーで済んでいるので、結果をそのまま使う（端末の画像は縮小されることがあるので枠を合わせる）
    const docId = 'shot|' + docIdFor([file], 'image');
    await putCachedPage(`${docId}#0#shot-a-${settings.spread}`, { text: j.text, lines: j.lines, ranges: j.ranges, width: j.width, height: j.height, method: 'ocr', engine: 'ndl' });
    await loadFiles([file], true, { screen: true });
    return true;
  } catch (e) {
    toast(`ショートカットの結果を開けませんでした：${(e as Error).message}`, 6000);
    return false;
  }
}


// ---------- サーバーURL（GitHub Pages など別の場所でアプリを開く時に使う） ----------
function syncServerUI() {
  const inp = $<HTMLInputElement>('srvUrl');
  if (document.activeElement !== inp) inp.value = getServerUrl();
  if (!$('srvStatus').dataset.checked) $('srvStatus').textContent = `今使っているサーバー：${serverBase()}${usingRemoteServer() ? '' : '（このアプリと同じ）'}`;
}
async function runServerCheck() {
  const st = $('srvStatus');
  st.dataset.checked = '1';
  st.textContent = `接続確認中…（${serverBase()}）`;
  const r = await checkServer();
  st.textContent = r.ok ? `✅ 接続OK（${r.detail}）　${serverBase()}` : `❌ 接続NG：${r.detail}　${serverBase()}`;
  return r.ok;
}
async function reloadServerEngines() {
  vv.available = null; av.available = null;
  updateEngineUI();
  await Promise.all([vv.load(), av.load()]);
  updateEngineUI();
}
$('btnSrvSave').onclick = async () => {
  const inp = $<HTMLInputElement>('srvUrl');
  const n = normalizeServerUrl(inp.value);
  if (n === null) { toast('URLの形が正しくありません（例：https://〜.trycloudflare.com）'); return; }
  setServerUrl(n === location.origin ? '' : n);
  inp.value = getServerUrl();
  inp.blur();
  const ok = await runServerCheck();
  toast(ok ? 'サーバーに接続できました' : 'サーバーに接続できません。URLを確かめてください', 5000);
  await reloadServerEngines();
};
$('btnSrvCheck').onclick = async () => { if (!(await runServerCheck()) && (await tryAutoServer(true))) runServerCheck(); };
syncServerUI();
// トンネルのURLが変わった時：公開されている今のURL（GitHub の server.json）を見て自動で切り替える
async function tryAutoServer(force = false) {
  if (!(await autoUpdateServerUrl(force))) return false;
  delete $('srvStatus').dataset.checked;
  syncServerUI();
  toast(`サーバーURLを自動更新しました（${serverBase().replace(/^https:\/\//, '')}）`, 4000);
  await reloadServerEngines();
  return true;
}
window.addEventListener('yomiage:serverfail', () => { tryAutoServer(); });
tryAutoServer(true).then((changed) => {
  // GitHub Pages 版をサーバーURLなしで開いた時（公開URLも取れなかった時）は案内する
  if (!changed && location.hostname.endsWith('github.io') && !getServerUrl()) {
    toast('音声（VOICEVOX・AivisSpeech）やサーバーOCRを使うには、設定の「サーバーURL」にサーバーのURLを入れてください', 8000);
  }
});

// ---------------- 起動 ----------------
syncSettingsUI();
showView('home');
openShotFromUrl();
