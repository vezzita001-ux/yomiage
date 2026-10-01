// VOICEVOX / AivisSpeech（配信元サーバー上のエンジン）で合成した音声を <audio> で順番に再生する読み上げエンジン
import type { SpeakResult, SpeakOptions } from './speech';
import { api, notifyServerFail } from './server';

export interface VvStyle { id: number; label: string; character: string; order: number }

export type StyleFormatter = (character: string, style: string) => { label: string; order: number };

function silentWavUrl(): string {
  // 0.1秒の無音WAV（8kHz・16bit・モノラル）
  const n = 800;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export class ServerSpeaker {
  styles: VvStyle[] = [];
  available: boolean | null = null;
  lastStarted = false;
  /** 直近の合成にかかった時間（ミリ秒） */
  lastLatency = 0;
  private audio: HTMLAudioElement;
  private cache = new Map<string, Promise<string>>();
  private finishCurrent: ((r: SpeakResult) => void) | null = null;
  private unlocked = false;

  /** path は '/voicevox' など。サーバーURLの設定を毎回反映する */
  get base(): string { return api(this.path); }

  constructor(readonly path: string, private fmt?: StyleFormatter) {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    (this.audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
  }

  async load(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/speakers`, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const list = (await r.json()) as Array<{ name: string; styles: Array<{ name: string; id: number; type?: string }> }>;
      this.styles = [];
      for (const sp of list) for (const st of sp.styles) {
        if (st.type && st.type !== 'talk') continue;
        const f = this.fmt?.(sp.name, st.name) ?? { label: `${sp.name}（${st.name}）`, order: 0 };
        this.styles.push({ id: st.id, character: sp.name, label: f.label, order: f.order });
      }
      this.styles.sort((a, b) => a.order - b.order);
      this.available = this.styles.length > 0;
    } catch {
      this.available = false;
      notifyServerFail();
    }
    return this.available;
  }

  characterOf(id: number): string {
    return this.styles.find((s) => s.id === id)?.character || '';
  }

  /** タップ直後に呼ぶ：iOSで<audio>の再生を許可させる */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      this.audio.src = silentWavUrl();
      this.audio.play().catch(() => { this.unlocked = false; });
    } catch { this.unlocked = false; }
  }

  get busy(): boolean { return !this.audio.paused && !this.audio.ended; }

  private key(text: string, speaker: number, o: SpeakOptions) {
    return `${speaker}|${o.rate.toFixed(2)}|${o.pitch.toFixed(2)}|${o.intonation ?? 1}|${o.volume ?? 1}|${o.pause ?? 1}|${text}`;
  }

  /** 音声を先に合成しておく（次の文の先読み） */
  prefetch(text: string, speaker: number, o: SpeakOptions): Promise<string> {
    const k = this.key(text, speaker, o);
    let p = this.cache.get(k);
    if (!p) {
      const params = new URLSearchParams({
        text, speaker: String(speaker), speed: String(o.rate), pitch: String(((o.pitch - 1) * 0.15).toFixed(3)),
        intonation: String(o.intonation ?? 1), volume: String(o.volume ?? 1), pause: String(o.pause ?? 1),
      });
      const t0 = performance.now();
      p = fetch(`${this.base}/tts?${params}`).then(async (r) => {
        if (!r.ok) throw new Error(`${this.base} ${r.status}`);
        const blob = await r.blob();
        this.lastLatency = performance.now() - t0;
        return URL.createObjectURL(blob);
      });
      p.catch((e) => { this.cache.delete(k); if (e instanceof TypeError || /\s5\d\d$/.test(String(e?.message))) notifyServerFail(); });
      this.cache.set(k, p);
      // 古いものから捨てる
      while (this.cache.size > 12) {
        const first = this.cache.keys().next().value as string;
        const old = this.cache.get(first);
        this.cache.delete(first);
        old?.then((u) => setTimeout(() => URL.revokeObjectURL(u), 30000)).catch(() => undefined);
      }
    }
    return p;
  }

  cancel() {
    const f = this.finishCurrent;
    this.finishCurrent = null;
    f?.('cancel');
    try { this.audio.pause(); } catch { /* 無視 */ }
  }

  async speak(text: string, speaker: number, o: SpeakOptions): Promise<SpeakResult> {
    this.lastStarted = false;
    if (this.finishCurrent) { const f = this.finishCurrent; this.finishCurrent = null; f('cancel'); }
    let cancelled = false;
    const cancelWait = new Promise<SpeakResult>((resolve) => {
      this.finishCurrent = (r) => { cancelled = true; resolve(r); };
    });
    let url: string;
    try {
      const got = await Promise.race([this.prefetch(text, speaker, o), cancelWait]);
      if (cancelled || typeof got !== 'string' || got === 'cancel') return 'cancel';
      url = got;
    } catch {
      if (this.finishCurrent) this.finishCurrent = null;
      return 'error';
    }
    return new Promise<SpeakResult>((resolve) => {
      const a = this.audio;
      let done = false;
      const finish = (r: SpeakResult) => {
        if (done) return;
        done = true;
        a.onended = null; a.onerror = null; a.onplaying = null;
        clearInterval(watch);
        if (this.finishCurrent === finish) this.finishCurrent = null;
        resolve(r);
      };
      this.finishCurrent = (r) => { try { a.pause(); } catch { /* */ } finish(r); };
      a.onended = () => finish('end');
      a.onerror = () => finish('error');
      a.onplaying = () => { this.lastStarted = true; };
      // ウォッチドッグ：ended が来ないまま止まった場合
      let lastT = -1; let still = 0; let notStarted = 0;
      const watch = setInterval(() => {
        if (!this.lastStarted && ++notStarted > 10) { finish('timeout'); return; }
        if (a.paused && this.lastStarted) { still++; } else if (a.currentTime === lastT && this.lastStarted) { still++; } else still = 0;
        lastT = a.currentTime;
        if (still >= 6) finish(this.lastStarted ? 'end' : 'timeout');
      }, 1000);
      a.src = url;
      a.play().catch(() => finish('error'));
    });
  }
}
