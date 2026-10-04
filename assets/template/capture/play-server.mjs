// Claude がブラウザゲームを 1 手ずつ遊ぶためのサーバー（ゲームごとの違いは adapters/<game>.mjs に書く）。
//
// ゲームは仮想時計（vclock.js）で止まっていて、/act で受け取った操作の間だけ 1/60 秒ずつ進み、
// 進んだコマはすべて録画される。考えている間はゲームの時間が進まないので、つないだ映像は普通に遊んでいるように見える。
// ゲームの音（Web Audio）も vaudio.js で同じ時計に合わせて書き出す。
//
//   node capture/play-server.mjs <game> [--port 5190]
//   curl -s localhost:5190/act -d '{"memo":"…","steps":[{"hold":["KeyW"],"sec":2}]}'
//   curl -s localhost:5190/quit        → runs/<game>/play.mp4, game_audio.wav, session.json
//
// 1 手（/act の本文）:
//   memo   : いま思ったこと（あとで台本を書く材料。録画中のこのコマに記録される）
//   say    : その場でしゃべる（VOICEVOX で即合成。ライブ実況の試し用。ふつうは memo を使う）
//   mark   : 出来事の名前（"fall" "delivered" など。編集で効果を付ける目印）
//   snap   : 名前を付けると、終わりの画面を runs/<game>/snaps/<名前>.jpg にも残す
//   steps  : 操作の列。各ステップ:
//     sec            その状態で進める秒数（press/click だけなら 0.1 秒）
//     hold [codes]   押しっぱなしのキー（KeyboardEvent.code）
//     press code|[] 1 回押す
//     buttons [i]    押しっぱなしのマウスボタン（0 左, 2 右）
//     click i        マウスボタンを 1 回押す
//     look {dx,dy}   マウス移動の合計（ピクセル）。turnSec 秒に分けて入れる
//     face {heading,pitch} / turn {yaw,pitch} / lookAt [x,y]   向き（度、画面座標）。アダプタが view を持つときだけ
//     do  "name", args   アダプタの actions[name](args, step) を呼ぶ（ゲーム専用の操作）
//     eval "式"       ページで評価（調査用）
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { synth } from './voice.mjs';
import { chromePath, gpuArgs } from './env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = process.argv[2];
if (!GAME) { console.error('usage: node capture/play-server.mjs <game>'); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const A = (await import(pathToFileURL(join(ROOT, 'adapters', `${GAME}.mjs`)).href)).default;
const RUN = join(ROOT, 'runs', GAME);
const FOOT = join(RUN, 'footage');
if (existsSync(FOOT) && !process.argv.includes('--keep')) rmSync(FOOT, { recursive: true });
for (const d of [FOOT, join(RUN, 'snaps'), join(RUN, 'live')]) mkdirSync(d, { recursive: true });
const W = A.width || 1920, H = A.height || 1080, FPS = 60, DT = 1000 / FPS;
const PORT = +arg('port', 5190);

// ---- ゲームを配信する ----
let server = null, child = null, base;
const gameDir = join(ROOT, A.serve.dir);
if (A.serve.type === 'vite') {
  const port = A.serve.port || 5181;
  child = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: gameDir, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => child.stdout.on('data', (d) => { if (String(d).includes(String(port))) res(); }));
  base = `http://127.0.0.1:${port}`;
} else {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = normalize(join(gameDir, decodeURIComponent(url.pathname)));
    if (!p.startsWith(normalize(gameDir))) return res.writeHead(403).end();
    if (url.pathname.endsWith('/')) p = join(p, 'index.html');
    let data;
    try { data = readFileSync(p); } catch { return res.writeHead(404).end(); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
process.on('exit', () => { if (child) child.kill(); });

// ---- ブラウザ（実 GPU のヘッドレス Chrome）----
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  args: [...gpuArgs(), '--force-color-profile=srgb', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`],
  protocolTimeout: 1800000,
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const CAP = join(ROOT, 'capture');
await page.evaluateOnNewDocument(readFileSync(join(CAP, 'vclock.js'), 'utf8'));
if (A.audio !== false) {
  await page.evaluateOnNewDocument(`window.__VAUDIO_SECONDS = ${+(A.audioSeconds || 900)};`);
  await page.evaluateOnNewDocument(readFileSync(join(CAP, 'vaudio.js'), 'utf8'));
}
if (A.init) await page.evaluateOnNewDocument(A.init);
page.on('pageerror', (e) => console.log('[page error]', String(e.message).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text().slice(0, 300)); });
const client = await page.createCDPSession();
await page.goto(base + (A.path || '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(A.ready, { timeout: 180000, polling: 200 });
if (A.beforeFreeze) await page.evaluate(A.beforeFreeze);
await page.evaluate(() => window.__vc.freeze());
if (A.setup) await page.evaluate(A.setup);

// ---- ページ側：1 コマぶんの入力と時計 ----
await page.evaluate((W, H) => {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const AD = window.__adapter || (window.__adapter = {});
  const canvas = () => AD.canvas ? AD.canvas() : document.querySelector('canvas');
  // 既定の入力：DOM イベントを送る（ゲームが内部状態を持つならアダプタが key/button/move を差し替える）
  const key = AD.key || ((code, down) => {
    const k = code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code === 'Space' ? ' ' : code.replace(/Left|Right$/, '');
    const ev = new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: k, bubbles: true, cancelable: true });
    (document.activeElement || document.body).dispatchEvent(ev);
  });
  const button = AD.button || ((i, down) => {
    const el = canvas() || document.body;
    el.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', { button: i, buttons: down ? 1 << i : 0, clientX: W / 2, clientY: H / 2, bubbles: true, cancelable: true }));
    if (!down && i === 0) el.dispatchEvent(new MouseEvent('click', { button: 0, clientX: W / 2, clientY: H / 2, bubbles: true }));
  });
  const move = AD.move || ((dx, dy) => {
    (canvas() || document).dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy, clientX: W / 2, clientY: H / 2, bubbles: true }));
  });
  const P = (window.__play = {
    frame: 0, plan: null, events: [],
    begin(s) {
      const held = [].concat(s.hold || []), btns = [].concat(s.buttons || []), press = [].concat(s.press || []);
      for (const k of held) key(k, true);
      for (const b of btns) button(b, true);
      for (const k of press) key(k, true);
      if (s.click != null) button(s.click, true);
      let target = null, look = s.look ? { ...s.look } : null;
      const V = AD.view && AD.view();
      if (V && (s.face || s.turn || s.lookAt)) {
        if (s.face) target = { yaw: s.face.heading != null ? AD.yawOfHeading(s.face.heading) : V.yaw, pitch: s.face.pitch != null ? s.face.pitch * D2R : V.pitch };
        if (s.turn) target = { yaw: V.yaw + AD.yawSign * (s.turn.yaw || 0) * D2R, pitch: V.pitch + (s.turn.pitch || 0) * D2R };
        if (s.lookAt) target = AD.dirOfPixel(s.lookAt[0], s.lookAt[1]);
        while (target.yaw - V.yaw > Math.PI) target.yaw -= 2 * Math.PI;
        while (target.yaw - V.yaw < -Math.PI) target.yaw += 2 * Math.PI;
      }
      const turnSec = s.turnSec ?? Math.min(0.8, s.sec || 0.8);
      let t = 0, released = false;
      if (s.do && AD.actions && AD.actions[s.do]) AD.actions[s.do](s.args, s);
      P.plan = {
        tick(dt) {
          t += dt;
          if (!released && t > dt * 1.5) {
            released = true;
            for (const k of press) key(k, false);
            if (s.click != null) button(s.click, false);
          }
          if (look) {
            const k = Math.min(1, dt / Math.max(dt, turnSec - t + dt));
            const dx = look.dx * k, dy = look.dy * k;
            look.dx -= dx; look.dy -= dy;
            if (dx || dy) move(dx, dy);
            if (t >= turnSec) look = null;
          }
          if (target) {
            const V = AD.view();
            const k = Math.min(1, dt / Math.max(dt, turnSec - t + dt));
            AD.turnBy((target.yaw - V.yaw) * k, (target.pitch - V.pitch) * k);
            if (t >= turnSec) target = null;
          }
          if (AD.tick) AD.tick(dt, s, t);
        },
        end() {
          if (!released) { for (const k of press) key(k, false); if (s.click != null) button(s.click, false); }
          for (const k of held) key(k, false);
          for (const b of btns) button(b, false);
          if (AD.endStep) AD.endStep(s);
        },
      };
    },
    async step(ms) {
      if (P.plan) P.plan.tick(ms / 1000);
      if (AD.pre) AD.pre(ms / 1000);
      window.__vc.step(ms);
      // CSS アニメーションも仮想時計で進める（実時間で流れて早送りに見えるのを防ぐ）
      for (const a of document.getAnimations()) {
        if (!a.__vc) { a.pause(); a.__vc = 1; }
        try { a.currentTime = (a.currentTime || 0) + ms; } catch {}
      }
      if (window.__vaudio) await window.__vaudio.advance(performance.now());
      P.frame++;
      if (AD.events) for (const e of AD.events() || []) P.events.push({ frame: P.frame - 1, ...e });
    },
    status() {
      const ui = [...document.querySelectorAll(AD.uiSelector || 'body *')]
        .filter((e) => e.children.length === 0 && e.offsetParent !== null && e.tagName !== 'SCRIPT' && getComputedStyle(e).opacity > 0.05)
        .map((e) => e.textContent.trim()).filter(Boolean);
      const v = AD.view && AD.view();
      return {
        frame: P.frame, t: +(P.frame / 60).toFixed(2),
        ...(v ? { heading: Math.round(AD.headingOfYaw(v.yaw)), pitch: Math.round(v.pitch * R2D) } : {}),
        ...(AD.status ? AD.status() : {}),
        uiText: [...new Set(ui)].slice(0, 40),
      };
    },
  });
}, W, H);

// ---- 記録 ----
let seg = 0, totalFrames = 0;
const memos = [], marks = [], steps = [], live = [];
let liveEnd = 0;
const t0VT = await page.evaluate(() => performance.now());
const saveLog = (extra = {}) => writeFileSync(join(RUN, 'session.json'), JSON.stringify({ game: GAME, fps: FPS, width: W, height: H, totalFrames, t0VT, memos, marks, live, events: lastEvents, steps, ...extra }, null, 1));
let lastEvents = [];

async function act(body) {
  const out = {};
  const name = join(FOOT, `seg${String(seg).padStart(4, '0')}.mp4`);
  let ff = null, done = null, wrote = 0;
  if (body.memo) memos.push({ frame: totalFrames, text: body.memo });
  if (body.mark) marks.push({ frame: totalFrames, kind: body.mark });
  if (body.say) {
    const r = await synth(body.say, { dir: join(RUN, 'live') });
    const at = totalFrames / FPS, start = Math.max(at, liveEnd + 0.15);
    liveEnd = start + r.dur;
    live.push({ frame: totalFrames, text: body.say, start, dur: r.dur, file: r.file });
    out.said = { dur: r.dur, delay: +(start - at).toFixed(2) };
  }
  for (const s of body.steps || []) {
    steps.push({ frame: totalFrames, ...s });
    if (s.eval) out.eval = await page.evaluate(s.eval);
    await page.evaluate((s) => window.__play.begin(s), s);
    const n = Math.round((s.sec ?? (s.press || s.click != null ? 0.1 : 0)) * FPS);
    for (let i = 0; i < n; i++) {
      await page.evaluate((ms) => window.__play.step(ms), DT);
      const { data } = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true });
      if (!ff) {
        ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
          '-c:v', 'libx264', '-preset', 'faster', '-crf', '16', '-pix_fmt', 'yuv420p', name], { stdio: ['pipe', 'inherit', 'inherit'] });
        done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg ' + c)))));
      }
      if (!ff.stdin.write(Buffer.from(data, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
      wrote++; totalFrames++;
    }
    await page.evaluate(() => { const p = window.__play.plan; if (p) p.end(); window.__play.plan = null; });
  }
  if (ff) { ff.stdin.end(); await done; seg++; }
  const { data } = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: W, height: H, scale: 0.5 } });
  writeFileSync(join(RUN, 'now.jpg'), Buffer.from(data, 'base64'));
  if (body.snap) writeFileSync(join(RUN, 'snaps', `${body.snap}.jpg`), Buffer.from(data, 'base64'));
  out.frames = wrote;
  out.status = await page.evaluate(() => window.__play.status());
  const ev = await page.evaluate(() => window.__play.events.splice(0));
  if (ev.length) { out.events = ev; lastEvents.push(...ev); }
  if (out.said) out.liveBacklog = +Math.max(0, liveEnd - totalFrames / FPS).toFixed(2);
  const errs = await page.evaluate(() => window.__vc.errors.splice(0));
  if (errs.length) out.errors = errs.slice(0, 2).map((e) => e.slice(0, 300));
  saveLog();
  return out;
}

async function quit() {
  // 録画をつなぐ
  const segs = readdirSync(FOOT).filter((f) => /^seg\d+\.mp4$/.test(f)).sort();
  writeFileSync(join(RUN, 'concat.txt'), segs.map((f) => `file '${join(FOOT, f)}'`).join('\n'));
  if (segs.length) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(RUN, 'concat.txt'), '-c', 'copy', join(RUN, 'play.mp4')]);
  // ゲームの音：各 AudioContext を描き終えて、録画の 0 コマ目にそろえて 1 本の WAV に
  let audio = null;
  if (A.audio !== false) {
    const endVT = await page.evaluate(() => performance.now());
    const infos = await page.evaluate((e) => window.__vaudio.finish(e), endVT);
    const SR = 48000, total = Math.ceil((totalFrames / FPS) * SR);
    const mix = new Int32Array(total * 2);
    for (const [k, info] of infos.entries()) {
      const parts = [];
      for (let p = 0; p < info.size; p += 6 << 20) parts.push(Buffer.from(await page.evaluate((k, p, n) => window.__vaudio.chunk(k, p, n), k, p, 6 << 20), 'base64'));
      const pcm = new Int16Array(new Uint8Array(Buffer.concat(parts)).buffer);
      // コマ i は「t0VT + (i+1)·dt まで進めた画面」。音の時刻 a は仮想時刻 startVT + a
      const off = Math.round(((info.startVT - t0VT) / 1000 - 1 / FPS) * SR);
      for (let i = 0; i < info.samples; i++) {
        const j = i + off;
        if (j < 0 || j >= total) continue;
        mix[2 * j] += pcm[2 * i]; mix[2 * j + 1] += pcm[2 * i + 1];
      }
    }
    const pcm = Buffer.alloc(total * 4);
    for (let i = 0; i < total * 2; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, mix[i])), i * 2);
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16);
    hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 4, 28);
    hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
    writeFileSync(join(RUN, 'game_audio.wav'), Buffer.concat([hdr, pcm]));
    audio = { contexts: infos.length, file: 'game_audio.wav' };
  }
  saveLog({ audio });
  return { ok: true, frames: totalFrames, seconds: +(totalFrames / FPS).toFixed(1), audio };
}

let busy = Promise.resolve();
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    busy = busy.then(async () => {
      try {
        let r;
        if (req.url === '/act') r = await act(body ? JSON.parse(body) : {});
        else if (req.url === '/status') r = await page.evaluate(() => window.__play.status());
        else if (req.url === '/quit') {
          r = await quit();
          setTimeout(async () => { await browser.close(); if (server) server.close(); if (child) child.kill(); process.exit(0); }, 100);
        } else r = { error: 'unknown' };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(r, null, 1));
      } catch (e) {
        console.error(e);
        res.writeHead(500).end(JSON.stringify({ error: String(e.stack || e).slice(0, 800) }));
      }
    });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`play server for ${GAME} ready on :${PORT}`));
