# Architecture and migration boundary

- Static UI/assets: root `index.html`, `assets/`, `manifest.webmanifest`, `sw.js`.
- API and persistence: `worker/src/index.js`, `worker/wrangler.toml` (KV); deploy from `worker/`.

Keep all public asset paths and the Worker name stable. The service-worker precache list makes asset moves unsafe without a cache migration. Agent tools should expose validated game-data operations rather than direct file writes.
