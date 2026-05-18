const fs   = require('fs');
const fsp  = fs.promises;
const path = require('path');
const os   = require('os');
const matter = require('gray-matter');
const yaml   = require('js-yaml');
const { fdir } = require('fdir');

// ── Directory walking (fdir — 10× faster than custom walkDir) ────────────────

function crawl(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  return new fdir()
    .withFullPaths()
    .exclude(d => d === 'node_modules' || d === '_site' || d.startsWith('.'))
    .filter(f => exts.includes(path.extname(f)))
    .crawl(dir)
    .sync();
}

// ── Front-matter-only reading ─────────────────────────────────────────────────
// Reads only the first 4 KB of each post instead of the full file.
// 421 posts × 4 KB = 1.7 MB vs 421 × ~15 KB = 6 MB+ previously.

const FM_CHUNK = 4096;

async function readFrontMatter(filePath) {
  let fd;
  try {
    fd = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(FM_CHUNK);
    const { bytesRead } = await fd.read(buf, 0, FM_CHUNK, 0);
    const chunk = buf.slice(0, bytesRead).toString('utf8');

    if (!chunk.startsWith('---')) return {};
    const end = chunk.indexOf('\n---', 3);
    if (end === -1) {
      // front matter > 4 KB — fall back to full read
      const full = await fsp.readFile(filePath, 'utf8');
      return matter(full).data;
    }
    return matter(chunk.slice(0, end + 4)).data;
  } catch (_) {
    return {};
  } finally {
    if (fd) await fd.close();
  }
}

// ── Persistent cache ──────────────────────────────────────────────────────────
// Stored in OS temp dir so it never pollutes the site repo.
// Cache path: /tmp/jekyll-admin/<urlencoded-siteRoot>/cache.json

const CACHE_VERSION = 2;

function cachePath(siteRoot) {
  const key = encodeURIComponent(siteRoot);
  const dir = path.join(os.tmpdir(), 'jekyll-admin', key);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'cache.json');
}

function loadCache(siteRoot) {
  try {
    const raw = fs.readFileSync(cachePath(siteRoot), 'utf8');
    const c = JSON.parse(raw);
    return c.version === CACHE_VERSION ? c : null;
  } catch (_) { return null; }
}

function saveCache(siteRoot, manifest, fps) {
  try {
    fs.writeFileSync(cachePath(siteRoot),
      JSON.stringify({ version: CACHE_VERSION, fps, manifest }));
  } catch (_) {}
}

// ── Fingerprinting ────────────────────────────────────────────────────────────
// Cheap mtime sum per directory section. Changes when files are added,
// removed, or modified. Collision probability is negligible.

const SECTIONS = {
  posts:    { dir: '_posts',    exts: ['.md', '.markdown', '.html'] },
  layouts:  { dir: '_layouts',  exts: ['.html'] },
  plugins:  { dir: '_plugins',  exts: ['.rb'] },
  includes: { dir: '_includes', exts: ['.html', '.svg', '.liquid', '.md'] },
  data:     { dir: '_data',     exts: ['.yml', '.yaml', '.json'] },
};

function fingerprint(dir, exts) {
  const files = crawl(dir, exts);
  let n = files.length * 1e9; // file count weighted heavily to catch add/remove
  for (const f of files) {
    try { n += fs.statSync(f).mtimeMs; } catch (_) {}
  }
  return n;
}

function currentFps(siteRoot) {
  const fps = {};
  for (const [key, { dir, exts }] of Object.entries(SECTIONS)) {
    fps[key] = fingerprint(path.join(siteRoot, dir), exts);
  }
  return fps;
}

// ── Scan functions (all async, all independent → run in parallel) ─────────────

async function scanLayouts(siteRoot) {
  const dir = path.join(siteRoot, '_layouts');
  const layouts = {};
  if (!fs.existsSync(dir)) return layouts;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.html')) continue;
    const name = f.slice(0, -5);
    if (name.startsWith('retired_')) continue;
    layouts[name] = { file: path.join('_layouts', f), posts: [], missing: false };
  }
  return layouts;
}

function slugToUrl(base) {
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})-(.+)$/);
  return m ? `/${m[1]}/${m[2]}/${m[3]}/${m[4]}/` : `/${base}/`;
}

async function scanPosts(siteRoot, layouts) {
  const dir = path.join(siteRoot, '_posts');
  const files = crawl(dir, ['.md', '.markdown', '.html'])
    .filter(f => {
      const b = path.basename(f);
      return !b.endsWith('.bak') && !b.endsWith('.txt') && !b.includes(' copy');
    });

  // Parse all front matters in parallel
  const parsed = await Promise.all(files.map(async f => {
    const data = await readFrontMatter(f);
    const base = path.basename(f, path.extname(f));
    return {
      title:  data.title  || path.basename(f),
      layout: (data.layout || '').trim(),
      date:   data.date ? new Date(data.date).toISOString().split('T')[0] : null,
      url:    data.permalink || slugToUrl(base),
      path:   path.relative(siteRoot, f),
    };
  }));

  const posts = [];
  for (const post of parsed) {
    posts.push(post);
    if (!post.layout) continue;
    if (!layouts[post.layout]) {
      layouts[post.layout] = { file: null, posts: [], missing: true };
    }
    layouts[post.layout].posts.push(post);
  }
  return posts;
}

async function scanPlugins(siteRoot) {
  const dir = path.join(siteRoot, '_plugins');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.rb') && !f.endsWith('.rb.disabled'));

  return Promise.all(files.map(async f => {
    const content = await fsp.readFile(path.join(dir, f), 'utf8');
    let type = 'Unknown', hookEvent = null;
    if (/Jekyll::Hooks\.register/.test(content)) {
      type = 'Hook';
      const m = content.match(/Hooks\.register\s+:(\w+),\s*:(\w+)/);
      if (m) hookEvent = `${m[1]}:${m[2]}`;
    } else if (/Jekyll::Generator|< Generator/.test(content)) {
      type = 'Generator';
    } else if (/Jekyll::Converter|< Converter/.test(content)) {
      type = 'Converter';
    } else if (/Liquid::Tag|< Tag/.test(content)) {
      type = 'Tag';
    }
    const produces = [...new Set(
      [...content.matchAll(/['"]([^'"]*\.(yml|json|css|js))['"]/g)]
        .map(m => m[1])
        .filter(s => s.includes('/') && !s.includes('*'))
    )].slice(0, 4);
    const descLines = [];
    for (const line of content.split('\n').slice(0, 8)) {
      const t = line.trim();
      if (t.startsWith('#')) descLines.push(t.slice(1).trim());
      else if (descLines.length) break;
    }
    return {
      file: path.join('_plugins', f),
      name: f,
      type: hookEvent ? `Hook (${hookEvent})` : type,
      produces,
      skippable: /site\.config\[['"]skip_/.test(content),
      description: descLines.filter(Boolean).join(' ').slice(0, 150),
    };
  }));
}

async function scanIncludes(siteRoot) {
  const dir = path.join(siteRoot, '_includes');
  if (!fs.existsSync(dir)) return {};

  const files = crawl(dir, ['.html', '.svg', '.liquid', '.md']);
  const includes = {};
  for (const f of files) {
    const name = path.relative(dir, f);
    includes[name] = { file: path.join('_includes', name), usedBy: [], lines: 0 };
  }

  // Count lines and scan layouts for {% include %} references in parallel
  const layoutFiles = crawl(path.join(siteRoot, '_layouts'), ['.html']);
  const rootHtmlFiles = fs.readdirSync(siteRoot)
    .filter(f => f.endsWith('.html'))
    .map(f => path.join(siteRoot, f));

  await Promise.all([
    // Line counts
    ...files.map(async f => {
      try {
        const c = await fsp.readFile(f, 'utf8');
        includes[path.relative(dir, f)].lines = c.split('\n').length;
      } catch (_) {}
    }),
    // Include usage scan
    ...[...layoutFiles, ...rootHtmlFiles].map(async f => {
      try {
        const content = await fsp.readFile(f, 'utf8');
        const rel = path.relative(siteRoot, f);
        for (const m of content.matchAll(/\{%-?\s*include\s+([\w./\-]+)/g)) {
          const inc = m[1].trim();
          if (includes[inc]) includes[inc].usedBy.push(rel);
        }
      } catch (_) {}
    }),
  ]);

  for (const inc of Object.values(includes)) {
    inc.orphan = inc.usedBy.length === 0;
  }
  return includes;
}

async function scanDataFiles(siteRoot) {
  const dir = path.join(siteRoot, '_data');
  if (!fs.existsSync(dir)) return [];
  const files = crawl(dir, ['.yml', '.yaml', '.json']);

  return Promise.all(files.map(async f => {
    const rel = path.relative(siteRoot, f);
    const stat = fs.statSync(f);
    let keys = [];
    try {
      const raw = await fsp.readFile(f, 'utf8');
      const parsed = f.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
      if (parsed && typeof parsed === 'object') {
        keys = Array.isArray(parsed) ? [`array[${parsed.length}]`] : Object.keys(parsed).slice(0, 12);
      }
    } catch (_) {}
    return { path: rel, size: stat.size, modified: stat.mtime.toISOString(), keys };
  }));
}

// ── Manifest builder ──────────────────────────────────────────────────────────

function finalizeLayouts(layouts, posts) {
  const summary = {};
  for (const [name, data] of Object.entries(layouts)) {
    summary[name] = {
      file: data.file,
      count: data.posts.length,
      missing: data.missing,
      posts: data.posts.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    };
  }
  return summary;
}

async function buildManifest(siteRoot) {
  const t0 = Date.now();
  const fps = currentFps(siteRoot);
  const cache = loadCache(siteRoot);

  // Determine which sections need rescanning
  const stale = !cache ? Object.keys(SECTIONS)
    : Object.keys(SECTIONS).filter(k => fps[k] !== cache.fps[k]);

  if (stale.length === 0) {
    console.log(`[scanner] Cache hit — manifest loaded in ${Date.now() - t0}ms`);
    return cache.manifest;
  }

  // Seed from cache for sections that haven't changed
  let layouts  = stale.includes('layouts')  ? null : cache?.manifest._layoutsRaw;
  let posts    = stale.includes('posts')    ? null : cache?.manifest.posts;
  let plugins  = stale.includes('plugins')  ? null : cache?.manifest.plugins;
  let includes = stale.includes('includes') ? null : cache?.manifest.includes;
  let dataFiles = stale.includes('data')    ? null : cache?.manifest.dataFiles;

  // Scan stale sections in parallel
  const tasks = [];
  if (!layouts)   tasks.push(scanLayouts(siteRoot).then(r  => { layouts   = r; }));
  if (!plugins)   tasks.push(scanPlugins(siteRoot).then(r  => { plugins   = r; }));
  if (!includes)  tasks.push(scanIncludes(siteRoot).then(r => { includes  = r; }));
  if (!dataFiles) tasks.push(scanDataFiles(siteRoot).then(r=> { dataFiles = r; }));

  await Promise.all(tasks);

  // Posts need layouts to be ready first (to link them)
  if (!posts) {
    if (!layouts) layouts = await scanLayouts(siteRoot); // already done above
    posts = await scanPosts(siteRoot, layouts);
  } else if (stale.includes('layouts') && !stale.includes('posts')) {
    // Layouts changed but posts didn't — redistribute existing posts into new layout map
    for (const post of posts) {
      if (!post.layout) continue;
      if (!layouts[post.layout]) layouts[post.layout] = { file: null, posts: [], missing: true };
      layouts[post.layout].posts.push(post);
    }
  }

  const manifest = {
    siteRoot,
    scannedAt: new Date().toISOString(),
    totals: {
      posts:     posts.length,
      layouts:   Object.keys(layouts).length,
      plugins:   plugins.length,
      includes:  Object.keys(includes).length,
      dataFiles: dataFiles.length,
    },
    layouts:    finalizeLayouts(layouts),
    _layoutsRaw: layouts, // kept for incremental patch
    posts,                // kept for incremental patch
    plugins,
    includes,
    dataFiles,
  };

  saveCache(siteRoot, manifest, fps);
  console.log(`[scanner] Scanned (${stale.join(', ')}) in ${Date.now() - t0}ms — ${posts.length} posts`);
  return manifest;
}

// ── Incremental patch — called on chokidar file change ────────────────────────
// Re-scans only the section that owns the changed file.

async function patchManifest(manifest, changedFile, siteRoot) {
  const rel = path.relative(siteRoot, changedFile);
  const t0 = Date.now();
  let section;

  if (rel.startsWith('_posts/')) {
    section = 'post';
    const exists = fs.existsSync(changedFile);

    // Remove old entry from flat posts list and layout buckets
    const oldPost = manifest.posts.find(p => p.path === rel);
    if (oldPost) {
      manifest.posts = manifest.posts.filter(p => p.path !== rel);
      const bucket = manifest.layouts[oldPost.layout];
      if (bucket) {
        bucket.posts = bucket.posts.filter(p => p.path !== rel);
        bucket.count = bucket.posts.length;
      }
    }

    if (exists) {
      const base = path.basename(changedFile, path.extname(changedFile));
      const data = await readFrontMatter(changedFile);
      const layout = (data.layout || '').trim();
      const post = {
        title:  data.title || path.basename(changedFile),
        layout,
        date:   data.date ? new Date(data.date).toISOString().split('T')[0] : null,
        url:    data.permalink || slugToUrl(base),
        path:   rel,
      };
      manifest.posts.push(post);
      if (layout) {
        if (!manifest.layouts[layout]) {
          manifest.layouts[layout] = { file: null, count: 0, missing: true, posts: [] };
        }
        manifest.layouts[layout].posts.push(post);
        manifest.layouts[layout].posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        manifest.layouts[layout].count = manifest.layouts[layout].posts.length;
      }
    }
    manifest.totals.posts = manifest.posts.length;

  } else if (rel.startsWith('_layouts/')) {
    section = 'layouts';
    const layouts = await scanLayouts(siteRoot);
    for (const post of manifest.posts) {
      if (!post.layout) continue;
      if (!layouts[post.layout]) layouts[post.layout] = { file: null, posts: [], missing: true };
      layouts[post.layout].posts.push(post);
    }
    manifest.layouts = finalizeLayouts(layouts);
    manifest._layoutsRaw = layouts;
    manifest.totals.layouts = Object.keys(layouts).length;

  } else if (rel.startsWith('_plugins/')) {
    section = 'plugins';
    manifest.plugins = await scanPlugins(siteRoot);
    manifest.totals.plugins = manifest.plugins.length;

  } else if (rel.startsWith('_includes/')) {
    section = 'includes';
    manifest.includes = await scanIncludes(siteRoot);
    manifest.totals.includes = Object.keys(manifest.includes).length;

  } else if (rel.startsWith('_data/')) {
    section = 'data';
    manifest.dataFiles = await scanDataFiles(siteRoot);
    manifest.totals.dataFiles = manifest.dataFiles.length;

  } else {
    return manifest; // untracked file — no-op
  }

  manifest.scannedAt = new Date().toISOString();

  // Update cache fingerprint for this section
  const sectionKey = { post: 'posts', layouts: 'layouts', plugins: 'plugins', includes: 'includes', data: 'data' }[section];
  const cache = loadCache(siteRoot) || { fps: {} };
  const sectionInfo = SECTIONS[sectionKey];
  if (sectionInfo) {
    cache.fps[sectionKey] = fingerprint(path.join(siteRoot, sectionInfo.dir), sectionInfo.exts);
    saveCache(siteRoot, manifest, cache.fps);
  }

  console.log(`[scanner] Patched ${section} in ${Date.now() - t0}ms`);
  return manifest;
}

module.exports = { buildManifest, patchManifest };
