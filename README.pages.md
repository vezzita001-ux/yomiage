# よみあげ（GitHub Pages 版）

PDF・画像・テキスト・ePub を読み上げる PWA のフロントエンドです。

- アプリ： https://vezzita001-ux.github.io/yomiage/
- 音声（VOICEVOX / AivisSpeech）・サーバーOCR を使う時は、設定の「サーバーURL（音声・OCR用）」にサーバーの URL を入れてください。
- 本棚（IndexedDB）はこの URL（オリジン）に保存されるので、サーバーの URL が変わっても消えません。

`main` に push すると GitHub Actions がビルドして Pages に公開します（`YOMIAGE_BASE=/yomiage/`）。
