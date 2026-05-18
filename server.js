const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const chokidar = require('chokidar');
const { buildManifest, patchManifest } = require('./lib/scanner');
const { streamCommand } = require('./lib/shell');
const { readFile, writeFile, listDir } = require('./lib/file-api');

const app = express();
const PORT = process.env.PORT || 4001;
const SITE_ROOT = process.env.JEKYLL_SITE || process.cwd();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Load optional site config
let siteConfig = {};
const configPath = path.join(SITE_ROOT, 'jekyll-admin.config.js');
if (fs.existsSync(configPath)) {
  try { siteConfig = require(configPath); } catch (_) {}
}

// Debug secret (optional)
const DEBUG_SECRET = siteConfig.debug?.secret || process.env.JEKYLL_ADMIN_SECRET || null;

function checkDebugAuth(req, res) {
  if (!DEBUG_SECRET) return true;
  const provided = req.query.secret || req.headers['x-debug-secret'];
  if (provided !== DEBUG_SECRET) {
    res.status(403).json({ error: 'Debug secret required' });
    return false;
  }
  return true;
}

// ── Site Manifest ─────────────────────────────────────────────────────────────

let manifest = null;
let manifestBuilding = false;
let refreshTimer = null;

async function refreshManifest(changedFile) {
  if (manifestBuilding) return;
  manifestBuilding = true;
  try {
    if (changedFile && manifest) {
      manifest = await patchManifest(manifest, changedFile, SITE_ROOT);
    } else {
      manifest = await buildManifest(SITE_ROOT);
    }
    console.log(`[jekyll-admin] ${manifest.totals.posts} posts, ${manifest.totals.layouts} layouts, ${manifest.totals.plugins} plugins`);
  } catch (e) {
    console.error('[jekyll-admin] Manifest error:', e.message);
  } finally {
    manifestBuilding = false;
  }
}

// Incremental watcher — passes the changed file path so only that section rescans
chokidar.watch([
  path.join(SITE_ROOT, '_posts'),
  path.join(SITE_ROOT, '_layouts'),
  path.join(SITE_ROOT, '_plugins'),
  path.join(SITE_ROOT, '_includes'),
  path.join(SITE_ROOT, '_data'),
], { ignoreInitial: true, ignored: /(_site|node_modules)/ })
  .on('all', (event, changedPath) => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshManifest(changedPath), 300);
  });

// ── Manifest API ──────────────────────────────────────────────────────────────

app.get('/api/manifest', (req, res) => res.json(manifest));
app.get('/api/manifest/layouts', (req, res) => res.json(manifest?.layouts || {}));
app.get('/api/manifest/plugins', (req, res) => res.json(manifest?.plugins || []));
app.get('/api/manifest/includes', (req, res) => res.json(manifest?.includes || {}));
app.get('/api/manifest/datafiles', (req, res) => res.json(manifest?.dataFiles || []));

// ── File API ──────────────────────────────────────────────────────────────────

app.get('/api/files', (req, res) => {
  try {
    res.json(listDir(SITE_ROOT, req.query.path || '.'));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/file', (req, res) => {
  try {
    res.json(readFile(SITE_ROOT, req.query.path));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/file', (req, res) => {
  try {
    const result = writeFile(SITE_ROOT, req.query.path, req.body);
    setTimeout(refreshManifest, 200);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Media Upload ──────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dest = path.join(SITE_ROOT, req.query.dir || 'assets/images');
      fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const rel = path.relative(SITE_ROOT, req.file.path);
  res.json({ path: rel, size: req.file.size });
});

// ── Shell / Build ─────────────────────────────────────────────────────────────

const ALLOWED_PRESETS = {
  build: ['bundle', ['exec', 'jekyll', 'build']],
  serve: ['bundle', ['exec', 'jekyll', 'serve', '--livereload']],
  'build:css': ['npm', ['run', 'build:css']],
};

app.post('/api/shell', (req, res) => {
  const { preset, cmd, args } = req.body;
  if (preset && ALLOWED_PRESETS[preset]) {
    const [command, cmdArgs] = ALLOWED_PRESETS[preset];
    return streamCommand(command, cmdArgs, SITE_ROOT, res);
  }
  if (cmd) return streamCommand(cmd, args || [], SITE_ROOT, res);
  res.status(400).json({ error: 'Provide preset or cmd' });
});

// ── Debug API ─────────────────────────────────────────────────────────────────

app.get('/api/debug/state', (req, res) => {
  if (!checkDebugAuth(req, res)) return;
  res.json({
    manifest: manifest ? { scannedAt: manifest.scannedAt, totals: manifest.totals } : null,
    siteRoot: SITE_ROOT,
    nodeVersion: process.version,
    uptime: process.uptime(),
  });
});

app.post('/api/debug/flag', (req, res) => {
  if (!checkDebugAuth(req, res)) return;
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    const featPath = path.join(SITE_ROOT, '_data', 'features.json');
    const features = JSON.parse(fs.readFileSync(featPath, 'utf8'));
    const parts = key.split('.');
    let obj = features;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
    fs.writeFileSync(featPath, JSON.stringify(features, null, 2) + '\n');
    res.json({ ok: true, key, value });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/debug/simulate', (req, res) => {
  if (!checkDebugAuth(req, res)) return;
  const { mode } = req.body;
  const validModes = ['email', 'push', 'pwa', 'none'];
  if (!validModes.includes(mode)) return res.status(400).json({ error: 'mode must be email|push|pwa|none' });
  res.cookie('_sim_sub', mode === 'none' ? '' : mode, { httpOnly: false, maxAge: 3600000 });
  res.json({ ok: true, mode });
});

app.post('/api/debug/rebuild', (req, res) => {
  if (!checkDebugAuth(req, res)) return;
  streamCommand('bundle', ['exec', 'jekyll', 'build'], SITE_ROOT, res);
});

app.get('/api/debug/search-index', (req, res) => {
  if (!checkDebugAuth(req, res)) return;
  const indexPath = path.join(SITE_ROOT, 'assets', 'js', 'search-index.json');
  if (!fs.existsSync(indexPath)) return res.json({ exists: false });
  const stat = fs.statSync(indexPath);
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    res.json({ exists: true, size: stat.size, modified: stat.mtime, count: Array.isArray(data) ? data.length : Object.keys(data).length });
  } catch (_) {
    res.json({ exists: true, size: stat.size, modified: stat.mtime, count: null });
  }
});

// ── Config endpoint ───────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({ siteRoot: SITE_ROOT, siteConfig, port: PORT });
});

// ── Start ─────────────────────────────────────────────────────────────────────

refreshManifest().then(() => {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  jekyll-admin  →  http://localhost:${PORT}`);
    console.log(`  site root     →  ${SITE_ROOT}\n`);
  });
});
