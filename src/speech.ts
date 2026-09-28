// Web Speech API（speechSynthesis）のラッパー。iOSの既知の不具合対策入り。

export type SpeakResult = 'end' | 'error' | 'timeout' | 'cancel' | 'skip';

export interface SpeakOptions {
  voiceURI: string | null;
  rate: number;
  pitch: number;
  /** 以下は VOICEVOX のみ */
  intonation?: number;
  volume?: number;
  pause?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Speaker {
  readonly supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  voices: SpeechSynthesisVoice[] = [];
  jaVoices: SpeechSynthesisVoice[] = [];
  onVoicesChanged: (() => void) | null = null;
  lastStarted = false;
  /** iOSのガベージコレクションで onend が消える不具合対策として参照を保持 */
  private keep: SpeechSynthesisUtterance[] = [];
  private finishCurrent: ((r: SpeakResult) => void) | null = null;
  private unlocked = false;

  constructor() {
    if (!this.supported) return;
    const synth = window.speechSynthesis;
    this.refreshVoices();
    synth.addEventListener?.('voiceschanged', () => this.refreshVoices());
    // iOSでは声の一覧が遅れて届くことがあるので数秒間ポーリング
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      this.refreshVoices();
      if (tries > 40) clearInterval(timer);
    }, 250);
  }

  refreshVoices() {
    if (!this.supported) return;
    const list = window.speechSynthesis.getVoices() || [];
    const ja = list.filter((v) => (v.lang || '').replace('_', '-').toLowerCase().startsWith('ja'))
      .sort((a, b) => Number(/o[-‐‑ ]?ren|オーレン/i.test(b.name)) - Number(/o[-‐‑ ]?ren|オーレン/i.test(a.name)));
    const changed = list.length !== this.voices.length || ja.length !== this.jaVoices.length;
    this.voices = list;
    this.jaVoices = ja;
    if (changed) this.onVoicesChanged?.();
  }

  /** 利用者の好み：O-ren（オーレン）があれば最優先 */
  preferred(): SpeechSynthesisVoice | undefined {
    return this.jaVoices.find((v) => /o[-‐‑ ]?ren|オーレン/i.test(v.name)) || this.jaVoices.find((v) => v.default) || this.jaVoices[0];
  }

  findVoice(uri: string | null): SpeechSynthesisVoice | undefined {
    if (!uri) return this.preferred();
    return this.voices.find((v) => v.voiceURI === uri) || this.jaVoices[0];
  }

  /** ユーザーのタップ直後に呼ぶ（iOSは最初の発話がタップ由来でないと鳴らない） */
  unlock() {
    if (!this.supported || this.unlocked) return;
    this.unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.lang = 'ja-JP';
      this.hold(u);
      window.speechSynthesis.speak(u);
    } catch { /* 無視 */ }
  }

  private hold(u: SpeechSynthesisUtterance) {
    this.keep.push(u);
    if (this.keep.length > 8) this.keep.shift();
  }

  get busy(): boolean {
    if (!this.supported) return false;
    const s = window.speechSynthesis;
    return s.speaking || s.pending;
  }

  cancel() {
    const f = this.finishCurrent;
    this.finishCurrent = null;
    f?.('cancel');
    if (this.supported) {
      try { window.speechSynthesis.cancel(); } catch { /* 無視 */ }
    }
  }

  /** 1文を読み上げ、終わったら（またはウォッチドッグが判定したら）解決する */
  async speak(text: string, opt: SpeakOptions): Promise<SpeakResult> {
    this.lastStarted = false;
    if (!this.supported) return 'error';
    const synth = window.speechSynthesis;
    // 前の発話が残っていたら必ず取り消してから話す
    if (this.finishCurrent) { const f = this.finishCurrent; this.finishCurrent = null; f('cancel'); }
    if (synth.speaking || synth.pending) {
      synth.cancel();
      await sleep(120);
    }
    if (synth.paused) synth.resume();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    const v = this.findVoice(opt.voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = opt.rate;
    u.pitch = opt.pitch;
    u.volume = 1;
    this.hold(u);

    return new Promise<SpeakResult>((resolve) => {
      let done = false;
      let started = false;
      let idle = 0;
      const t0 = Date.now();
      const finish = (r: SpeakResult) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(hard);
        if (this.finishCurrent === finish) this.finishCurrent = null;
        this.lastStarted = started;
        resolve(r);
      };
      this.finishCurrent = finish;
      u.onstart = () => { started = true; };
      u.onend = () => finish('end');
      u.onerror = (e: SpeechSynthesisErrorEvent) => {
        finish(e.error === 'interrupted' || e.error === 'canceled' ? 'cancel' : 'error');
      };
      // 日本語はおよそ毎秒7〜8文字。余裕を持たせた上限時間
      const est = (Array.from(text).length / (7 * Math.max(0.3, opt.rate))) * 1000;
      const hard = setTimeout(() => {
        try { synth.cancel(); } catch { /* 無視 */ }
        finish(started ? 'end' : 'timeout');
      }, est * 2.5 + 8000);
      // ウォッチドッグ：onendが来ないのに話していない状態が続いたら次へ
      const poll = setInterval(() => {
        const elapsed = Date.now() - t0;
        if (synth.speaking || synth.pending) { idle = 0; if (synth.speaking) started = true; return; }
        if (elapsed < 1500) return;
        idle++;
        if (idle >= 3) finish(started ? 'end' : 'timeout');
      }, 500);
      try {
        synth.speak(u);
      } catch {
        finish('error');
      }
    });
  }
}
