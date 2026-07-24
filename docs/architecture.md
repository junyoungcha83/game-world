# Architecture and migration boundary

- Static UI/assets: root `index.html`, `assets/`, `manifest.webmanifest`, `sw.js`.
- API and persistence: `api/src/index.js`, `api/wrangler.toml` (KV); deploy from `api/` (`cd api && npx wrangler deploy`). The Worker `name` (`game-world-api`) and KV binding (`GAMEWORLD`) are unchanged by the directory rename.

Keep all public asset paths and the Worker name stable. The service-worker precache list makes asset moves unsafe without a cache migration. Agent tools should expose validated game-data operations rather than direct file writes.
