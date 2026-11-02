'use strict';
/*
 * ACPU Studio — Electron main process.
 *
 * The main process owns the virtual ACPU-1 device, the formula registry and the
 * local HTTP device service. The renderer is a pure view: it talks to this
 * process only through the contextBridge API in preload.js, with no node
 * integration and no remote module.
 */

const { app, BrowserWindow, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const { VirtualACPUD1, SPEC } = require('./core/device');
const formulas = require('./core/formulas');

const APP_NAME = 'ACPU Studio';
const VERSION = '1.0.0';

// Sandboxed CI / automation environments (and some hardened hosts) cannot
// create Chromium's helper sandbox or write to the platform profile directory.
// ACPU_HEADLESS=1 is set by tools/shots.mjs to opt into that mode; a normal
// desktop launch keeps the default sandbox.
const HEADLESS = process.env.ACPU_HEADLESS === '1';
if (HEADLESS) {
  app.commandLine.appendSwitch('no-sandbox');
  app.disableHardwareAcceleration();
}
if (!app.isPackaged) {
  try {
    app.setPath('userData', path.join(__dirname, '.profile'));
  } catch (err) { /* keep the platform default */ }
}
const DEFAULTS = {
  serviceEnabled: true,
  servicePort: 9771,
  telemetryHz: 10,
  animateRuns: true,
};

// ---------------------------------------------------------------------------
// Persistent state (settings + run history)
// ---------------------------------------------------------------------------

const DATA_DIR = app.isPackaged ? app.getPath('userData') : path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch (err) {
    return false;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return true;
  } catch (err) {
    console.error('[acpu] failed to persist', file, err.message);
    return false;
  }
}

let settings = { ...DEFAULTS, ...(readJson(SETTINGS_FILE, {}) || {}) };

// ---------------------------------------------------------------------------
// Device + run store
// ---------------------------------------------------------------------------

const device = new VirtualACPUD1({ seed: 0x7e3a1d });
const runs = new Map();
let runOrder = [];
let runSeq = 0;
let activeRun = null;

function stripHeavy(record) {
  const { metrics, ...rest } = record;
  if (!metrics) return rest;
  const { samples, clusterTimeline, ...light } = metrics;
  return { ...rest, metrics: light };
}

function persistRuns() {
  const keep = runOrder.slice(0, 30).map((id) => stripHeavy(runs.get(id)).__persisted || stripHeavy(runs.get(id)));
  writeJson(RUNS_FILE, keep);
}

function hydrateRuns() {
  const saved = readJson(RUNS_FILE, []);
  if (!Array.isArray(saved)) return;
  for (const rec of saved) {
    if (!rec || !rec.id) continue;
    runs.set(rec.id, rec);
    runOrder.push(rec.id);
  }
  runOrder.sort((a, b) => (runs.get(b).startedAt > runs.get(a).startedAt ? 1 : -1));
}

function runSummary(rec) {
  return {
    id: rec.id,
    formula: rec.formula,
    name: rec.name,
    call: rec.call,
    summary: rec.summary,
    params: rec.params,
    startedAt: rec.startedAt,
    computeMs: rec.computeMs,
    metrics: rec.metrics
      ? {
        timeS: rec.metrics.timeS,
        energyJ: rec.metrics.energyJ,
        powerW: rec.metrics.powerW,
        tflops: rec.metrics.tflops,
        util: rec.metrics.util,
        peakTj: rec.metrics.peakTj,
        cycles: rec.metrics.cycles,
      }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 740,
    backgroundColor: '#0B0F14',
    title: APP_NAME,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 20 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    send('device:ready', { platform: process.platform, version: VERSION });
  });
  win.on('closed', () => { win = null; });
  if (process.env.ACPU_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Live telemetry loop (10 Hz)
// ---------------------------------------------------------------------------

const telemetryHistory = [];
let lastSnapshotAt = 0;

function currentSnapshot() {
  if (activeRun && activeRun.sample) {
    const s = activeRun.sample;
    const base = device.snapshot();
    // Expand the sample's per-cluster utilisation into the 8 x 8 tile grid so
    // the device view tracks the run instead of the last committed state.
    const tileUtil = [];
    for (const c of s.clusterUtil) for (let t = 0; t < 8; t += 1) tileUtil.push(c);
    return {
      ...base,
      tileUtil,
      running: true,
      powerW: s.powerW,
      junctionC: s.junctionC,
      clockGHz: s.clockGHz,
      util: s.util,
      memUtil: s.memUtil,
      blockPower: s.blockPower,
      clusterUtil: s.clusterUtil,
      runId: activeRun.id,
      phase: s.phase,
    };
  }
  return device.snapshot();
}

function startTelemetry() {
  const intervalMs = Math.max(100, Math.round(1000 / Math.max(1, Math.min(20, settings.telemetryHz))));
  setInterval(() => {
    const snap = currentSnapshot();
    if (!activeRun) device.tick(intervalMs / 1000);
    telemetryHistory.push(snap);
    if (telemetryHistory.length > 900) telemetryHistory.shift();
    lastSnapshotAt = Date.now();
    send('device:telemetry', snap);
  }, intervalMs);
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a formula. The numerics and the device model finish first (they are
 * deterministic and fast); the device timeline is then replayed to the UI at
 * 20 Hz so the panel shows the run as it would appear live. Service/SDK runs
 * pass animate:false and get the result immediately.
 */
async function executeFormula(formulaId, rawParams, opts = {}) {
  const f = formulas.get(formulaId);
  if (!f) {
    throw new formulas.FormulaError(
      `unknown formula "${formulaId}" — available: ${formulas.REGISTRY.map((x) => x.callName).join(', ')}`,
      'unknown_formula',
    );
  }
  if (activeRun) {
    throw new formulas.FormulaError('the device is busy with another run — wait for it to finish', 'device_busy');
  }
  const params = formulas.validateParams(f, rawParams);
  runSeq += 1;
  const id = `run-${String(runSeq).padStart(4, '0')}`;
  const startedAt = new Date().toISOString();
  activeRun = { id, formula: f.id, startedAt, cancel: false };

  let result;
  try {
    result = formulas.runFormula(formulaId, params, { device, seed: 20261102 });
  } catch (err) {
    activeRun = null;
    throw err;
  }

  const record = {
    id,
    formula: f.id,
    callName: f.callName,
    name: f.name,
    category: f.category,
    call: result.call,
    summary: result.summary,
    params,
    data: result.data || null,
    metrics: result.metrics,
    charts: result.charts,
    tables: result.tables,
    notes: result.notes,
    startedAt,
    computeMs: result.computeMs,
    durationMs: 0,
  };

  const t0 = Date.now();
  if (opts.animate !== false && settings.animateRuns) {
    const samples = (result.metrics.samples || []);
    const wallMs = Math.max(700, Math.min(2600, 900 + 380 * Math.log10(1 + result.metrics.timeS)));
    let idx = -1;
    send('run:started', { runId: id, formula: f.id, name: f.name, call: result.call, wallMs });
    while (Date.now() - t0 < wallMs) {
      const p = Math.min(1, (Date.now() - t0) / wallMs);
      const next = Math.min(samples.length - 1, Math.floor(p * samples.length));
      if (next !== idx && samples[next]) {
        idx = next;
        activeRun.sample = samples[next];
      }
      const phase = samples[idx] ? samples[idx].phase : 'execute';
      send('run:progress', {
        runId: id,
        pct: p,
        phase,
        tick: idx,
        of: samples.length,
        powerW: result.metrics.powerW,
        junctionC: samples[idx] ? samples[idx].junctionC : result.metrics.peakTj,
      });
      await sleep(50);
    }
    send('run:progress', { runId: id, pct: 1, phase: 'reduce', tick: samples.length, of: samples.length });
  }

  record.durationMs = Date.now() - t0;
  runs.set(id, record);
  runOrder.unshift(id);
  if (runOrder.length > 60) {
    const dropped = runOrder.splice(40);
    for (const d of dropped) runs.delete(d);
  }
  activeRun = null;
  persistRuns();
  send('run:done', runSummary(record));
  return record;
}

// ---------------------------------------------------------------------------
// Local HTTP device service — this is how the Python / Node SDKs "call the chip"
// ---------------------------------------------------------------------------

let server = null;
let serverPort = null;
const serverStartedAt = Date.now();

function json(res, code, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('request body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('request body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serviceInfo() {
  return {
    enabled: !!settings.serviceEnabled,
    running: !!server,
    port: serverPort || settings.servicePort,
    url: `http://127.0.0.1:${serverPort || settings.servicePort}`,
    startedAt: server ? new Date(serverStartedAt).toISOString() : null,
  };
}

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname.replace(/\/$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  try {
    if (pathname === '/health' && req.method === 'GET') {
      return json(res, 200, {
        status: 'ok',
        service: 'acpu-studio-device',
        version: VERSION,
        device: `${SPEC.chip.name} ${SPEC.chip.codename}`,
        uptimeS: Math.round((Date.now() - serverStartedAt) / 1000),
        port: serverPort,
        runs: device.counters.runs,
      });
    }
    if (pathname === '/v1/device' && req.method === 'GET') {
      return json(res, 200, { ...device.info(), service: serviceInfo(), formulas: formulas.REGISTRY.length });
    }
    if (pathname === '/v1/telemetry' && req.method === 'GET') {
      return json(res, 200, currentSnapshot());
    }
    if (pathname === '/v1/formulas' && req.method === 'GET') {
      return json(res, 200, { formulas: formulas.list() });
    }
    if (pathname === '/v1/runs' && req.method === 'GET') {
      return json(res, 200, { runs: runOrder.map((id) => runSummary(runs.get(id))) });
    }
    if (pathname.startsWith('/v1/runs/') && req.method === 'GET') {
      const id = pathname.slice('/v1/runs/'.length);
      const rec = runs.get(id);
      if (!rec) return json(res, 404, { error: `no run with id "${id}"` });
      return json(res, 200, stripHeavy(rec));
    }
    if (pathname === '/v1/run' && req.method === 'POST') {
      return readBody(req)
        .then(async (body) => {
          let id = body.formula || body.name;
          let params = body.params || {};
          if (!id && body.call) {
            const parsed = formulas.parseCall(body.call);
            id = parsed.formula.id;
            params = parsed.params;
          }
          if (!id) return json(res, 400, { error: 'body must include {formula, params} or {call}' });
          const rec = await executeFormula(id, params, { animate: false });
          return json(res, 200, { runId: rec.id, result: { ...rec, metrics: (() => { const { samples, clusterTimeline, ...m } = rec.metrics; return m; })() } });
        })
        .catch((err) => json(res, err.code === 'unknown_formula' || err.code === 'bad_type' ? 400 : 500, { error: err.message, code: err.code || 'run_failed' }));
    }
    return json(res, 404, { error: `no route for ${req.method} ${pathname}`, endpoints: ['GET /health', 'GET /v1/device', 'GET /v1/formulas', 'GET /v1/telemetry', 'POST /v1/run', 'GET /v1/runs', 'GET /v1/runs/:id'] });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

function startService() {
  if (server) return Promise.resolve(serviceInfo());
  return new Promise((resolve) => {
    const base = Number(settings.servicePort) || 9771;
    let attempt = 0;
    const tryListen = () => {
      const s = http.createServer(handleRequest);
      s.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < 9) {
          attempt += 1;
          tryListen();
        } else {
          console.error('[acpu] device service failed:', err.message);
          resolve({ ...serviceInfo(), running: false, error: err.message });
        }
      });
      s.listen(base + attempt, '127.0.0.1', () => {
        server = s;
        serverPort = base + attempt;
        console.log(`[acpu] device service on http://127.0.0.1:${serverPort}`);
        resolve(serviceInfo());
      });
    };
    tryListen();
  });
}

function stopService() {
  return new Promise((resolve) => {
    if (!server) return resolve(serviceInfo());
    server.close(() => {
      server = null;
      serverPort = null;
      resolve(serviceInfo());
    });
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('device:info', () => ({ ...device.info(), service: serviceInfo(), app: { version: VERSION, platform: process.platform, host: os.hostname() } }));
ipcMain.handle('device:telemetry', () => currentSnapshot());
ipcMain.handle('device:history', () => telemetryHistory.slice(-600));

ipcMain.handle('formula:list', () => formulas.list());
ipcMain.handle('formula:parse', (evt, text) => {
  try {
    const parsed = formulas.parseCall(text);
    return { ok: true, formula: parsed.formula.id, params: parsed.params, call: parsed.call };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || 'syntax' };
  }
});
ipcMain.handle('formula:run', async (evt, payload) => {
  const { formula, params, animate } = payload || {};
  try {
    const rec = await executeFormula(formula, params || {}, { animate: animate !== false });
    return { ok: true, record: rec };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || 'run_failed' };
  }
});

ipcMain.handle('runs:list', () => runOrder.map((id) => runSummary(runs.get(id))));
ipcMain.handle('run:get', (evt, id) => {
  const rec = runs.get(id);
  return rec ? stripHeavy(rec) : null;
});
ipcMain.handle('run:delete', (evt, id) => {
  const ok = runs.delete(id);
  runOrder = runOrder.filter((x) => x !== id);
  persistRuns();
  return { ok, runs: runOrder.map((x) => runSummary(runs.get(x))) };
});
ipcMain.handle('runs:clear', () => {
  runs.clear();
  runOrder = [];
  persistRuns();
  return { ok: true, runs: [] };
});

ipcMain.handle('app:settings', () => ({ ...settings, service: serviceInfo(), dataDir: DATA_DIR }));
ipcMain.handle('app:settings:set', async (evt, patch) => {
  const next = { ...settings, ...(patch || {}) };
  next.servicePort = Math.max(1024, Math.min(65535, Number(next.servicePort) || 9771));
  next.telemetryHz = Math.max(4, Math.min(20, Number(next.telemetryHz) || 10));
  const serviceWas = settings.serviceEnabled;
  settings = next;
  writeJson(SETTINGS_FILE, settings);
  if (serviceWas !== settings.serviceEnabled) {
    if (settings.serviceEnabled) await startService();
    else await stopService();
  }
  return { ...settings, service: serviceInfo() };
});
ipcMain.handle('app:copy', (evt, text) => { clipboard.writeText(String(text == null ? '' : text)); return true; });
ipcMain.handle('app:open-external', (evt, url) => { if (/^https?:/.test(String(url))) shell.openExternal(String(url)); return true; });
ipcMain.handle('app:service', () => serviceInfo());

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.setName(APP_NAME);
if (process.env.ACPU_ANIM === '0') { settings.animateRuns = false; }

app.whenReady().then(async () => {
  nativeThemeApply();
  hydrateRuns();
  createWindow();
  startTelemetry();
  if (settings.serviceEnabled) await startService();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function nativeThemeApply() {
  // Dark chrome on every platform so the window frame matches the panel.
  try { require('electron').nativeTheme.themeSource = 'dark'; } catch (err) { /* optional */ }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { if (server) { try { server.close(); } catch (err) { /* ignore */ } } });
