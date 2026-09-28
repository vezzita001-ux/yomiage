// 画面に表示・コピーできる診断ログ（不具合の報告用）
declare const __BUILD__: string;
export const BUILD: string = typeof __BUILD__ !== 'undefined' ? __BUILD__ : 'dev';

const MAX = 300;
const entries: string[] = [];
const t0 = Date.now();

function fmt(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n    ${a.stack.split('\n').slice(0, 4).join('\n    ')}` : ''}`;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

export function dlog(level: string, ...args: unknown[]) {
  const t = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  entries.push(`[${t}s] ${level} ${args.map(fmt).join(' ')}`);
  if (entries.length > MAX) entries.shift();
}

export function installLogCapture() {
  for (const level of ['info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      // tesseract の大量の警告は記録しない
      if (!(typeof args[0] === 'string' && args[0].startsWith('Warning: Parameter not found'))) dlog(level.toUpperCase(), ...args);
      orig(...args);
    };
  }
  window.addEventListener('error', (e) => dlog('UNCAUGHT', e.error || e.message, `${e.filename || ''}:${e.lineno || ''}`));
  window.addEventListener('unhandledrejection', (e) => dlog('UNHANDLED', e.reason));
}

export async function environmentReport(): Promise<string> {
  const g = globalThis as unknown as Record<string, unknown>;
  const rsProto = (g.ReadableStream as { prototype?: Record<symbol | string, unknown> } | undefined)?.prototype;
  let workerModule = 'unknown';
  try {
    let supports = false;
    const opts = { get type() { supports = true; return 'module' as const; } };
    const w = new Worker('data:text/javascript,', opts as WorkerOptions);
    w.terminate();
    workerModule = String(supports);
  } catch (e) { workerModule = `error ${(e as Error).message}`; }
  let storage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) storage = `${Math.round((est.usage || 0) / 1048576)}MB / ${Math.round((est.quota || 0) / 1048576)}MB`;
  } catch { /* 無視 */ }
  const nav = navigator as Navigator & { deviceMemory?: number; standalone?: boolean };
  const lines = [
    `よみあげ build ${BUILD}`,
    `UA: ${navigator.userAgent}`,
    `画面: ${screen.width}x${screen.height} @${devicePixelRatio}  ホーム画面アプリ: ${nav.standalone ?? matchMedia('(display-mode: standalone)').matches}`,
    `SW: ${navigator.serviceWorker?.controller ? '有効' : 'なし'}`,
    `ReadableStream for-await(標準): ${(window as unknown as { __nativeStreamIter?: boolean }).__nativeStreamIter}`,
    `Promise.withResolvers(標準): ${(window as unknown as { __nativeWithResolvers?: boolean }).__nativeWithResolvers}`,
    `OffscreenCanvas: ${typeof g.OffscreenCanvas}  module worker: ${workerModule}  structuredClone: ${typeof g.structuredClone}`,
    `deviceMemory: ${nav.deviceMemory ?? '不明'}  保存容量: ${storage}`,
    `speechSynthesis: ${'speechSynthesis' in window}`,
  ];
  void rsProto;
  return lines.join('\n');
}

export function logText(): string { return entries.join('\n'); }
