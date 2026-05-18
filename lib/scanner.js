const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const yaml = require('js-yaml');

function walkDir(dir, exts) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '_site') {
      results.push(...walkDir(full, exts));
    } else if (entry.isFile() && exts.includes(path.extname(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

function slugToUrl(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const match = base.match(/^(\d{4})-(\d{2})-(\d{2})-(.+)$/);
  if (match) return `/${match[1]}/${match[2]}/${match[3]}/${match[4]}/`;
  return `/${base}/`;
}

function scanLayouts(siteRoot) {
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

function scanPosts(siteRoot, layouts) {
  const dir = path.join(siteRoot, '_posts');
  const files = walkDir(dir, ['.md', '.markdown', '.html']);
  const posts = [];

  for (const file of files) {
    const base = path.basename(file);
    if (base.endsWith('.bak') || base.endsWith('.txt') || base.includes(' copy')) continue;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const { data } = matter(raw);
      const rel = path.relative(siteRoot, file);
      const layout = (data.layout || '').trim();
      const title = data.title || base;
      const date = data.date ? new Date(data.date).toISOString().split('T')[0] : null;
      const url = data.permalink || slugToUrl(base);
      const post = { title, layout, date, url, path: rel };
      posts.push(post);

      if (!layout) continue;
      if (!layouts[layout]) layouts[layout] = { file: null, posts: [], missing: true };
      layouts[layout].posts.push(post);
    } catch (_) {}
  }
  return posts;
}

function detectPluginMeta(content, filename) {
  let type = 'Unknown';
  let hookEvent = null;

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

  // Extract produces: look for output_file or File.write patterns
  const produces = [];
  for (const m of content.matchAll(/['"]([^'"]*\.(yml|json|css|js|html))['"]/g)) {
    const candidate = m[1];
    if (candidate.includes('/') || !candidate.startsWith('http')) {
      if (/\.(yml|json|css|js)$/.test(candidate) && !candidate.includes('*')) {
        produces.push(candidate);
      }
    }
  }

  // First comment block as description
  const descLines = [];
  for (const line of content.split('\n').slice(0, 8)) {
    const t = line.trim();
    if (t.startsWith('#')) descLines.push(t.slice(1).trim());
    else if (descLines.length) break;
  }

  const skippable = /site\.config\[['"]skip_/.test(content);

  return {
    file: path.join('_plugins', filename),
    name: filename,
    type: hookEvent ? `Hook (${hookEvent})` : type,
    produces: [...new Set(produces)].slice(0, 4),
    skippable,
    description: descLines.filter(Boolean).join(' ').slice(0, 150),
  };
}

function scanPlugins(siteRoot) {
  const dir = path.join(siteRoot, '_plugins');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.rb') && !f.endsWith('.rb.disabled'))
    .map(f => {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      return detectPluginMeta(content, f);
    });
}

function scanIncludes(siteRoot) {
  const dir = path.join(siteRoot, '_includes');
  const includes = {};
  if (!fs.existsSync(dir)) return includes;

  for (const f of walkDir(dir, ['.html', '.svg', '.liquid', '.md'])) {
    const name = path.relative(dir, f);
    includes[name] = { file: path.join('_includes', name), usedBy: [], lines: 0 };
    try {
      includes[name].lines = fs.readFileSync(f, 'utf8').split('\n').length;
    } catch (_) {}
  }

  // Scan layouts + index.html for {% include X %}
  const scanTargets = [
    path.join(siteRoot, '_layouts'),
    siteRoot,
  ];
  for (const scanDir of scanTargets) {
    if (!fs.existsSync(scanDir)) continue;
    const htmlFiles = scanDir === siteRoot
      ? fs.readdirSync(scanDir).filter(f => f.endsWith('.html')).map(f => path.join(scanDir, f))
      : walkDir(scanDir, ['.html']);
    for (const f of htmlFiles) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        const rel = path.relative(siteRoot, f);
        for (const m of content.matchAll(/\{%-?\s*include\s+([\w./\-]+)/g)) {
          const inc = m[1].trim();
          if (includes[inc]) includes[inc].usedBy.push(rel);
        }
      } catch (_) {}
    }
  }
  return includes;
}

function scanDataFiles(siteRoot) {
  const dir = path.join(siteRoot, '_data');
  if (!fs.existsSync(dir)) return [];
  return walkDir(dir, ['.yml', '.yaml', '.json']).map(f => {
    const rel = path.relative(siteRoot, f);
    const stat = fs.statSync(f);
    let keys = [];
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const parsed = f.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
      if (parsed && typeof parsed === 'object') {
        keys = Array.isArray(parsed)
          ? [`array[${parsed.length}]`]
          : Object.keys(parsed).slice(0, 12);
      }
    } catch (_) {}
    return { path: rel, size: stat.size, modified: stat.mtime.toISOString(), keys };
  });
}

function buildManifest(siteRoot) {
  const layouts = scanLayouts(siteRoot);
  const posts = scanPosts(siteRoot, layouts);
  const plugins = scanPlugins(siteRoot);
  const includes = scanIncludes(siteRoot);
  const dataFiles = scanDataFiles(siteRoot);

  // Sort each layout's posts newest first
  const layoutSummary = {};
  for (const [name, data] of Object.entries(layouts)) {
    layoutSummary[name] = {
      file: data.file,
      count: data.posts.length,
      missing: data.missing,
      posts: data.posts.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    };
  }

  // Includes: flag orphans (usedBy.length === 0)
  for (const inc of Object.values(includes)) {
    inc.orphan = inc.usedBy.length === 0;
  }

  return {
    siteRoot,
    scannedAt: new Date().toISOString(),
    totals: {
      posts: posts.length,
      layouts: Object.keys(layoutSummary).length,
      plugins: plugins.length,
      includes: Object.keys(includes).length,
      dataFiles: dataFiles.length,
    },
    layouts: layoutSummary,
    plugins,
    includes,
    dataFiles,
  };
}

module.exports = { buildManifest };
