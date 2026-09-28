// AivisSpeech の音声合成モデルのクレジット（各モデルの AivisHub 掲載情報より。ライセンスはすべて ACML 1.0）
// ACML 1.0 ではクレジット表記は任意ですが、各モデルの制作者が表記を希望しているため表示します。

export interface AivisCredit { short: string; full: string }

const RIABO = (name: string): AivisCredit => ({
  short: `声は(x.com/dopoiro)のAI（${name}）`,
  full: `リアボVC公式モデル「${name}」。声は(x.com/dopoiro)のAI。ライセンス：ACML 1.0`,
});

export const AIVIS_CREDITS: Array<[RegExp, AivisCredit]> = [
  [/^morioki/, { short: 'AivisSpeech: morioki（ボイス提供：もりおき）', full: 'morioki：ボイス提供 もりおき（X: @morioki_5）／モデル作成 yuki（X: @ai_shirohana）。ライセンス：ACML 1.0' }],
  [/^ほのか/, RIABO('ほのか')],
  [/^わかな/, RIABO('わかな')],
  [/^かりん/, RIABO('かりん')],
  [/^れな/, RIABO('れな')],
  [/^まお/, { short: 'AivisSpeech: まお', full: '卯畑まお（©Oz Chat/Trippy）CV: ねゆたろ。クレジット「AivisSpeech: まお」。ライセンス：ACML 1.0' }],
  [/^コハク/, { short: 'AivisSpeech: コハク', full: '猫音コハク（©Oz Chat/Trippy）CV: ねゆたろ。クレジット「AivisSpeech: コハク」。ライセンス：ACML 1.0' }],
];

export function aivisCredit(character: string): AivisCredit {
  for (const [re, c] of AIVIS_CREDITS) if (re.test(character)) return c;
  return { short: `AivisSpeech: ${character}`, full: `AivisSpeech: ${character}（ライセンスはAivisHubの各モデルのページを確認してください）` };
}

/** 長い話者名を短くする：「ほのか(~現実20代女子…)」→「ほのか」 */
export function shortName(name: string): string {
  return name.replace(/[（(].*$/u, '').trim() || name;
}

const STYLE_JA: Record<string, string> = {
  kanasimi: '悲しみ', uresii: '嬉しい', hutuu: 'ふつう', odoroki: '驚き',
};
export function styleJa(style: string): string {
  const k = style.split('_')[0];
  return STYLE_JA[k] || style;
}

/** 声の並び順：落ち着いた大人の女性の声を上に */
export const AIVIS_ORDER = [/^morioki/, /^ほのか/, /^わかな/, /^かりん/, /^まお/, /^コハク/];
