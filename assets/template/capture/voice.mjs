// VOICEVOX でセリフを音声にする（同じ文・同じ設定なら作り直さない）。
// エンジンが動いていなければ、VOICEVOX のアプリに入っているエンジンを画面なしで起動する（場所は env.mjs）。
//   import { synth } from './voice.mjs';  const { file, dur } = await synth('こんにちは', { dir });
//   node capture/voice.mjs "テスト"        → 1 本だけ作って長さを表示
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { voicevoxEngine } from './env.mjs';

export const VV = process.env.VOICEVOX_URL || 'http://127.0.0.1:50021';
export const DEFAULT_VOICE = { speaker: 8, speed: 1.12, pitch: 0, intonation: 1.15, volume: 1 }; // 春日部つむぎ（ノーマル）

let ready = null;
export function ensureEngine() {
  if (ready) return ready;
  ready = (async () => {
    const ok = async () => { try { return (await fetch(VV + '/version', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
    if (await ok()) return;
    const ENGINE = voicevoxEngine();
    if (!ENGINE) throw new Error('VOICEVOX が動いていません。アプリを起動するか、エンジンの場所を VOICEVOX_ENGINE で指定してください');
    const port = new URL(VV).port || '50021';
    spawn(ENGINE, ['--host', '127.0.0.1', '--port', port], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 90; i++) { if (await ok()) return; await new Promise((r) => setTimeout(r, 1000)); }
    throw new Error('VOICEVOX エンジンが起動しませんでした');
  })();
  return ready;
}

export function wavDuration(buf) {
  // RIFF を走査して fmt と data を探す（VOICEVOX の WAV は 44 バイトの素直な形だが念のため）
  let p = 12, rate = 24000, ch = 1, bits = 16, bytes = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), n = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') { ch = buf.readUInt16LE(p + 10); rate = buf.readUInt32LE(p + 12); bits = buf.readUInt16LE(p + 22); }
    if (id === 'data') { bytes = n; break; }
    p += 8 + n + (n & 1);
  }
  return bytes / (rate * ch * (bits / 8));
}

export async function synth(text, opts = {}) {
  const o = { ...DEFAULT_VOICE, ...opts };
  const dir = o.dir || 'voice';
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha1').update(JSON.stringify([text, o.speaker, o.speed, o.pitch, o.intonation, o.volume])).digest('hex').slice(0, 12);
  const file = join(dir, `${key}.wav`);
  if (!existsSync(file)) {
    await ensureEngine();
    const q = await (await fetch(`${VV}/audio_query?speaker=${o.speaker}&text=${encodeURIComponent(text)}`, { method: 'POST' })).json();
    Object.assign(q, { speedScale: o.speed, pitchScale: o.pitch, intonationScale: o.intonation, volumeScale: o.volume, prePhonemeLength: 0.05, postPhonemeLength: 0.1 });
    const res = await fetch(`${VV}/synthesis?speaker=${o.speaker}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
    if (!res.ok) throw new Error(`VOICEVOX synthesis failed: ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return { file, dur: +wavDuration(readFileSync(file)).toFixed(3) };
}

if (process.argv[1] && process.argv[1].endsWith('voice.mjs') && process.argv[2]) {
  const r = await synth(process.argv[2], { dir: 'voice-test' });
  console.log(r, `${(process.argv[2].length / r.dur).toFixed(1)} 文字/秒`);
}
