const { app, BrowserWindow, globalShortcut, ipcMain, clipboard, ClipboardItem, Notification, nativeImage, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');


const TITLE = 'Simplicity Vanilla';
const SETTINGS_KEY = 'F1';


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



const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const SWITCHES = [
  ['disable-gpu-vsync', 'Disable VSync'],
  ['ignore-gpu-blocklist', 'Ignore GPU blocklist'],
  ['enable-gpu-rasterization', 'GPU rasterization'],
  ['enable-zero-copy', 'Zero-copy'],
  ['force_high_performance_gpu', 'Force high-performance GPU'],
];
const KEY_LABELS = {
  screenshot: 'Screenshot',
  boss: 'Boss key',
  replaySave: 'Save replay clip',
  replayToggle: 'Replay on / off',
};
const FPS_OPTIONS = [15, 24, 30, 45, 60];
const SECONDS_RANGE = [5, 120]; 
const KEY_PATTERN = /^([a-z0-9]|F([2-9]|1[0-2]))$/; 

const DEFAULTS = {
  keys: { screenshot: '3', boss: '4', replaySave: '5', replayToggle: '6' },
  switches: Object.fromEntries(SWITCHES.map(([name]) => [name, true])),
  glow: '#ff0000',
  replayFps: 30,
  replaySeconds: 15,
};

const isSeconds = (n) => Number.isInteger(n) && n >= SECONDS_RANGE[0] && n <= SECONDS_RANGE[1];

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
    if (FPS_OPTIONS.includes(saved.replayFps)) loaded.replayFps = saved.replayFps;
    if (isSeconds(saved.replaySeconds)) loaded.replaySeconds = saved.replaySeconds;
  } catch (err) { /* first run, or the file is unreadable: use the defaults */ }
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
const restartNeeded = () => SWITCHES.some(([name]) => settings.switches[name] !== startupSwitches[name]);

const settingsState = () => ({
  settings,
  restartNeeded: restartNeeded(),
  options: { keys: KEY_LABELS, fps: FPS_OPTIONS, switches: SWITCHES, seconds: SECONDS_RANGE, bitrate: REPLAY.videoBitrate },
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
    } else if (key === SETTINGS_KEY) {
      error = 'F1 always opens the settings, pick another key';
    } else if (!KEY_PATTERN.test(key)) {
      error = 'Use a letter, a number or F2 to F12';
    } else {
      const clash = Object.keys(next.keys).find((a) => a !== action && next.keys[a].toLowerCase() === key.toLowerCase());
      if (clash) error = `${key.toUpperCase()} is already used for "${KEY_LABELS[clash]}"`;
      else next.keys[action] = key;
    }
  } else if (change.switch) {
    const [name, enabled] = change.switch;
    if (name in next.switches && typeof enabled === 'boolean') next.switches[name] = enabled;
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


async function copyImageToClipboard(image) {
  if (typeof clipboard.writeImage === 'function') {
    clipboard.writeImage(image);
  } else {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) })]);
  }
}


function notifySaved(title, file) {
  const notification = new Notification({ title, body: file });
  notification.on('click', () => shell.showItemInFolder(file));
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

          // neon glow (a still frame of the breathing animation)
          ctx.fillStyle = p.glow;
          ctx.shadowColor = p.glow;
          ctx.globalAlpha = 0.55;
          for (const blur of [10, 18]) {
            ctx.shadowBlur = blur * p.scale;
            ctx.fillText(p.text, x, y);
          }

          // white core text on top
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

    fs.writeFileSync(file, image.toPNG());
    try {
      await copyImageToClipboard(image);
    } catch (err) {
      console.error('Could not copy the screenshot to the clipboard:', err.message);
    }
    notifySaved('Screenshot saved', file);
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
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
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
  ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen', 'show']
    .forEach((event) => win.on(event, place));

  wm.once('ready-to-show', () => {
    place();
    if (win.isVisible()) wm.showInactive();
  });

  return wm;
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
    try { await run('replay.stop()'); } catch (err) { /* helper is gone */ }
  };

  const start = async () => {
    if (!enabled || starting || win.isDestroyed()) return;
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
    new Notification({
      title: 'Instant replay',
      body: enabled ? `On: always keeping the last ${settings.replaySeconds} seconds` : 'Off',
    }).show();
  };

  const save = async () => {
    if (!enabled) {
      new Notification({ title: 'Instant replay is off', body: `Press ${settings.keys.replayToggle.toUpperCase()} to turn it on` }).show();
      return;
    }
    if (saving) return;
    saving = true;
    try {
      const clip = await run('replay.save()');
      if (!clip) {
        new Notification({ title: 'Instant replay', body: 'Nothing recorded yet, try again in a few seconds' }).show();
        return;
      }
      const dir = path.join(app.getPath('videos'), 'Deadshot');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `deadshot-replay-${timestamp()}.mp4`);
      fs.writeFileSync(file, Buffer.from(clip.bytes));
      notifySaved(`Replay saved (${Math.round(clip.seconds)}s)`, file);
    } catch (err) {
      console.error('[replay] save failed:', err.message);
    } finally {
      saving = false;
    }
  };

  
  win.webContents.once('did-finish-load', start);
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
  let window = null;

  ipcMain.handle('settings:get', () => settingsState());
  ipcMain.handle('settings:update', (event, change) => {
    const result = changeSetting(change);
    if (result.changed) onChange(result.previous);
    return { error: result.error, state: settingsState() };
  });
  ipcMain.handle('settings:restart', () => {
    app.relaunch();
    app.quit();
  });

  win.on('closed', () => {
    if (window && !window.isDestroyed()) window.destroy();
  });

  return function open() {
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      return;
    }
    window = new BrowserWindow({
      parent: win,
      width: 520,
      height: 720,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Simplicity Vanilla - Settings',

      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    window.removeMenu();
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.loadFile(path.join(__dirname, 'settings.html')).catch((err) => {
      const message = `Could not open settings.html (it must be in the same folder as main.js): ${err.message}`;
      window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="font:14px sans-serif;background:#14161a;color:#ff6b6b;padding:24px">${message}</body>`));
    });
  };
}


function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    icon: path.join(__dirname, '/icon.jpg'),
    title: TITLE,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false, 
    },
  });

  win.on('page-title-updated', (e) => e.preventDefault()); 

  const watermark = createWatermark(win);
  const replay = createReplay(win);

  const openSettings = createSettings(win, (previous) => {
    if (settings.glow !== previous.glow) {
      watermark.webContents
        .executeJavaScript(`document.documentElement.style.setProperty('--glow', ${JSON.stringify(settings.glow)})`)
        .catch(() => {});
    }
    if (settings.replayFps !== previous.replayFps) replay.restart();
    if (settings.replaySeconds !== previous.replaySeconds) replay.setSeconds(settings.replaySeconds);
  });

  
  const updateTitle = () => {
    if (win.isDestroyed()) return;
    const rec = replay.isRecording() ? ` | ● REC ${replay.fps()}fps` : '';
    win.setTitle(`${TITLE}${rec} | ${formatUptime(Date.now() - startTime)}`);
  };
  updateTitle();
  const titleTimer = setInterval(updateTitle, 1000);
  win.on('closed', () => clearInterval(titleTimer));

  
  const setGameVisible = (visible) => {
    if (visible) {
      win.show();
      watermark.showInactive();
    } else {
      win.hide();
      watermark.hide();
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
    if (is(input, SETTINGS_KEY)) openSettings();
    else if (is(input, keys.screenshot)) takeScreenshot(win);
    else if (is(input, keys.boss)) hideGame();
    else if (is(input, keys.replaySave)) replay.save();
    else if (is(input, keys.replayToggle)) replay.toggle();
  });

  win.loadURL('https://deadshot.io');
}

app.whenReady().then(createWindow);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());