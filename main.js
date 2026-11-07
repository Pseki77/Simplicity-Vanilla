const { app, BrowserWindow, WebContentsView, session, screen, globalShortcut, ipcMain, clipboard, ClipboardItem, Notification, nativeImage, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const TITLE = 'Simplicity Vanilla';

const REPLAY = {
  startOn: true,
  maxWidth: 1920,
  maxHeight: 1080,
  videoBitrate: 8000000,
  audio: true,
};

const WATERMARK = {
  text: 'Simplicity Vanilla',
  width: 320,
  height: 56,
  bottom: 8,
};

let mainWindow = null;

const MOVE_EVENTS = ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen'];
const htmlURL = (html) => 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const SWAP_DIR = path.join(app.isPackaged ? path.dirname(process.execPath) : __dirname, 'swap');
const SWAP_FOLDERS = ['promo', 'weapons/ar2', 'weapons/awp', 'weapons/shotgun', 'weapons/vector'];
const SWAP_TYPES = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const ALWAYS_SWAP = ['promo/logo.webp'];

function scanSwap(dir = SWAP_DIR, base = '') {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return found;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...scanSwap(path.join(dir, entry.name), rel));
    else found.push(rel);
  }
  return found;
}

function sniffType(data, fallback) {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return fallback;
}

let swapFiles = [];

function installSwap(win) {
  const dbg = win.webContents.debugger;
  const patterns = ['*.webp*', '*.png*', '*.jpg*', '*.jpeg*'].map((urlPattern) => ({ urlPattern }));
  const sessions = new Set(['']);
  const send = (method, params, sessionId) => dbg.sendCommand(method, params, sessionId || undefined).catch(() => {});
  const setActive = (sessionId) => send(swapFiles.length ? 'Fetch.enable' : 'Fetch.disable', swapFiles.length ? { patterns } : {}, sessionId);

  async function serve({ requestId, request }, sessionId) {
    try {
      if (swapFiles.length && request.method === 'GET') {
        const requested = decodeURIComponent(new URL(request.url).pathname).toLowerCase();
        const match = SWAP_TYPES[path.extname(requested)] && swapFiles.find((rel) => requested.endsWith('/' + rel.toLowerCase()));
        const file = match && path.resolve(SWAP_DIR, match);
        if (file && file.startsWith(SWAP_DIR + path.sep)) {
          const data = await fs.promises.readFile(file);
          const origin = request.headers.Origin || request.headers.origin;
          await dbg.sendCommand('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: sniffType(data, SWAP_TYPES[path.extname(file).toLowerCase()]) },
              { name: 'Access-Control-Allow-Origin', value: origin || '*' },
              ...(origin ? [{ name: 'Access-Control-Allow-Credentials', value: 'true' }, { name: 'Vary', value: 'Origin' }] : []),
              { name: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
              { name: 'Cache-Control', value: 'no-cache' },
            ],
            body: data.toString('base64'),
          }, sessionId || undefined);
          return;
        }
      }
    } catch (err) {}
    send('Fetch.continueRequest', { requestId }, sessionId);
  }

  dbg.on('message', async (event, method, params, sessionId) => {
    if (method === 'Fetch.requestPaused') {
      serve(params, sessionId);
    } else if (method === 'Target.attachedToTarget') {
      const child = params.sessionId;
      sessions.add(child);
      try {
        await setActive(child);
        await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child);
      } finally {
        send('Runtime.runIfWaitingForDebugger', {}, child);
      }
    } else if (method === 'Target.detachedFromTarget') {
      sessions.delete(params.sessionId);
    }
  });

  try {
    dbg.attach('1.3');
  } catch (err) {
    console.error('[swap] could not start:', err.message);
    return () => {};
  }
  send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  return () => sessions.forEach((sessionId) => setActive(sessionId));
}

const SWITCHES = [
  ['disable-frame-rate-limit', 'Uncap FPS', 'Disables the capped FPS limit'],
  ['disable-gpu-vsync', 'Disable VSync', 'Stops syncing frames to your monitor refresh rate, lowering input lag but may cause tearing'],
  ['ignore-gpu-blocklist', 'Ignore GPU blocklist', 'Forces GPU acceleration even on GPUs flagged as unsupported'],
  ['enable-gpu-rasterization', 'GPU rasterization', 'Draws page graphics on the GPU instead of the CPU'],
  ['enable-zero-copy', 'Zero-copy', 'Skips extra memory copies when sending frames to the GPU'],
  ['force_high_performance_gpu', 'Force high-performance GPU', 'Uses your dedicated GPU instead of integrated graphics'],
];
const KEY_LABELS = {
  panel: 'Settings panel',
  screenshot: 'Screenshot',
  boss: 'Boss key',
  replaySave: 'Save replay clip',
  replayToggle: 'Replay on / off',
};
const FPS_OPTIONS = [15, 24, 30, 45, 60, 144, 240, 360, 500];
const SECONDS_RANGE = [5, 120];
const KEY_PATTERN = /^([a-z0-9]|F([1-9]|1[0-2]))$/;
const SIZE_PRESETS = [[1280, 720], [1280, 960], [1280, 1024], [1440, 1080], [1920, 1080]];
const SIZE_RANGE = { width: [640, 7680], height: [360, 4320] };

const DEFAULTS = {
  keys: { panel: 'F1', screenshot: 'F2', boss: 'F3', replaySave: 'F4', replayToggle: 'F5' },
  switches: Object.fromEntries(SWITCHES.map(([name]) => [name, name !== 'disable-frame-rate-limit'])),
  glow: '#ff0000',
  customTextures: true,
  replayFps: 30,
  replaySeconds: 15,
  windowSize: { width: 1280, height: 720 },
  stretch: { enabled: false, width: 1280, height: 960 },
};

const isSeconds = (n) => Number.isInteger(n) && n >= SECONDS_RANGE[0] && n <= SECONDS_RANGE[1];
const inRange = (n, [min, max]) => Number.isInteger(n) && n >= min && n <= max;
const isSize = (width, height) => inRange(width, SIZE_RANGE.width) && inRange(height, SIZE_RANGE.height);

function loadSettings() {
  const loaded = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const keys = { ...loaded.keys };
    for (const action of Object.keys(keys)) {
      if (saved.keys && KEY_PATTERN.test(saved.keys[action])) keys[action] = saved.keys[action];
    }
    if (new Set(Object.values(keys).map((k) => k.toLowerCase())).size === Object.keys(keys).length) loaded.keys = keys;
    for (const [name] of SWITCHES) {
      if (saved.switches && typeof saved.switches[name] === 'boolean') loaded.switches[name] = saved.switches[name];
    }
    if (/^#[0-9a-f]{6}$/i.test(saved.glow)) loaded.glow = saved.glow;
    if (typeof saved.customTextures === 'boolean') loaded.customTextures = saved.customTextures;
    if (FPS_OPTIONS.includes(saved.replayFps)) loaded.replayFps = saved.replayFps;
    if (isSeconds(saved.replaySeconds)) loaded.replaySeconds = saved.replaySeconds;
    if (saved.windowSize && isSize(saved.windowSize.width, saved.windowSize.height)) {
      loaded.windowSize = { width: saved.windowSize.width, height: saved.windowSize.height };
    }
    if (saved.stretch && isSize(saved.stretch.width, saved.stretch.height)) {
      loaded.stretch = { enabled: saved.stretch.enabled === true, width: saved.stretch.width, height: saved.stretch.height };
    }
  } catch (err) {}
  return loaded;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Could not save the settings:', err.message);
  }
}

let settings = loadSettings();
const startupSwitches = { ...settings.switches };
const startupCustomTextures = settings.customTextures;
const restartNeeded = () => SWITCHES.some(([name]) => settings.switches[name] !== startupSwitches[name]) || settings.customTextures !== startupCustomTextures;

const currentSize = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentSize() : null);

const settingsState = () => ({
  settings,
  restartNeeded: restartNeeded(),
  current: currentSize(),
  options: {
    keys: KEY_LABELS,
    fps: FPS_OPTIONS,
    switches: SWITCHES,
    seconds: SECONDS_RANGE,
    bitrate: REPLAY.videoBitrate,
    resolution: { presets: SIZE_PRESETS, ...SIZE_RANGE },
  },
});

function changeSetting(change) {
  const next = structuredClone(settings);
  let error = null;

  if (change.reset) {
    Object.assign(next, structuredClone(DEFAULTS));
  } else if (change.key) {
    const [action, key] = change.key;
    if (!(action in next.keys)) {
      error = 'Unknown hotkey';
    } else if (!KEY_PATTERN.test(key)) {
      error = 'Use a letter, a number or F1 to F12';
    } else {
      const clash = Object.keys(next.keys).find((a) => a !== action && next.keys[a].toLowerCase() === key.toLowerCase());
      if (clash) error = `${key.toUpperCase()} is already used for "${KEY_LABELS[clash]}"`;
      else next.keys[action] = key;
    }
  } else if (change.switch) {
    const [name, enabled] = change.switch;
    if (name in next.switches && typeof enabled === 'boolean') next.switches[name] = enabled;
    else error = 'Unknown setting';
  } else if (change.customTextures !== undefined) {
    if (typeof change.customTextures === 'boolean') next.customTextures = change.customTextures;
    else error = 'Unknown setting';
  } else if (change.glow !== undefined) {
    if (/^#[0-9a-f]{6}$/i.test(change.glow)) next.glow = change.glow;
    else error = 'Not a valid colour';
  } else if (change.fps !== undefined) {
    if (FPS_OPTIONS.includes(change.fps)) next.replayFps = change.fps;
    else error = 'Unsupported FPS';
  } else if (change.seconds !== undefined) {
    if (isSeconds(change.seconds)) next.replaySeconds = change.seconds;
    else error = `Enter a whole number from ${SECONDS_RANGE[0]} to ${SECONDS_RANGE[1]}`;
  } else if (change.size !== undefined) {
    const [width, height] = Array.isArray(change.size) ? change.size : [];
    if (isSize(width, height)) next.windowSize = { width, height };
    else error = `Use a width of ${SIZE_RANGE.width.join(' to ')} and a height of ${SIZE_RANGE.height.join(' to ')}`;
  } else if (change.stretch !== undefined) {
    const { on, size } = change.stretch || {};
    const [width, height] = size === undefined ? [next.stretch.width, next.stretch.height] : Array.isArray(size) ? size : [];
    if ((on !== undefined && typeof on !== 'boolean') || !isSize(width, height)) {
      error = `Use a width of ${SIZE_RANGE.width.join(' to ')} and a height of ${SIZE_RANGE.height.join(' to ')}`;
    } else {
      next.stretch = { enabled: on === undefined ? next.stretch.enabled : on, width, height };
    }
  }

  if (error) return { error, changed: false };
  const previous = settings;
  settings = next;
  saveSettings();
  return { error: null, changed: true, previous };
}

SWITCHES.forEach(([name]) => {
  if (settings.switches[name]) app.commandLine.appendSwitch(name);
});

const startTime = Date.now();
const pad = (n) => String(n).padStart(2, '0');

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

let savedToast = null;

function notify(title, detail, kind, file) {
  if (savedToast?.ready()) {
    savedToast.show(title, detail, kind);
    return;
  }
  const notification = new Notification({ title, body: file || detail });
  if (file) notification.on('click', () => shell.showItemInFolder(file));
  notification.show();
}

async function addWatermark(image, scale) {
  const helper = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await helper.loadURL('about:blank');
    const dataURL = await helper.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const p = ${JSON.stringify({ ...WATERMARK, glow: settings.glow, scale })};
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);

          ctx.font = (13 * p.scale) + "px 'Segoe UI', Arial, sans-serif";
          if ('letterSpacing' in ctx) ctx.letterSpacing = (2 * p.scale) + 'px';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const x = c.width / 2;
          const y = c.height - p.bottom * p.scale;

          ctx.fillStyle = p.glow;
          ctx.shadowColor = p.glow;
          ctx.globalAlpha = 0.55;
          for (const blur of [10, 18]) {
            ctx.shadowBlur = blur * p.scale;
            ctx.fillText(p.text, x, y);
          }

          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 0.6;
          ctx.fillStyle = '#fff';
          ctx.fillText(p.text, x, y);

          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('image load failed'));
        img.src = ${JSON.stringify(image.toDataURL())};
      });
    `);
    return nativeImage.createFromDataURL(dataURL);
  } finally {
    helper.destroy();
  }
}

async function takeScreenshot(win) {
  if (!win.isVisible()) return;
  try {
    const raw = await win.webContents.capturePage();
    const scale = raw.getSize().width / win.getContentBounds().width;

    let image = raw;
    try {
      image = await addWatermark(raw, scale);
    } catch (err) {
      console.error('Watermark failed, saving without it:', err);
    }

    const dir = path.join(app.getPath('pictures'), 'Deadshot');
    fs.mkdirSync(dir, { recursive: true });

    const file = path.join(dir, `deadshot-${timestamp()}.png`);

    const png = image.toPNG();
    fs.writeFileSync(file, png);
    try {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    } catch (err) {
      console.error('Could not copy the screenshot to the clipboard:', err.message);
    }
    notify('Screenshot saved', path.basename(file), 'ok', file);
  } catch (err) {
    console.error('Screenshot failed:', err);
  }
}

function watermarkURL() {
  const { text, bottom } = WATERMARK;
  const glow = settings.glow;
  const html = `<html><head><style>
    :root { --glow: ${glow}; }
    html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
    body { display: flex; flex-direction: column; justify-content: flex-end; user-select: none; -webkit-user-select: none; }
    .wrap { height: ${bottom * 2}px; display: flex; align-items: center; justify-content: center; }
    .t { position: relative; white-space: nowrap; font: 13px 'Segoe UI', Arial, sans-serif; letter-spacing: 2px; }
    .core { position: relative; color: #fff; opacity: 0.6; }
    .glow {
      position: absolute; top: 0; left: 0; color: var(--glow);
      text-shadow: 0 0 4px var(--glow), 0 0 10px var(--glow), 0 0 18px var(--glow);
      will-change: opacity; animation: breathe 4s ease-in-out infinite;
    }
    @keyframes breathe { 0%, 100% { opacity: 0.15; } 50% { opacity: 0.9; } }
  </style></head><body><div class="wrap"><div class="t"><span class="glow">${text}</span><span class="core">${text}</span></div></div></body></html>`;
  return htmlURL(html);
}

function createWatermark(win) {
  const wm = new BrowserWindow({
    parent: win,
    width: WATERMARK.width,
    height: WATERMARK.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
  });
  wm.setIgnoreMouseEvents(true);

  wm.loadURL(watermarkURL());

  const place = () => {
    if (wm.isDestroyed() || win.isDestroyed()) return;
    const b = win.getContentBounds();
    const [w, h] = wm.getSize();
    wm.setPosition(Math.round(b.x + (b.width - w) / 2), Math.round(b.y + b.height - h));
  };
  [...MOVE_EVENTS, 'show'].forEach((event) => win.on(event, place));

  wm.once('ready-to-show', () => {
    place();
    if (win.isVisible()) wm.showInactive();
  });

  win.on('show', () => {
    if (!wm.isDestroyed()) wm.showInactive();
  });

  return wm;
}

function toastURL() {
  const html = `<html><head><style>
    html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; -webkit-user-select: none; }
    body { padding: 12px; box-sizing: border-box; font: 14px 'Segoe UI', Arial, sans-serif; color: #f2f4f8; }
    .card {
      position: relative; width: 340px; height: 76px; box-sizing: border-box; overflow: hidden;
      display: flex; align-items: center; gap: 12px; padding: 0 16px;
      border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.28);
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.4);
      opacity: 0; transform: translateX(-10px);
      transition: opacity 0.22s ease, transform 0.22s ease;
    }
    .card.in { opacity: 1; transform: none; }
    .bg { position: absolute; inset: 0; background-size: cover; background-position: center; filter: blur(14px) saturate(160%); transform: scale(1.2); }
    .tint { position: absolute; inset: 0; background: linear-gradient(140deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.06) 60%, rgba(255, 255, 255, 0.12)), rgba(8, 10, 16, 0.4); }
    .icon { position: relative; flex: none; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 1px solid; }
    .icon.ok { background: rgba(60, 220, 130, 0.22); border-color: rgba(60, 220, 130, 0.5); }
    .icon.ok svg { stroke: #9df0bd; }
    .icon.warn { background: rgba(255, 190, 70, 0.22); border-color: rgba(255, 190, 70, 0.5); }
    .icon.warn svg { stroke: #ffd58a; }
    .icon.off { background: rgba(255, 255, 255, 0.14); border-color: rgba(255, 255, 255, 0.35); }
    .icon.off svg { stroke: #e6e9ef; }
    .text { position: relative; min-width: 0; display: flex; flex-direction: column; }
    .title { font-weight: 600; font-size: 14px; }
    .detail { font-size: 12px; color: rgba(255, 255, 255, 0.65); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  </style></head><body>
    <div class="card" id="card">
      <div class="bg" id="bg"></div><div class="tint"></div>
      <div class="icon ok" id="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path id="path" d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <div class="text"><span class="title" id="title"></span><span class="detail" id="detail"></span></div>
    </div>
    <script>
      const card = document.getElementById('card');
      const paths = { ok: 'M5 12.5l4.5 4.5L19 7.5', warn: 'M12 6.5v7M12 17.5v.01', off: 'M8.5 6v12M15.5 6v12' };
      window.toast = {
        set(d) {
          card.classList.remove('in');
          document.getElementById('title').textContent = d.title;
          document.getElementById('detail').textContent = d.detail;
          const kind = paths[d.kind] ? d.kind : 'ok';
          document.getElementById('icon').className = 'icon ' + kind;
          document.getElementById('path').setAttribute('d', paths[kind]);
          document.getElementById('bg').style.backgroundImage = d.backdrop ? 'url(' + d.backdrop + ')' : 'none';
          void card.offsetWidth;
        },
        play() { requestAnimationFrame(() => card.classList.add('in')); },
        fade() { card.classList.remove('in'); },
      };
    </script>
  </body></html>`;
  return htmlURL(html);
}

function createToast(win) {
  const CARD = { width: 340, height: 76, margin: 16, pad: 12, showMs: 3000, fadeMs: 300 };
  const view = new BrowserWindow({
    parent: win,
    width: CARD.width + CARD.pad * 2,
    height: CARD.height + CARD.pad * 2,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  view.setIgnoreMouseEvents(true);
  const loaded = view.loadURL(toastURL());
  loaded.catch(() => {});

  let hideTimer;
  let fadeTimer;

  const place = () => {
    if (view.isDestroyed() || win.isDestroyed()) return;
    const b = win.getContentBounds();
    view.setPosition(Math.round(b.x + CARD.margin - CARD.pad), Math.round(b.y + CARD.margin - CARD.pad));
  };
  MOVE_EVENTS.forEach((event) => win.on(event, place));

  const ready = () => !view.isDestroyed() && !win.isDestroyed() && win.isVisible();

  const show = async (title, detail, kind = 'ok') => {
    if (!ready()) return;
    let backdrop = '';
    try {
      const image = await win.webContents.capturePage({ x: CARD.margin, y: CARD.margin, width: CARD.width, height: CARD.height });
      backdrop = image.toDataURL();
    } catch (err) {}
    try {
      await loaded;
      await view.webContents.executeJavaScript(`toast.set(${JSON.stringify({ title, detail, kind, backdrop })})`);
    } catch (err) {
      return;
    }
    if (!ready()) return;
    place();
    view.showInactive();
    view.webContents.executeJavaScript('toast.play()').catch(() => {});
    clearTimeout(hideTimer);
    clearTimeout(fadeTimer);
    hideTimer = setTimeout(() => {
      if (view.isDestroyed()) return;
      view.webContents.executeJavaScript('toast.fade()').catch(() => {});
      fadeTimer = setTimeout(() => { if (!view.isDestroyed()) view.hide(); }, CARD.fadeMs);
    }, CARD.showMs);
  };

  win.on('closed', () => {
    clearTimeout(hideTimer);
    clearTimeout(fadeTimer);
  });

  return { show, ready };
}

function createReplay(win) {
  const helper = new BrowserWindow({
    show: false,
    webPreferences: { partition: 'replay', backgroundThrottling: false },
  });
  let useAudio = REPLAY.audio && process.platform === 'win32';

  helper.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((s) => s.id === win.getMediaSourceId());
      if (!source) return callback({});
      callback(useAudio ? { video: source, audio: 'loopback' } : { video: source });
    } catch (err) {
      callback({});
    }
  });

  const run = (code) => helper.webContents.executeJavaScript(code, true);
  const loaded = helper.loadFile(path.join(__dirname, 'replay.html'));
  loaded.catch(() => {});

  let enabled = REPLAY.startOn;
  let recording = false;
  let starting = false;
  let saving = false;
  let lastError = '';
  let recordingFps = 0;

  const stop = async () => {
    recording = false;
    try { await run('replay.stop()'); } catch (err) {}
  };

  const start = async () => {
    if (!enabled || starting || win.isDestroyed() || !win.isVisible()) return;
    starting = true;
    try {
      await loaded;
      for (;;) {
        try {
          const info = await run(`replay.start(${JSON.stringify({ ...REPLAY, seconds: settings.replaySeconds, fps: settings.replayFps, audio: useAudio })})`);
          if (!enabled) { await stop(); return; }
          recording = true;
          recordingFps = Math.round(info.video.frameRate || settings.replayFps);
          lastError = '';
          console.log(`[replay] recording ${info.video.width}x${info.video.height} at ${info.video.frameRate} fps ${info.hasAudio ? 'with' : 'without'} audio`);
          return;
        } catch (err) {
          if (!useAudio) throw err;
          useAudio = false;
          console.error('[replay] could not capture audio, recording without it:', err.message);
        }
      }
    } catch (err) {
      recording = false;
      if (err.message !== lastError) console.error('[replay] could not start:', err.message);
      lastError = err.message;
    } finally {
      starting = false;
    }
  };

  const toggle = async () => {
    enabled = !enabled;
    if (enabled) await start(); else await stop();
    notify(
      enabled ? 'Instant replay on' : 'Instant replay off',
      enabled ? `Keeping the last ${settings.replaySeconds} seconds` : `Press ${settings.keys.replayToggle.toUpperCase()} to turn it back on`,
      enabled ? 'ok' : 'off',
    );
  };

  const save = async () => {
    if (!enabled) {
      notify('Instant replay is off', `Press ${settings.keys.replayToggle.toUpperCase()} to turn it on`, 'off');
      return;
    }
    if (saving) return;
    saving = true;
    try {
      const clip = await run('replay.save()');
      if (!clip) {
        notify('Nothing recorded yet', 'Try again in a few seconds', 'warn');
        return;
      }
      const dir = path.join(app.getPath('videos'), 'Deadshot');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `deadshot-replay-${timestamp()}.mp4`);
      fs.writeFileSync(file, Buffer.from(clip.bytes));
      notify(`Replay saved (${Math.round(clip.seconds)}s)`, path.basename(file), 'ok', file);
    } catch (err) {
      console.error('[replay] save failed:', err.message);
    } finally {
      saving = false;
    }
  };

  start();
  let resizeTimer;
  win.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(start, 1000);
  });

  const watchdog = setInterval(async () => {
    if (!enabled || starting || !win.isVisible()) return;
    try { recording = await run('replay.isActive()'); } catch (err) { recording = false; }
    if (!recording) start();
  }, 5000);

  win.on('closed', () => {
    clearInterval(watchdog);
    clearTimeout(resizeTimer);
    helper.destroy();
  });

  const restart = async () => {
    while (starting) await new Promise((resolve) => setTimeout(resolve, 200));
    await start();
  };

  const setSeconds = (seconds) => run(`replay.setSeconds(${seconds})`).catch(() => {});

  return { save, toggle, restart, setSeconds, isRecording: () => recording, fps: () => recordingFps };
}

function createSettings(win, onChange) {
  let view = null;
  let visible = false;

  ipcMain.handle('settings:get', () => settingsState());
  ipcMain.handle('settings:update', async (event, change) => {
    const result = changeSetting(change);
    if (result.changed) onChange(result.previous, change);
    if (change.size || change.reset) await new Promise((resolve) => setTimeout(resolve, 150));
    return { error: result.error, state: settingsState() };
  });
  ipcMain.handle('settings:restart', () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle('settings:close', () => hide());
  ipcMain.handle('settings:openSwap', () => shell.openPath(SWAP_DIR));

  win.on('closed', () => {
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
  });

  function fit() {
    if (!view || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  }
  ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach((event) => win.on(event, fit));

  function create() {
    view = new WebContentsView({
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    view.setBackgroundColor('#00000000');
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.loadFile(path.join(__dirname, 'settings.html')).catch((err) => {
      const message = `Could not open settings.html (it must be in the same folder as main.js): ${err.message}`;
      view.webContents.loadURL(htmlURL(`<body style="font:14px sans-serif;background:#14161a;color:#ff6b6b;padding:24px">${message}</body>`));
    });
  }

  function sendBackdrop() {
    win.webContents.capturePage().then((image) => {
      if (!visible || view.webContents.isDestroyed()) return;
      view.webContents.send('settings:backdrop', 'data:image/jpeg;base64,' + image.toJPEG(85).toString('base64'));
    }).catch(() => {});
  }

  let backdropTimer;
  win.on('resize', () => {
    if (!visible) return;
    clearTimeout(backdropTimer);
    backdropTimer = setTimeout(sendBackdrop, 250);
  });

  function show() {
    if (!view) create();
    win.contentView.addChildView(view);
    fit();
    visible = true;
    win.webContents.executeJavaScript('document.exitPointerLock()').catch(() => {});
    view.webContents.focus();
    view.webContents.send('settings:shown');
    sendBackdrop();
  }

  function hide() {
    if (!visible) return;
    visible = false;
    win.contentView.removeChildView(view);
    win.webContents.focus();
  }

  return () => (visible ? hide() : show());
}

function createWindow() {
  const win = new BrowserWindow({
    width: settings.windowSize.width,
    height: settings.windowSize.height,
    useContentSize: true,
    icon: path.join(__dirname, '/icon.jpg'),
    title: TITLE,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    webPreferences: {
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.on('page-title-updated', (e) => e.preventDefault());

  const applyWindowSize = () => {
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(settings.windowSize.width, settings.windowSize.height);
    win.center();
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const b = win.getBounds();
    const width = Math.min(b.width, area.width);
    const height = Math.min(b.height, area.height);
    win.setBounds({
      x: Math.min(Math.max(b.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(b.y, area.y), area.y + area.height - height),
      width,
      height,
    });
  };
  applyWindowSize();

  const stretchPayload = () => {
    const [realWidth, realHeight] = win.getContentSize();
    return { ...settings.stretch, realWidth, realHeight };
  };
  const pushStretch = () => {
    if (!win.isDestroyed()) win.webContents.send('stretch:update', stretchPayload());
  };
  ipcMain.on('stretch:get', (event) => {
    event.returnValue = stretchPayload();
  });
  win.on('resize', pushStretch);

  let sizeTimer;
  win.on('resize', () => {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isFullScreen() || win.isMaximized()) return;
      const [width, height] = win.getContentSize();
      const saved = settings.windowSize;
      if (isSize(width, height) && (width !== saved.width || height !== saved.height)) {
        settings = { ...settings, windowSize: { width, height } };
        saveSettings();
      }
    }, 600);
  });
  win.on('closed', () => clearTimeout(sizeTimer));

  mainWindow = win;
  let watermark = null;
  let replay = null;
  win.webContents.once('did-finish-load', () => {
    watermark = createWatermark(win);
    savedToast = createToast(win);
    replay = createReplay(win);
  });

  const toggleSettings = createSettings(win, (previous, change) => {
    if (settings.glow !== previous.glow) {
      watermark?.webContents
        .executeJavaScript(`document.documentElement.style.setProperty('--glow', ${JSON.stringify(settings.glow)})`)
        .catch(() => {});
    }
    if (settings.customTextures !== previous.customTextures) applyRequestRules();
    if (settings.replayFps !== previous.replayFps) replay?.restart();
    if (settings.replaySeconds !== previous.replaySeconds) replay?.setSeconds(settings.replaySeconds);
    const sizeChanged = settings.windowSize.width !== previous.windowSize.width || settings.windowSize.height !== previous.windowSize.height;
    if (change.size || (change.reset && sizeChanged)) applyWindowSize();
    if (change.stretch || change.reset) pushStretch();
  });

  const updateTitle = () => {
    if (win.isDestroyed()) return;
    const rec = replay?.isRecording() ? ` | ● REC ${replay.fps()}fps` : '';
    win.setTitle(`${TITLE}${rec} | ${formatUptime(Date.now() - startTime)}`);
  };
  updateTitle();
  const titleTimer = setInterval(updateTitle, 1000);
  win.on('closed', () => clearInterval(titleTimer));

  const setGameVisible = (visible) => {
    if (visible) {
      win.show();
      watermark?.showInactive();
    } else {
      win.hide();
      watermark?.hide();
    }
    win.webContents.setAudioMuted(!visible);
  };
  const showGame = (accelerator) => {
    globalShortcut.unregister(accelerator);
    setGameVisible(true);
  };
  const hideGame = () => {
    const accelerator = settings.keys.boss.toUpperCase();
    if (!globalShortcut.register(accelerator, () => showGame(accelerator))) {
      console.error(`[boss key] "${accelerator}" is already taken by another app, so the game was not hidden`);
      return;
    }
    setGameVisible(false);
  };

  const is = (input, key) => input.key.toLowerCase() === key.toLowerCase();
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || input.control || input.alt || input.meta) return;
    const { keys } = settings;
    if (is(input, keys.panel)) toggleSettings();
    else if (is(input, keys.screenshot)) takeScreenshot(win);
    else if (is(input, keys.boss)) hideGame();
    else if (is(input, keys.replaySave)) replay?.save();
    else if (is(input, keys.replayToggle)) replay?.toggle();
  });

  const refreshSwap = installSwap(win);
  const applyRequestRules = () => {
    const files = scanSwap();
    swapFiles = settings.customTextures ? files : files.filter((rel) => ALWAYS_SWAP.includes(rel.toLowerCase()));
    refreshSwap();
  };
  applyRequestRules();

  win.loadURL('https://deadshot.io');
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    SWAP_FOLDERS.forEach((folder) => fs.mkdirSync(path.join(SWAP_DIR, folder), { recursive: true }));
    session.defaultSession.preconnect({ url: 'https://deadshot.io', numSockets: 4 });
    createWindow();
  });
} else {
  app.quit();
}
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
