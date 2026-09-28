// node_modules から public/ へ、オフライン動作に必要な静的ファイルをコピーする
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const nm = (p) => resolve(root, 'node_modules', p);
const pub = (p) => resolve(root, 'public', p);
const copies = [
  [nm('tesseract.js/dist/worker.min.js'), pub('tesseract/worker.min.js')],
  [nm('tesseract.js-core/tesseract-core-lstm.wasm.js'), pub('tesseract/core/tesseract-core-lstm.wasm.js')],
  [nm('tesseract.js-core/tesseract-core-simd-lstm.wasm.js'), pub('tesseract/core/tesseract-core-simd-lstm.wasm.js')],
  [nm('tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js'), pub('tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js')],
  [nm('pdfjs-dist/cmaps'), pub('pdfjs/cmaps')],
  [nm('pdfjs-dist/standard_fonts'), pub('pdfjs/standard_fonts')],
  [nm('pdfjs-dist/wasm'), pub('pdfjs/wasm')],
  [nm('pdfjs-dist/iccs'), pub('pdfjs/iccs')],
];
for (const [from, to] of copies) {
  if (!existsSync(from)) { console.warn('missing', from); continue; }
  mkdirSync(resolve(to, '..'), { recursive: true });
  cpSync(from, to, { recursive: true });
}
console.log('assets copied');
