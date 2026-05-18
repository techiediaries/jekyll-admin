const { spawn } = require('child_process');

const ALLOWED_COMMANDS = new Set([
  'jekyll', 'bundle', 'npm', 'node', 'npx',
]);

function isSafe(cmd) {
  const base = cmd.trim().split(/\s+/)[0].split('/').pop();
  return ALLOWED_COMMANDS.has(base);
}

/**
 * Run a shell command and stream stdout/stderr as SSE events.
 * Client receives: data: { type, line } where type is 'stdout'|'stderr'|'exit'|'error'
 */
function streamCommand(cmd, args, cwd, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, line) => {
    res.write(`data: ${JSON.stringify({ type, line })}\n\n`);
  };

  if (!isSafe(cmd)) {
    send('error', `Command not allowed: ${cmd}`);
    res.write('data: {"type":"exit","code":1}\n\n');
    res.end();
    return;
  }

  const child = spawn(cmd, args, { cwd, shell: false });

  child.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => send('stdout', l)));
  child.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => send('stderr', l)));
  child.on('close', code => {
    res.write(`data: ${JSON.stringify({ type: 'exit', code })}\n\n`);
    res.end();
  });
  child.on('error', err => {
    send('error', err.message);
    res.write('data: {"type":"exit","code":1}\n\n');
    res.end();
  });

  req => req.on('close', () => child.kill());
}

/**
 * Run a command and return { stdout, stderr, code } as a promise.
 */
function runCommand(cmd, args, cwd) {
  return new Promise((resolve) => {
    if (!isSafe(cmd)) return resolve({ stdout: '', stderr: `Not allowed: ${cmd}`, code: 1 });
    const child = spawn(cmd, args, { cwd, shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ stdout, stderr, code }));
    child.on('error', err => resolve({ stdout: '', stderr: err.message, code: 1 }));
  });
}

module.exports = { streamCommand, runCommand };
