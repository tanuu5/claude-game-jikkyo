// 編集台本（runs/<game>/edit.json）から実況動画を作る。
//   node capture/build.mjs <game> --check    台本の時間割だけ確かめる（セリフの重なり・入る文字数）
//   node capture/build.mjs <game> [--preview] 書き出し → runs/<game>/out/<game>_jikkyo.mp4（--preview は 960x540 で速く）
//
// edit.json の形（フレーム番号は録画 play.mp4 のコマ番号。秒は出来上がりの動画の秒）:
// {
//   "voice": { "speaker": 8, "speed": 1.12 },
//   "cuts": [ { "src": "<別の run 名>", "from": 100, "to": 400, "label": "前回のあらすじ" }, { "from": 0, "to": 900 }, { "from": 900, "to": 3600, "speed": 4 }, { "from": 2400, "to": 2520, "speed": 0.5, "label": "REPLAY" } ],
//   "lines": [ { "at": 30, "text": "こんにちは" }, { "at": 1200, "cut": 2, "text": "…", "delay": 0.2 } ],
//   "fx": [ { "at": 1500, "type": "zoom", "scale": 1.5, "center": [960, 600], "dur": 1.6 },
//           { "at": 1500, "type": "lines", "dur": 1.2 }, { "at": 1500, "type": "shake", "dur": 0.5 },
//           { "at": 1500, "type": "telop", "text": "転倒！", "style": "impact", "dur": 1.6 },
//           { "at": 1500, "type": "sfx", "kind": "don" } ],
//   "game_audio": { "gain": 0.9, "duck": 0.4, "fast": 0 },
//   "credits": ["VOICEVOX:春日部つむぎ"]
// }
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synth, DEFAULT_VOICE } from './voice.mjs';
import { chromePath, FONT } from './env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = process.argv[2];
const RUN = join(ROOT, 'runs', GAME);
const CHECK = process.argv.includes('--check'), PREVIEW = process.argv.includes('--preview');
const S = JSON.parse(readFileSync(join(RUN, 'session.json'), 'utf8'));
const E = JSON.parse(readFileSync(join(RUN, 'edit.json'), 'utf8'));
const FPS = 60, W = S.width || 1920, H = S.height || 1080;
const CPS = 6.8; // 1 秒あたりの文字数のめやす（春日部つむぎ・話速 1.12）

// ---- 1. カット表 → 出来上がりの時間 ----
const cuts = (E.cuts && E.cuts.length ? E.cuts : [{ from: 0, to: S.totalFrames }]).map((c) => ({ speed: 1, ...c }));
let acc = 0;
for (const c of cuts) {
  const total = c.src ? JSON.parse(readFileSync(join(ROOT, 'runs', c.src, 'session.json'), 'utf8')).totalFrames : S.totalFrames;
  c.to = Math.min(c.to, total);
  c.start = acc;
  c.len = (c.to - c.from) / FPS / c.speed;
  acc += c.len;
}
const DUR = acc;
function outTime(o, what) {
  if (o.t != null) return o.t;
  // src を付けたカット（前回の録画など）は、同じ src を指定した lines / fx だけが参照する
  const list = o.cut != null ? [cuts[o.cut]] : cuts.filter((c) => (c.src || null) === (o.src || null));
  for (const c of list) if (o.at >= c.from && o.at < c.to) return c.start + (o.at - c.from) / FPS / c.speed;
  throw new Error(`${what}: コマ ${o.at} はどのカットにも入っていません`);
}
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

// ---- 2. セリフ ----
const vo = { ...DEFAULT_VOICE, ...(E.voice || {}) };
const lines = [];
for (const [i, l] of (E.lines || []).entries()) {
  const r = await synth(l.text, { ...vo, ...(l.voice || {}), dir: join(RUN, 'voice') });
  lines.push({ i, text: l.text, start: outTime(l, `lines[${i}]`) + (l.delay || 0), dur: r.dur, file: r.file });
}
lines.sort((a, b) => a.start - b.start);
let bad = 0;
console.log(` #   開始    長さ   次まで  ${'セリフ'}`);
for (const [k, l] of lines.entries()) {
  const next = lines[k + 1] ? lines[k + 1].start : DUR;
  const room = next - l.start;
  const over = l.dur + 0.15 > room;
  if (over) bad++;
  console.log(`${String(l.i).padStart(2)}  ${fmt(l.start).padStart(6)}  ${l.dur.toFixed(1).padStart(4)}s  ${room.toFixed(1).padStart(5)}s ${over ? `✗ ${(l.dur + 0.15 - room).toFixed(1)}s はみ出し（入るのは約${Math.max(0, Math.floor((room - 0.3) * CPS))}字）` : ' '} ${l.text.slice(0, 34)}`);
}
console.log(`動画の長さ ${fmt(DUR)}、セリフ ${lines.length} 本、重なり ${bad} か所`);
if (CHECK) process.exit(bad ? 1 : 0);
if (bad && !process.argv.includes('--force')) { console.error('セリフが重なっています。台本を直すか --force'); process.exit(1); }

// ---- 3. 字幕・テロップの画像（Chrome で文字を描く）----
const GFX = join(RUN, 'gfx');
if (existsSync(GFX)) rmSync(GFX, { recursive: true });
mkdirSync(GFX, { recursive: true });
const caps = [];
const CMAX = E.caption_max || 30; // 字幕 1 枚の最大文字数
for (const l of lines) {
  const parts = (l.text.match(/[^。！？!?]+[。！？!?]*/g) || [l.text]).flatMap((p) => (p.length > CMAX ? p.match(/[^、]+、?/g) : [p]));
  const chunks = [];
  for (const p of parts) {
    const last = chunks[chunks.length - 1];
    if (last && (last + p).length <= CMAX) chunks[chunks.length - 1] = last + p; else chunks.push(p);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  let t = l.start;
  for (const c of chunks) { const d = (l.dur * c.length) / total; caps.push({ text: c.trim(), a: t, b: t + d + 0.05 }); t += d; }
}
const STYLE = {
  // 字幕：AQUA BLUE の試行で決めた形（下端の帯、話者名つき）
  caption: (t) => `<div style="font:600 38px ${FONT};color:#fff;letter-spacing:.02em;padding:10px 30px;border-radius:14px;background:rgba(4,22,38,.62);text-shadow:0 2px 6px rgba(0,0,0,.6)"><span style="color:#ffb68a;font-size:26px;margin-right:16px;letter-spacing:.08em">Claude</span>${t}</div>`,
  impact: (t) => `<div style="font:900 132px ${FONT};color:#fff;-webkit-text-stroke:14px #e2262b;paint-order:stroke fill;letter-spacing:.02em;transform:rotate(-4deg);filter:drop-shadow(0 8px 0 rgba(0,0,0,.55))">${t}</div>`,
  good: (t) => `<div style="font:900 112px ${FONT};color:#fff35a;-webkit-text-stroke:12px #1b2a6b;paint-order:stroke fill;letter-spacing:.03em;filter:drop-shadow(0 7px 0 rgba(0,0,0,.5))">${t}</div>`,
  calm: (t) => `<div style="font:800 76px ${FONT};color:#fff;-webkit-text-stroke:9px #1d6fb8;paint-order:stroke fill;letter-spacing:.04em;filter:drop-shadow(0 5px 0 rgba(0,0,0,.45))">${t}</div>`,
  side: (t) => `<div style="font:800 54px ${FONT};color:#111;background:#ffe14d;padding:8px 26px;border-radius:6px;transform:rotate(-2deg);box-shadow:6px 6px 0 rgba(0,0,0,.6)">${t}</div>`,
  badge: (t) => `<div style="font:800 44px ${FONT};color:#fff;background:rgba(0,0,0,.55);padding:6px 22px;border-radius:999px;letter-spacing:.06em">${t}</div>`,
  credit: (t) => `<div style="font:500 26px ${FONT};color:rgba(255,255,255,.9);text-shadow:0 1px 4px #000">${t}</div>`,
};
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
const page = await browser.newPage();
await page.setViewport({ width: W, height: 400 });
let gi = 0;
async function gfx(style, text) {
  await page.setContent(`<html><body style="margin:0;background:transparent;display:flex;justify-content:center;align-items:center;height:400px">${STYLE[style](text)}</body></html>`);
  const f = join(GFX, `${String(gi++).padStart(4, '0')}_${style}.png`);
  await page.screenshot({ path: f, omitBackground: true });
  return f;
}
const plan = { width: W, height: H, fps: FPS, duration: DUR, preview: PREVIEW, source: join(RUN, 'play.mp4'), runs: join(ROOT, 'runs'), gameAudio: existsSync(join(RUN, 'game_audio.wav')) ? join(RUN, 'game_audio.wav') : null,
  cuts, overlays: [], zooms: [], shakes: [], speedlines: [], voices: lines.map((l) => ({ file: l.file, start: l.start })), sfx: [], audio: { gain: 0.9, duck: 0.4, fast: 0, ...(E.game_audio || {}) },
  out: join(RUN, 'out', `${GAME}_jikkyo${PREVIEW ? '_preview' : ''}.mp4`) };
// 字幕は画面の下（y = 中心 1012 あたり）。
// ゲームの HUD と重なるときは edit.json の caption_y で高さを変える
for (const c of caps) plan.overlays.push({ png: await gfx('caption', c.text), a: c.a, b: c.b, cy: E.caption_y || H - 68, anim: 'none' });
// 早送り・スローの表示
for (const c of cuts) if (c.speed !== 1 || c.label) {
  const label = c.label || (c.speed > 1 ? `▶▶ ×${c.speed}` : `SLOW ×${c.speed}`);
  plan.overlays.push({ png: await gfx('badge', label), a: c.start, b: c.start + c.len, cx: (E.badge && E.badge[0]) || W / 2, cy: (E.badge && E.badge[1]) || 165, anim: 'pop' });
}
for (const [i, f] of (E.fx || []).entries()) {
  const a = outTime(f, `fx[${i}]`) + (f.delay || 0);
  const dur = f.dur || 1.2;
  if (f.type === 'zoom') { plan.zooms.push({ a, dur, scale: f.scale || 1.5, center: f.center || [W / 2, H / 2], ease: f.ease || 'punch' }); if (f.sfx !== false) plan.sfx.push({ kind: 'whoosh', at: a, gain: 0.5 }); }
  else if (f.type === 'lines') plan.speedlines.push({ a, b: a + dur, color: f.color || 'white', center: f.center || [W / 2, H / 2] });
  else if (f.type === 'shake') plan.shakes.push({ a, b: a + (f.dur || 0.5), amp: f.amp || 14 });
  else if (f.type === 'telop') {
    const style = f.style || 'impact';
    const pos = f.pos === 'top' ? [W / 2, 190] : f.pos === 'low' ? [W / 2, H - 260] : Array.isArray(f.pos) ? f.pos : [W / 2, H / 2 - 40];
    plan.overlays.push({ png: await gfx(style, f.text), a, b: a + dur, cx: pos[0], cy: pos[1], anim: f.anim || (style === 'side' ? 'slide' : 'pop') });
    if (f.sfx !== false) plan.sfx.push({ kind: style === 'impact' ? 'don' : style === 'good' ? 'kira' : 'pop', at: a, gain: 0.8 });
  } else if (f.type === 'sfx') plan.sfx.push({ kind: f.kind, at: a, gain: f.gain ?? 0.8 });
}
for (const [k, t] of (E.credits || []).entries()) plan.overlays.push({ png: await gfx('credit', t), a: DUR - 6, b: DUR, cx: W - 330, cy: 60 + k * 40, anim: 'fade' });
await browser.close();
mkdirSync(dirname(plan.out), { recursive: true });
writeFileSync(join(RUN, 'plan.json'), JSON.stringify(plan, null, 1));
execFileSync('python3', [join(ROOT, 'capture', 'compose.py'), join(RUN, 'plan.json')], { stdio: 'inherit' });
