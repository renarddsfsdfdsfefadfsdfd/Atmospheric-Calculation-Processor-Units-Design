// Render HTML figures to vector PDF + PNG using Electron (Chromium).
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const dir = path.resolve(args[0] || 'figs/html');
const out = path.resolve(args[1] || 'figs/out');
const pngDir = path.resolve('figs/png');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(pngDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-http-cache');

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html')).sort();
  const win = new BrowserWindow({ show: false, width: 1000, height: 700,
    webPreferences: { backgroundThrottling: false } });
  for (const f of files) {
    const name = f.replace(/\.html$/, '');
    try {
      await win.loadFile(path.join(dir, f));
      await sleep(450);
      const meta = await win.webContents.executeJavaScript(
        'JSON.parse(document.body.dataset.meta || "{}")');
      const w = meta.width || 6.6, h = meta.height || 4.2;
      win.setContentSize(Math.round(w * 96), Math.round(h * 96));
      await sleep(450);
      const pdf = await win.webContents.printToPDF({
        printBackground: true, preferCSSPageSize: true,
        pageSize: { width: w, height: h },
        margins: { marginType: 'none' },
      });
      fs.writeFileSync(path.join(out, name + '.pdf'), pdf);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(pngDir, name + '.png'), img.toPNG());
      console.log('rendered', name, w + 'x' + h, (pdf.length / 1024).toFixed(0) + 'kB');
    } catch (e) {
      console.error('FAILED', name, String(e));
    }
  }
  app.quit();
});
