// 実行環境ごとの既定値（Chrome・VOICEVOX の場所、GPU の指定、字幕の書体）。
// どれも環境変数で上書きできる：CHROME_PATH、VOICEVOX_ENGINE、VOICEVOX_URL。
// 動作を確かめたのは macOS（Apple Silicon）。Windows / Linux の候補は一般的なインストール先。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const P = process.platform;
const first = (list) => list.filter(Boolean).find((p) => existsSync(p));

export function chromePath() {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const found = first([
    process.env.CHROME_PATH,
    P === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    P === 'win32' && 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    P === 'win32' && 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    P === 'win32' && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    P === 'linux' && '/usr/bin/google-chrome',
    P === 'linux' && '/usr/bin/google-chrome-stable',
    P === 'linux' && '/usr/bin/chromium',
    P === 'linux' && '/usr/bin/chromium-browser',
  ]);
  if (!found) throw new Error('Google Chrome が見つかりません。CHROME_PATH で場所を指定してください');
  return found;
}

// 実 GPU で描かせるための指定（ソフトウェア描画では再現しない不具合があるため）
export function gpuArgs() {
  const args = ['--enable-gpu', '--ignore-gpu-blocklist'];
  if (P === 'darwin') args.push('--use-angle=metal');
  if (P === 'win32') args.push('--use-angle=d3d11');
  return args;
}

export function voicevoxEngine() {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return first([
    process.env.VOICEVOX_ENGINE,
    P === 'darwin' && '/Applications/VOICEVOX.app/Contents/Resources/vv-engine/run',
    P === 'darwin' && join(homedir(), 'Applications', 'VOICEVOX.app', 'Contents', 'Resources', 'vv-engine', 'run'),
    P === 'win32' && join(local, 'Programs', 'VOICEVOX', 'vv-engine', 'run.exe'),
  ]);
}

// 字幕・テロップの書体（OS に入っている日本語のゴシック体を順に試す）
export const FONT = "'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic UI','Yu Gothic','Meiryo','Noto Sans CJK JP','Noto Sans JP',sans-serif";
