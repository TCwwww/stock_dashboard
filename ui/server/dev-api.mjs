#!/usr/bin/env node
import http from 'node:http';
import url from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const uiRoot = path.resolve(__dirname, '..');

const state = {
  running: false,
  pid: null,
  startedAt: null,
  exitCode: null,
  logs: [], // ring buffer of lines
  maxLogs: 400,
};

function pushLog(line) {
  if (!line) return;
  state.logs.push(line);
  if (state.logs.length > state.maxLogs) {
    state.logs.splice(0, state.logs.length - state.maxLogs);
  }
}

function choosePython() {
  if (process.env.GEN_PYTHON) return process.env.GEN_PYTHON;
  const isWin = process.platform === 'win32';
  const venv = path.join(repoRoot, 'macd-grades', '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  if (fs.existsSync(venv)) return venv;
  return isWin ? 'python' : 'python3';
}

function runGenerator(respond) {
  if (state.running) return respond(409, { ok: false, error: 'already_running' });
  state.running = true;
  state.exitCode = null;
  state.startedAt = new Date().toISOString();
  state.pid = null;
  state.logs = [];

  const py = choosePython();
  const args = [path.join('macd-grades', 'generate_data.py')];
  pushLog(`$ ${py} ${args.join(' ')}`);
  const proc = spawn(py, args, { cwd: repoRoot, shell: false });
  state.pid = proc.pid;

  proc.stdout.on('data', (buf) => {
    const text = buf.toString();
    text.split(/\r?\n/).forEach((line) => pushLog(line));
  });
  proc.stderr.on('data', (buf) => {
    const text = buf.toString();
    text.split(/\r?\n/).forEach((line) => pushLog(line));
  });
  proc.on('error', (err) => {
    pushLog(`[error] spawn failed: ${err.message}`);
  });
  proc.on('close', (code) => {
    state.exitCode = code;
    pushLog(`[done] generator exited with code ${code}`);
    // After generator completes, sync data to UI public
    try {
      const node = process.execPath;
      const copy = spawn(node, [path.join('ui', 'scripts', 'copy-data.mjs')], { cwd: repoRoot, shell: false });
      copy.stdout.on('data', (b) => pushLog(b.toString()));
      copy.stderr.on('data', (b) => pushLog(b.toString()));
      copy.on('close', (cc) => {
        pushLog(`[done] copy-data exited with code ${cc}`);
        state.running = false;
      });
    } catch (e) {
      pushLog(`[warn] copy-data failed: ${e?.message || e}`);
      state.running = false;
    }
  });
  return respond(202, { ok: true, pid: state.pid, startedAt: state.startedAt });
}

function getStatus(respond) {
  return respond(200, {
    running: state.running,
    pid: state.pid,
    startedAt: state.startedAt,
    exitCode: state.exitCode,
    logs: state.logs.slice(-200),
  });
}

const server = http.createServer((req, res) => {
  const u = new url.URL(req.url, 'http://localhost');
  const respond = (status, obj) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && u.pathname === '/api/status') {
    return getStatus(respond);
  }
  if (req.method === 'POST' && u.pathname === '/api/generate') {
    return runGenerator(respond);
  }
  res.statusCode = 404;
  res.end('not found');
});

const PORT = process.env.DEV_API_PORT ? Number(process.env.DEV_API_PORT) : 8787;
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[dev-api] listening on http://localhost:${PORT}`);
});
