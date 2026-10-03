import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
// サーバー部分（/voicevox/ などの中継）はボックスだけにある。GitHub Pages のビルドでは空の代わり（何もしないプラグイン）を置いてビルドする
import { voicevoxProxy } from './voicevox-proxy';

// GitHub Pages 用のビルドは YOMIAGE_BASE=/yomiage/ で（ボックスの vite preview/トンネルは / のまま）
const BASE = process.env.YOMIAGE_BASE || '/';
// 別の場所（GitHub Pages）で開いたアプリから、このサーバーの API（/voicevox/ /aivis/ /ocr/ /shot/ /video/ /novel/）を呼べるようにする
const CORS_ORIGINS: (string | RegExp)[] = [
  /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/, // Vite の既定（ローカル）
  'https://vezzita001-ux.github.io',
];
const CORS = {
  origin: CORS_ORIGINS,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  exposedHeaders: ['X-Shot-Id', 'X-Shot-View', 'X-Shot-Chars'],
  maxAge: 86400,
};

const BUILD = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(' ', '_').slice(0, 16);

export default defineConfig({
  base: BASE,
  define: { __BUILD__: JSON.stringify(BUILD) },
  server: { host: true, port: 5180, allowedHosts: true },
  preview: { host: true, port: 4180, allowedHosts: true, cors: CORS },
  build: { target: ['es2020', 'safari15', 'ios15'], chunkSizeWarningLimit: 3000 },
  worker: { format: 'es' },
  plugins: [
    voicevoxProxy(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // main.ts で登録（更新をすぐ反映するため）
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'よみあげ',
        short_name: 'よみあげ',
        description: 'PDF・画像・テキスト・ePubを端末内で読み上げるアプリ',
        lang: 'ja',
        start_url: BASE,
        scope: BASE,
        id: BASE,
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#1f2a44',
        background_color: '#1f2a44',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // アプリ本体（HTML/JS/CSS/pdf.js worker）を事前キャッシュ
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,webmanifest}'],
        globIgnores: ['tesseract/**', 'pdfjs/**', 'novel/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: `${BASE}index.html`,
        navigateFallbackDenylist: ['voicevox', 'aivis', 'ocr', 'shot', 'video', 'novel'].map((p) => new RegExp(`^${BASE}${p}/`)),
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // OCRエンジン本体（数MB）は初回使用時にキャッシュ
            urlPattern: ({ url }) => url.pathname.startsWith(`${BASE}tesseract/`) || url.pathname.startsWith(`${BASE}pdfjs/`),
            handler: 'CacheFirst',
            options: { cacheName: 'yomiage-engine', expiration: { maxEntries: 400 } },
          },
          {
            // OCR日本語データ（jsDelivr, 各約2MB）
            urlPattern: ({ url }) => url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('tesseract.js-data'),
            handler: 'CacheFirst',
            options: { cacheName: 'yomiage-ocr-lang', expiration: { maxEntries: 10 }, cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
    }),
  ],
});
