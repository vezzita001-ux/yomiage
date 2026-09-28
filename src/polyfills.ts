// iOS Safari（WebKit）の古いバージョン向けの補完。pdf.js より先に読み込むこと。
// 原因の例：iOS Safari は ReadableStream の for await...of（Symbol.asyncIterator）に未対応で、
// pdf.js の getTextContent() が「undefined is not a function (near '...e of t...')」で失敗していた。
/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;
// 診断用：補完する前に標準で持っていたかを記録
try {
  g.__nativeStreamIter = typeof g.ReadableStream === 'function' && typeof g.ReadableStream.prototype[Symbol.asyncIterator] === 'function';
  g.__nativeWithResolvers = typeof g.Promise.withResolvers === 'function';
} catch { /* 無視 */ }

// ReadableStream の非同期イテレーター
if (typeof g.ReadableStream === 'function') {
  const proto = g.ReadableStream.prototype;
  if (typeof proto[Symbol.asyncIterator] !== 'function' || typeof proto.values !== 'function') {
    const values = function (this: ReadableStream, opts?: { preventCancel?: boolean }) {
      const reader = this.getReader();
      const preventCancel = !!opts?.preventCancel;
      return {
        next() { return reader.read(); },
        async return(value?: unknown) {
          if (!preventCancel) { try { await reader.cancel(value); } catch { /* 無視 */ } }
          try { reader.releaseLock(); } catch { /* 無視 */ }
          return { done: true, value };
        },
        [Symbol.asyncIterator]() { return this; },
      };
    };
    if (typeof proto.values !== 'function') Object.defineProperty(proto, 'values', { value: values, writable: true, configurable: true });
    if (typeof proto[Symbol.asyncIterator] !== 'function') Object.defineProperty(proto, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
  }
}

// Promise.withResolvers（Safari 17.4 未満）
if (typeof g.Promise.withResolvers !== 'function') {
  g.Promise.withResolvers = function () {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

// Promise.try
if (typeof g.Promise.try !== 'function') {
  g.Promise.try = function (fn: (...a: unknown[]) => unknown, ...args: unknown[]) {
    return new Promise((res) => res(fn(...args)));
  };
}

// Map.prototype.getOrInsert / getOrInsertComputed
for (const C of [g.Map, g.WeakMap]) {
  if (!C) continue;
  if (typeof C.prototype.getOrInsert !== 'function') {
    Object.defineProperty(C.prototype, 'getOrInsert', {
      value(this: Map<unknown, unknown>, k: unknown, v: unknown) { if (!this.has(k)) this.set(k, v); return this.get(k); },
      writable: true, configurable: true,
    });
  }
  if (typeof C.prototype.getOrInsertComputed !== 'function') {
    Object.defineProperty(C.prototype, 'getOrInsertComputed', {
      value(this: Map<unknown, unknown>, k: unknown, f: (k: unknown) => unknown) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); },
      writable: true, configurable: true,
    });
  }
}

// Math.sumPrecise（簡易版）
if (typeof g.Math.sumPrecise !== 'function') {
  g.Math.sumPrecise = (items: Iterable<number>) => { let s = 0; for (const x of items) s += x; return s; };
}

// Uint8Array.fromBase64 / toBase64 / fromHex / toHex
const U8 = g.Uint8Array;
if (typeof U8.fromBase64 !== 'function') {
  U8.fromBase64 = (str: string, opts?: { alphabet?: string }) => {
    let s = String(str).replace(/\s+/g, '');
    if (opts?.alphabet === 'base64url') s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new U8(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
}
if (typeof U8.prototype.toBase64 !== 'function') {
  Object.defineProperty(U8.prototype, 'toBase64', {
    value(this: Uint8Array, opts?: { alphabet?: string; omitPadding?: boolean }) {
      let bin = '';
      for (let i = 0; i < this.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(this.subarray(i, i + 0x8000)));
      let s = btoa(bin);
      if (opts?.alphabet === 'base64url') s = s.replace(/\+/g, '-').replace(/\//g, '_');
      if (opts?.omitPadding) s = s.replace(/=+$/, '');
      return s;
    },
    writable: true, configurable: true,
  });
}
if (typeof U8.fromHex !== 'function') {
  U8.fromHex = (hex: string) => {
    const out = new U8(hex.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  };
}
if (typeof U8.prototype.toHex !== 'function') {
  Object.defineProperty(U8.prototype, 'toHex', {
    value(this: Uint8Array) { let s = ''; for (const b of this) s += b.toString(16).padStart(2, '0'); return s; },
    writable: true, configurable: true,
  });
}

// Set の集合演算（Safari 17 未満）
const SP = g.Set.prototype;
const def = (name: string, fn: (this: Set<unknown>, other: any) => unknown) => {
  if (typeof SP[name] !== 'function') Object.defineProperty(SP, name, { value: fn, writable: true, configurable: true });
};
const keysOf = (o: any): Iterable<unknown> => (typeof o.keys === 'function' ? o.keys() : o);
def('union', function (o) { const r = new Set(this); for (const k of keysOf(o)) r.add(k); return r; });
def('intersection', function (o) { const r = new Set(); for (const k of this) if (o.has(k)) r.add(k); return r; });
def('difference', function (o) { const r = new Set(); for (const k of this) if (!o.has(k)) r.add(k); return r; });
def('symmetricDifference', function (o) { const r = new Set(this); for (const k of keysOf(o)) { if (this.has(k)) r.delete(k); else r.add(k); } return r; });
def('isSubsetOf', function (o) { for (const k of this) if (!o.has(k)) return false; return true; });
def('isSupersetOf', function (o) { for (const k of keysOf(o)) if (!this.has(k)) return false; return true; });
def('isDisjointFrom', function (o) { for (const k of this) if (o.has(k)) return false; return true; });

// Array.fromAsync
if (typeof g.Array.fromAsync !== 'function') {
  g.Array.fromAsync = async (src: any) => {
    const out: unknown[] = [];
    if (src && typeof src[Symbol.asyncIterator] === 'function') { for await (const x of src) out.push(x); }
    else for (const x of src) out.push(await x);
    return out;
  };
}

export {};
