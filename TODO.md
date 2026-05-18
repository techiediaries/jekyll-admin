# TODO — jekyll-admin

Local-first web UI for managing any Jekyll site.
Stack: Node.js + Express + js-yaml + vanilla JS
Plugin system: jekyll-admin.config.js at project root for site-specific schemas.
First consumer: ahmedbouchefra2

Design principles:
- Site manifest is the foundation — generated at startup, everything else reads from it
- Every UI action is backed by a REST API call — UI and LLM/automation use identical endpoints
- Debug panel available in both local and prod, gated by feature flag + ?debug=<secret>
- All state is file-system — no database

---

## Current

## Backlog

<!-- P1 and P2 complete — 2026-05-18 -->


### P1 — Server + Site Manifest (foundation everything builds on)

The site manifest is a JSON snapshot of the Jekyll site structure produced at startup.
Post editor, data editor, inspector UI, and debug panel all read from it.
This is why Inspector is P1, not P5.

- [ ] Init: npm init, install express + js-yaml + chokidar + gray-matter
- [ ] server.js: Express app on port 4001

#### Site manifest generator (core of P1)
- [ ] On startup: scan site, produce in-memory `siteManifest` object:
  ```
  {
    layouts: { post: { count: 421, posts: [{title, url, path, date}] }, bpost: {...}, ... },
    plugins: [ { file, type, produces, consumes, skippable } ],
    dataFiles: [ { path, type, size, keys[] } ],
    includes: { "header_zen.html": { usedBy: ["post.html","bpost.html",...] } },
    assets: { images: N, totalSize },
    buildConfig: { skipTailwind, limitPosts, incremental }
  }
  ```
- [ ] GET /api/manifest — return full siteManifest as JSON
- [ ] GET /api/manifest/layouts — layout breakdown with post list (title + path + date per post)
- [ ] GET /api/manifest/plugins — plugin list with type/produces/consumes
- [ ] GET /api/manifest/includes — includes with which layouts reference each
- [ ] GET /api/manifest/datafiles — _data/ file list with key preview
- [ ] Watch mode: chokidar watches _posts/, _layouts/, _plugins/, _data/ → re-scan on change

#### File API
- [ ] GET /api/files?path= — list directory (posts, data, assets)
- [ ] GET /api/file?path= — read file (gray-matter separates front matter from body)
- [ ] PUT /api/file?path= — write file (reassemble front matter + body)
- [ ] POST /api/shell — run safe command (jekyll build, npm run build:css), stream via SSE
- [ ] Jekyll proxy: pipe `jekyll serve` stdout → SSE stream for build status in UI

#### UI shell
- [ ] Sidebar nav: Inspector | Posts | Data | Media | Debug
- [ ] Inspector is the HOME tab (not Posts) — shows site health at a glance
- [ ] Embed jekyll serve in iframe at localhost:4000

---

### P2 — Inspector UI (site health dashboard)

Built on top of siteManifest from P1. No extra scanning needed.

#### Layout inspector
- [ ] Table: layout name | post count | last updated | link to layout file
- [ ] Expand row: list all posts using that layout (title + date + clickable path)
- [ ] ahmedbouchefra2 real data:
  - post × 421, bookpost × 96, bpost × 27+2, tool_single × 10
  - nostorypost × 9, roadmappost × 4, socialpost × 2
  - vintage_newspaper_post × 1, storypost × 1, story_layout_ar × 1, coursepost × 1
- [ ] Flag: layouts with 0 posts (unused)
- [ ] Flag: posts using a layout file that doesn't exist in _layouts/

#### Plugin inspector
- [ ] Table: plugin file | type | produces | consumes | skippable
- [ ] ahmedbouchefra2 real plugins:
  - `tailwind_compiler.rb` — Hook (after_reset) — produces: assets/css/tailwind.css — consumes: assets/css/tailwind.src.css — skippable: yes (skip_tailwind: true)
  - `generate_notifications.rb` — Hook (post_read) — produces: _data/notifications.yml — consumes: site.posts, _data/authors.yml, _data/skip_categories — skippable: no
  - `generate_channels_json.rb` — Generator — produces: channels.json — consumes: _data/yt/youtube_channels_v*.yml — skippable: no
- [ ] Show last-modified date of each produced file (so you can see if it's stale)
- [ ] Link: click produced file → opens in Data editor

#### Includes inspector
- [ ] Table: include file | used by (layout list) | lines of code
- [ ] Flag: includes used in 0 layouts (orphaned)
- [ ] Flag: includes used in layouts that lack the post.stories feature flag guard (the bug we kept hitting)

#### Config viewer
- [ ] Show _config.yml and _config_dev.yml side-by-side (read-only)
- [ ] Highlight keys that differ between dev and prod configs

---

### P3 — Post editor
- [ ] Post list: sorted by date, filter by layout (uses manifest layout list)
- [ ] Front matter form: auto-generate fields from YAML keys (text, date, select, toggle)
- [ ] Markdown textarea with basic toolbar (bold, italic, link, image insert)
- [ ] New post: slug from title, date picker, layout selector (populated from manifest.layouts)
- [ ] Delete: move to _drafts/ — never hard delete
- [ ] Save: PUT /api/file → trigger jekyll rebuild

### P4 — Data file editor
- [ ] Load jekyll-admin.config.js from project root (fallback: auto-detect _data/*.yml from manifest)
- [ ] YAML arrays → editable list with add/remove/reorder
- [ ] YAML objects → key-value form
- [ ] Schema hints from config: field types (color picker, url, toggle, select)
- [ ] Save: PUT /api/file preserving comments where possible

### P5 — Media browser
- [ ] File tree: browse assets/ directory
- [ ] Preview images inline, other files show size + type
- [ ] Upload: drag-drop → POST /api/upload → saves to assets/
- [ ] Click file → copy relative path to clipboard
- [ ] Delete: confirm dialog

### P6 — Plugin config system
- [ ] Define jekyll-admin.config.js schema: `{ dataFiles[], postLayouts[], mediaDir, customSections[], debug }`
- [ ] Load at startup, merge with auto-detected manifest defaults
- [ ] ahmedbouchefra2 adapter: stories.yml, features.json, categories.yml, promo_cards.json schemas
- [ ] Custom section example: "Stories" — renders _data/stories.yml as story group editor

### P7 — Debug UI + LLM/automation layer
- [ ] Access pattern: feature-flagged overlay, available in both local and prod
  - [ ] `debug: { enabled: true, secret: "my-secret" }` in jekyll-admin.config.js
  - [ ] URL activation: `?debug` (local, no secret) or `?debug=<secret>` (prod)
  - [ ] Panel renders as floating sidebar, injected by debug.js loaded via feature flag
- [ ] Debug panel UI sections:
  - [ ] Site state: last build time, duration, error log tail, jekyll serve status
  - [ ] Feature flags: live toggle of _data/features.json — writes file + triggers rebuild
  - [ ] Active promo cards: drag to reorder, toggle, see current showing card
  - [ ] Story preview: render any story group in overlay, scrub through slides
  - [ ] Gate simulator: set subscriber cookie — email|push|pwa (mirrors ?_sub= pattern)
  - [ ] Search index: stats, trigger manual rebuild
  - [ ] URL builder: compose ?debug + ?_sub= + ?_teaser= combos → copy or open in tab
- [ ] LLM/automation API — same secret, every panel action has a matching REST endpoint:
  - [ ] GET  /api/debug/state
  - [ ] POST /api/debug/flag   `{ key: "post.stories", value: false }`
  - [ ] POST /api/debug/promo  `{ active: ["push-library", "pwa-install"] }`
  - [ ] POST /api/debug/rebuild (SSE stream)
  - [ ] POST /api/debug/simulate `{ mode: "push" }`
  - [ ] GET  /api/debug/search-index
  - [ ] POST /api/debug/search  `{ q: "react hooks" }`
- [ ] MCP server shim: expose /api/debug/* as MCP tools for Claude Code
  - [ ] mcp-server.mjs: toggle_flag, set_promo, rebuild, simulate_subscriber, search
  - [ ] Register at http://localhost:4001/mcp in Claude Code settings

### P8 — Polish + open source
- [ ] README.md: quickstart (npx jekyll-admin), plugin config API, debug/LLM API docs, screenshots
- [ ] package.json bin: npx jekyll-admin → starts server + opens browser at /inspector
- [ ] .gitignore, LICENSE (MIT)
- [ ] gh repo create techiediaries/jekyll-admin --public
- [ ] Push and announce

---

## Notes — design decisions

- **Email sending:** provider-agnostic adapter — `sendEmail({to,subject,html,from}, env)`; switch via `EMAIL_PROVIDER` env var, no code changes. Providers: Resend, SendGrid, Brevo, Mailgun, Postmark.
- **Search:** FlexSearch document store + IndexedDB cache by build timestamp. Never Algolia.
- **Inspector is P1 not P5** — the site manifest it produces is the data layer for post editor (layout list), data editor (file list), and debug panel (flag keys). Building it last would mean rebuilding that scan 3 times.

## Done

- [x] P1: server.js + lib/scanner.js + lib/shell.js + lib/file-api.js — 2026-05-18
- [x] P2: Inspector UI — layouts (with post list), plugins, includes, data files, stats — 2026-05-18
- [x] Posts tab — filterable by layout + search — 2026-05-18
- [x] Data tab — file list + raw editor — 2026-05-18
- [x] Media tab — browser + upload — 2026-05-18
- [x] Build tab — jekyll build/serve with SSE streaming output — 2026-05-18
- [x] Debug tab — feature flag toggles, gate simulator, URL builder, server state — 2026-05-18
