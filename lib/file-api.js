const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const yaml = require('js-yaml');

const SAFE_EXTS = new Set(['.md', '.html', '.yml', '.yaml', '.json', '.txt', '.markdown', '.liquid', '.rb', '.js', '.css']);

function isPathSafe(siteRoot, filePath) {
  const abs = path.resolve(siteRoot, filePath);
  return abs.startsWith(path.resolve(siteRoot)) && !abs.includes('node_modules') && !abs.includes('_site');
}

function readFile(siteRoot, filePath) {
  if (!isPathSafe(siteRoot, filePath)) throw new Error('Path not allowed');
  const abs = path.join(siteRoot, filePath);
  if (!fs.existsSync(abs)) throw new Error('File not found');

  const raw = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(filePath).toLowerCase();

  // Front matter files (posts, pages, layouts)
  if (['.md', '.markdown', '.html'].includes(ext)) {
    try {
      const parsed = matter(raw);
      return { type: 'frontmatter', frontMatter: parsed.data, body: parsed.content, raw };
    } catch (_) {}
  }

  // YAML data files
  if (['.yml', '.yaml'].includes(ext)) {
    try {
      const parsed = yaml.load(raw);
      return { type: 'yaml', data: parsed, raw };
    } catch (_) {}
  }

  // JSON data files
  if (ext === '.json') {
    try {
      return { type: 'json', data: JSON.parse(raw), raw };
    } catch (_) {}
  }

  return { type: 'raw', raw };
}

function writeFile(siteRoot, filePath, payload) {
  if (!isPathSafe(siteRoot, filePath)) throw new Error('Path not allowed');
  const abs = path.join(siteRoot, filePath);
  const ext = path.extname(filePath).toLowerCase();

  let content;

  if (payload.type === 'frontmatter') {
    content = matter.stringify(payload.body || '', payload.frontMatter || {});
  } else if (payload.type === 'yaml') {
    content = yaml.dump(payload.data, { indent: 2, lineWidth: 120 });
  } else if (payload.type === 'json') {
    content = JSON.stringify(payload.data, null, 2) + '\n';
  } else {
    content = payload.raw;
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { written: abs, size: content.length };
}

function listDir(siteRoot, dirPath) {
  if (!isPathSafe(siteRoot, dirPath)) throw new Error('Path not allowed');
  const abs = path.join(siteRoot, dirPath);
  if (!fs.existsSync(abs)) throw new Error('Directory not found');

  return fs.readdirSync(abs, { withFileTypes: true }).map(entry => {
    const full = path.join(abs, entry.name);
    const stat = fs.statSync(full);
    return {
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      ext: entry.isFile() ? path.extname(entry.name) : null,
      size: entry.isFile() ? stat.size : null,
      modified: stat.mtime.toISOString(),
    };
  }).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

module.exports = { readFile, writeFile, listDir, isPathSafe };
