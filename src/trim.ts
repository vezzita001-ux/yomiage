// スマホ画面（スクリーンショット）の切り取り設定：本（書籍名）ごとに覚える
// 自動：サーバーがステータスバー・ホームバーを画像から見つけて除く。手動：上下左右を割合（%）で指定（警告の表示などを除く）
import type { LoadedDoc } from './docs';

export interface Trim {
  mode: 'auto' | 'manual';
  top: number; bottom: number; left: number; right: number; // %
  /** スマホ画面モード（読書アプリの表示を除く）：auto＝ファイルから判定 */
  screen: 'auto' | 'on' | 'off';
}
export const DEFAULT_TRIM: Trim = { mode: 'auto', top: 5, bottom: 4, left: 0, right: 0, screen: 'auto' };
const PREFIX = 'yomiage:trim:';

export function trimKey(d: LoadedDoc): string { return d.book ? `book:${d.book.title}` : `doc:${d.id}`; }
export function loadTrim(key: string): Trim {
  try { return { ...DEFAULT_TRIM, ...JSON.parse(localStorage.getItem(PREFIX + key) || '{}') }; } catch { return { ...DEFAULT_TRIM }; }
}
export function saveTrim(key: string, t: Trim) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(t)); } catch { /* 無視 */ }
}
export function isScreen(d: LoadedDoc, t: Trim): boolean { return t.screen === 'on' || (t.screen === 'auto' && !!d.screen); }
/** サーバー（/shot/text）に付けるパラメータ */
export function trimQuery(t: Trim): string {
  if (t.mode === 'auto') return '';
  const f = (v: number) => String(Math.round(Math.min(45, Math.max(0, v)) * 10) / 1000);
  return `&top=${f(t.top)}&bottom=${f(t.bottom)}&left=${f(t.left)}&right=${f(t.right)}`;
}
/** OCR結果のキャッシュのキー用 */
export function trimSig(t: Trim): string { return t.mode === 'auto' ? 'a' : `m${t.top}-${t.bottom}-${t.left}-${t.right}`; }
/** 端末内OCR用：画像を切り取る（自動の時は縦長の画面なら上5%・下4%） */
export function cropForDevice(c: HTMLCanvasElement, t: Trim): HTMLCanvasElement {
  const auto = t.mode === 'auto';
  const tall = c.height > c.width * 1.3;
  const top = auto ? (tall ? 5 : 0) : t.top, bottom = auto ? (tall ? 4 : 0) : t.bottom;
  const left = auto ? 0 : t.left, right = auto ? 0 : t.right;
  const x0 = Math.round(c.width * left / 100), y0 = Math.round(c.height * top / 100);
  const w = Math.max(1, Math.round(c.width * (1 - (left + right) / 100))), h = Math.max(1, Math.round(c.height * (1 - (top + bottom) / 100)));
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d')!.drawImage(c, x0, y0, w, h, 0, 0, w, h);
  return out;
}
