// pdf.js のワーカー。先に補完（polyfill）を読み込んでから本体を読み込む。
import './polyfills';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
