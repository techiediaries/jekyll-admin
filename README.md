# jekyll-admin

Local-first web UI for managing any Jekyll site. Run it alongside `jekyll serve` and get a full admin panel at `localhost:4001`.

![Jekyll Admin Inspector](https://placehold.co/900x500/0f1117/58a6ff?text=jekyll-admin+inspector)

## Features

- **Inspector** — site health at a glance: layout usage (how many posts use each layout, with links), custom plugin breakdown (type, what they produce), include usage (orphan detection), data file map
- **Posts** — browse all posts, filter by layout, search by title, open in preview
- **Data Files** — edit any `_data/*.yml` or `_data/*.json` with a live editor
- **Media** — browse `assets/`, preview images, drag-drop upload
- **Build** — run `jekyll build`, `jekyll serve`, or `build:css` with real-time streaming output
- **Debug** — toggle feature flags live, simulate subscriber states, build shareable test URLs

## Quickstart

```bash
# from your Jekyll site root
npx jekyll-admin

# or point it at a site from anywhere
npx jekyll-admin /path/to/your-jekyll-site

# then open
open http://localhost:4001
```

Or install globally:

```bash
npm install -g jekyll-admin
jekyll-admin
```

## How it works

On startup, jekyll-admin scans your site and builds a **site manifest** — a JSON snapshot of your layouts, posts, plugins, includes, and data files. Every tab in the UI reads from this manifest. It re-scans automatically when files change (via chokidar).

The manifest is also available as a REST API:

```
GET /api/manifest              → full site manifest
GET /api/manifest/layouts      → layout breakdown with post lists
GET /api/manifest/plugins      → plugin metadata
GET /api/manifest/includes     → include usage map
GET /api/manifest/datafiles    → data file list with key preview
```

## Plugin config (optional)

Drop a `jekyll-admin.config.js` in your site root to customize:

```js
// jekyll-admin.config.js
module.exports = {
  debug: {
    enabled: true,
    secret: 'my-secret',   // required for ?debug= in production; omit for local-only
  },
  mediaDir: 'assets/images',
}
```

## Debug panel

The debug panel is gated by a feature flag — safe to leave enabled in production when a secret is set.

**Activate:**
- Locally: `http://localhost:4001` — always open
- Production: `https://yoursite.com?debug=your-secret`

**Debug API** — every panel action is also a REST endpoint, callable by humans or LLMs:

```
GET  /api/debug/state                          → build state, uptime
POST /api/debug/flag   { key, value }          → toggle a feature flag in _data/features.json
POST /api/debug/simulate { mode }              → set subscriber cookie (email|push|pwa|none)
POST /api/debug/rebuild                        → trigger jekyll build (SSE stream)
GET  /api/debug/search-index                   → search index stats
```

All `/api/debug/*` endpoints require `?secret=<your-secret>` header when a secret is configured.

## File API

```
GET  /api/files?path=_posts           → list directory
GET  /api/file?path=_posts/foo.md     → read file (front matter parsed separately)
PUT  /api/file?path=_posts/foo.md     → write file
POST /api/upload?dir=assets/images    → upload media file
POST /api/shell                       → run jekyll/npm command (SSE stream)
```

## Roadmap

- [ ] Post editor with front matter form + markdown editor
- [ ] Data file schema editor (structured forms, not raw YAML)
- [ ] FlexSearch-powered search index builder
- [ ] MCP server shim — expose debug API as Claude Code tools
- [ ] `npx jekyll-admin` zero-config entry point

## License

MIT
