import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const url = process.argv[2];
const out = process.argv[3];
const width = Number(process.argv[4] ?? 1280);
const height = Number(process.argv[5] ?? 1400);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu',
  '--no-first-run', '--no-default-browser-check',
  `--window-size=${width},${height}`,
  '--user-data-dir=' + process.env.TMPDIR + '/cdp-profile-' + Date.now(),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error('chrome did not start');
}

const wsUrl = await endpoint();
const { default: WS } = await import('ws').catch(() => ({ default: null }));
if (!WS) { console.error('needs ws'); process.exit(1); }

const ws = new WS(wsUrl);
let id = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method) events.push(msg);
});
await new Promise((r) => ws.on('open', r));
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const next = ++id;
  pending.set(next, resolve);
  ws.send(JSON.stringify({ id: next, method, params, sessionId }));
});

const { result: target } = await send('Target.createTarget', { url: 'about:blank' });
const { result: attached } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const session = attached.sessionId;

await send('Page.enable', {}, session);
await send('Runtime.enable', {}, session);
await send('Log.enable', {}, session);
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, session);
await send('Page.navigate', { url }, session);
await sleep(Number(process.env.WAIT_MS ?? 9000));

const script = process.env.EVAL_JS;
if (script) {
  const r = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true }, session);
  console.log('EVAL:', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? null));
  await sleep(Number(process.env.AFTER_MS ?? 2500));
}

const { result: metrics } = await send('Page.getLayoutMetrics', {}, session);
const full = Math.min(Math.ceil(metrics.cssContentSize?.height ?? height), 6000);
await send('Emulation.setDeviceMetricsOverride', { width, height: full, deviceScaleFactor: 2, mobile: false }, session);
await sleep(700);
const { result: shot } = await send('Page.captureScreenshot', { format: 'png' }, session);
mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(out, Buffer.from(shot.data, 'base64'));

const errors = events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  .map((e) => e.params.entry.text).slice(0, 8);
if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.join('\n'));
console.log('wrote', out);
chrome.kill();
process.exit(0);
