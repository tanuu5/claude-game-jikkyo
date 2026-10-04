#!/usr/bin/env python3
"""plan.json（build.mjs が作る）から、映像と音を合成して MP4 にする。

映像：カットごとに play.mp4 を ffmpeg で読み、1 コマずつ numpy/PIL で
  ズーム（パンチイン）・画面揺れ・集中線・テロップ・字幕を重ねて ffmpeg に渡す。
音：ゲームの音（カットに合わせて切り貼り、セリフの下では下げる）＋セリフ＋効果音（ここで合成）。
"""
import json, math, subprocess, sys, wave
import numpy as np
from PIL import Image, ImageDraw
from scipy.signal import resample_poly

P = json.load(open(sys.argv[1]))
FPS = P['fps']
SCALE = 0.5 if P.get('preview') else 1.0
W0, H0 = P['width'], P['height']
W, H = int(W0 * SCALE), int(H0 * SCALE)
DUR = P['duration']
NOUT = int(round(DUR * FPS))
SR = 48000
rng = np.random.default_rng(7)

def ease_out(x): return 1 - (1 - x) ** 3
def ease_inout(x): return 4 * x ** 3 if x < .5 else 1 - (-2 * x + 2) ** 3 / 2
def ease_back(x, s=1.9): x -= 1; return 1 + x * x * ((s + 1) * x + s)

# ---------------- 重ねる画像 ----------------
def load_overlay(path):
    im = Image.open(path).convert('RGBA')
    bb = im.getbbox() or (0, 0, 1, 1)
    im = im.crop(bb)
    if SCALE != 1: im = im.resize((max(1, int(im.width * SCALE)), max(1, int(im.height * SCALE))), Image.LANCZOS)
    return im

for o in P['overlays']:
    o['im'] = load_overlay(o['png'])
    o.setdefault('cx', W0 / 2)
    o['cache'] = {}

def make_speedlines(color, center, seed):
    r = np.random.default_rng(seed)
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, cy = center[0] * SCALE, center[1] * SCALE
    R = math.hypot(W, H)
    col = (255, 255, 255) if color == 'white' else (10, 10, 14)
    n = 170
    for k in range(n):
        a = (k + r.random()) / n * 2 * math.pi
        wdt = r.uniform(0.003, 0.013)
        rin = r.uniform(0.62, 0.95)
        ex, ey = 0.40 * W * rin, 0.40 * H * rin
        tip = (cx + math.cos(a) * ex, cy + math.sin(a) * ey)
        p1 = (cx + math.cos(a - wdt) * R, cy + math.sin(a - wdt) * R)
        p2 = (cx + math.cos(a + wdt) * R, cy + math.sin(a + wdt) * R)
        d.polygon([tip, p1, p2], fill=col + (int(r.uniform(150, 235)),))
    return np.asarray(im)

for s in P['speedlines']:
    s['frames'] = [make_speedlines(s['color'], s['center'], 11 + i) for i in range(4)]

def blend(frame, rgba, x0, y0, mul=1.0):
    h, w = rgba.shape[:2]
    x1, y1 = max(0, x0), max(0, y0)
    x2, y2 = min(W, x0 + w), min(H, y0 + h)
    if x2 <= x1 or y2 <= y1: return
    src = rgba[y1 - y0:y2 - y0, x1 - x0:x2 - x0]
    a = src[..., 3:4].astype(np.uint16)
    if mul < 1: a = (a * int(mul * 256)) >> 8
    dst = frame[y1:y2, x1:x2]
    dst[:] = ((src[..., :3].astype(np.uint16) * a + dst.astype(np.uint16) * (255 - a)) // 255).astype(np.uint8)

def overlay_state(o, t):
    """(scale, alpha, dx) for overlay o at time t, or None when hidden."""
    a, b = o['a'], o['b']
    if t < a or t >= b: return None
    u, left = t - a, b - t
    anim = o.get('anim', 'none')
    sc, al, dx = 1.0, 1.0, 0.0
    if anim == 'pop':
        if u < 0.16: sc = 0.35 + 0.65 * ease_back(u / 0.16)
        if left < 0.14: al = left / 0.14; sc = 1 + 0.08 * (1 - al)
    elif anim == 'slide':
        if u < 0.2: dx = -(1 - ease_out(u / 0.2)) * W0 * 0.7
        if left < 0.15: al = left / 0.15
    elif anim == 'fade':
        al = min(1, u / 0.3, left / 0.3)
    return sc, max(0, min(1, al)), dx

def draw_overlay(frame, o, t):
    st = overlay_state(o, t)
    if not st: return
    sc, al, dx = st
    key = round(sc, 2)
    arr = o['cache'].get(key)
    if arr is None:
        im = o['im'] if key == 1 else o['im'].resize((max(1, int(o['im'].width * key)), max(1, int(o['im'].height * key))), Image.BILINEAR)
        arr = np.asarray(im)
        if len(o['cache']) < 40: o['cache'][key] = arr
    h, w = arr.shape[:2]
    blend(frame, arr, int((o['cx'] + dx) * SCALE - w / 2), int(o['cy'] * SCALE - h / 2), al)

def zoom_at(t):
    z, wsum, cx, cy = 1.0, 0.0, 0.0, 0.0
    for e in P['zooms']:
        u = t - e['a']
        if u < 0 or u > e['dur']: continue
        if e['ease'] == 'slow':  # ゆっくり寄って戻る
            env = math.sin(math.pi * u / e['dur'])
        else:  # パンチイン：0.12 秒で寄り、最後の 0.3 秒で戻る
            env = ease_out(min(1, u / 0.12)) * (1 if e['dur'] - u > 0.3 else ease_inout((e['dur'] - u) / 0.3))
        z += (e['scale'] - 1) * env
        wsum += env; cx += env * e['center'][0]; cy += env * e['center'][1]
    if wsum > 0: cx, cy = cx / wsum, cy / wsum
    else: cx, cy = W0 / 2, H0 / 2
    sx = sy = 0.0
    for s in P['shakes']:
        if s['a'] <= t < s['b']:
            k = 1 - (t - s['a']) / (s['b'] - s['a'])
            sx += math.sin(t * 91.0) * s['amp'] * k
            sy += math.cos(t * 77.0) * s['amp'] * k * 0.7
            z = max(z, 1 + (s['amp'] * 2.4) / W0)
    return z, cx, cy, sx, sy

def mix_audio():
    n = int(DUR * SR) + SR
    game = np.zeros((n, 2), np.float32)
    A = P['audio']
    if P.get('gameAudio'):
        w = wave.open(P['gameAudio'])
        src = np.frombuffer(w.readframes(w.getnframes()), np.int16).reshape(-1, 2).astype(np.float32) / 32768
        fade = int(0.02 * SR)
        for c in P['cuts']:
            i0 = int(round(c['start'] * SR)); L = int(round(c['len'] * SR))
            s0, s1 = int(c['from'] / FPS * SR), int(c['to'] / FPS * SR)
            seg = src[s0:s1]
            if c['speed'] != 1:
                if A.get('fast', 0) <= 0: continue
                idx = np.linspace(0, max(0, len(seg) - 1), L)
                seg = np.stack([np.interp(idx, np.arange(len(seg)), seg[:, ch]) for ch in (0, 1)], 1) * A['fast']
            seg = seg[:L].copy()
            if len(seg) > 2 * fade:
                ramp = np.linspace(0, 1, fade)[:, None]
                seg[:fade] *= ramp; seg[-fade:] *= ramp[::-1]
            game[i0:i0 + len(seg)] += seg
    voice = np.zeros((n, 2), np.float32)
    active = np.zeros(n, np.float32)
    for v in P['voices']:
        w = wave.open(v['file'])
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        if w.getnchannels() > 1: x = x.reshape(-1, w.getnchannels()).mean(1)
        x = resample_poly(x, SR, w.getframerate()).astype(np.float32)
        i0 = int(v['start'] * SR)
        voice[i0:i0 + len(x)] += x[:n - i0, None]
        active[i0:i0 + len(x)] = 1
    # ダッキング：セリフの間はゲーム音を下げる（立ち上がり 0.08 秒、戻り 0.35 秒）
    env = np.zeros(n, np.float32); e = 0.0
    up, down = 1 - math.exp(-1 / (0.08 * SR)), 1 - math.exp(-1 / (0.35 * SR))
    step = 64
    for i in range(0, n, step):
        tgt = active[i]
        e += (tgt - e) * (1 - (1 - (up if tgt > e else down)) ** step)
        env[i:i + step] = e
    gg = A['gain'] * (1 - (1 - A['duck']) * env)
    out = game * gg[:, None] + voice * 1.0
    for s in P['sfx']:
        x = SFX[s['kind']]() * s.get('gain', 0.8)
        i0 = int(s['at'] * SR)
        out[i0:i0 + len(x)] += x[:n - i0, None]
    out = out[:int(DUR * SR)]
    peak = np.abs(out).max()
    if peak > 0.89: out *= 0.89 / peak
    w = wave.open(P['out'] + '.wav', 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((out * 32767).astype(np.int16).tobytes()); w.close()

def _t(d): return np.arange(int(d * SR)) / SR
def _env(t, a, d): return np.minimum(1, t / a) * np.exp(-t / d)
SFX = {
    'pop': lambda: (np.sin(2 * np.pi * np.cumsum(np.linspace(700, 1500, len(_t(.09)))) / SR) * _env(_t(.09), .004, .03)).astype(np.float32) * 0.6,
    'don': lambda: ((np.sin(2 * np.pi * np.cumsum(55 + 90 * np.exp(-_t(.7) * 18)) / SR) * _env(_t(.7), .003, .22)
                     + rng.normal(0, 1, len(_t(.7))) * _env(_t(.7), .001, .015) * .5)).astype(np.float32) * 0.9,
    'whoosh': lambda: (np.convolve(rng.normal(0, 1, len(_t(.32))), np.ones(24) / 24, 'same') * np.sin(np.pi * _t(.32) / .32) ** 2).astype(np.float32) * 0.9,
    'kira': lambda: sum(np.pad(np.sin(2 * np.pi * f * _t(.5)) * _env(_t(.5), .003, .12), (int(i * .07 * SR), int((2 - i) * .07 * SR)))
                        for i, f in enumerate([1568, 2093, 2637])).astype(np.float32) * 0.35,
    'ding': lambda: (np.sin(2 * np.pi * 1318 * _t(.8)) * _env(_t(.8), .002, .25) + np.sin(2 * np.pi * 2637 * _t(.8)) * _env(_t(.8), .002, .1) * .3).astype(np.float32) * 0.4,
    'boing': lambda: (np.sin(2 * np.pi * np.cumsum(220 + 160 * np.sin(_t(.4) * 40) * np.exp(-_t(.4) * 6)) / SR) * _env(_t(.4), .005, .15)).astype(np.float32) * 0.6,
}

mix_audio()

# ---------------- 映像 ----------------
enc = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                        '-i', P['out'] + '.wav', '-map', '0:v', '-map', '1:a',
                        '-c:v', 'libx264', '-preset', 'veryfast' if SCALE < 1 else 'medium', '-crf', '23' if SCALE < 1 else '20', '-maxrate', '20M', '-bufsize', '40M', '-pix_fmt', 'yuv420p',
                        # 音量は YouTube 向けに -16 LUFS へ（耳で確かめられないので数値でそろえる）
                        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', P['out']], stdin=subprocess.PIPE)

FR = W * H * 3
k = 0
for ci, c in enumerate(P['cuts']):
    k0, k1 = int(round(c['start'] * FPS)), min(NOUT, int(round((c['start'] + c['len']) * FPS)))
    if k1 <= k0: continue
    n_src = c['to'] - c['from']
    args = ['ffmpeg', '-loglevel', 'error', '-ss', f"{(c['from'] - 0.25) / FPS:.5f}", '-i', P['source'], '-frames:v', str(n_src)]
    if SCALE != 1: args += ['-vf', f'scale={W}:{H}:flags=bilinear']
    dec = subprocess.Popen(args + ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    have, cur = -1, None
    for k in range(k0, k1):
        t = k / FPS
        want = min(n_src - 1, int((t - c['start']) * c['speed'] * FPS + 1e-6))
        while have < want:
            buf = dec.stdout.read(FR)
            if len(buf) < FR: break
            cur, have = buf, have + 1
        frame = np.frombuffer(cur, np.uint8).reshape(H, W, 3)
        z, cx, cy, sx, sy = zoom_at(t)
        if z > 1.0005:
            cw, ch = W / z, H / z
            x0 = min(max(cx * SCALE - cw / 2 + sx * SCALE, 0), W - cw)
            y0 = min(max(cy * SCALE - ch / 2 + sy * SCALE, 0), H - ch)
            frame = np.asarray(Image.fromarray(frame).resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch)))
        frame = frame.copy()
        for s in P['speedlines']:
            if s['a'] <= t < s['b']:
                u, left = t - s['a'], s['b'] - t
                blend(frame, s['frames'][(k // 3) % 4], 0, 0, min(1, u / 0.08, left / 0.15))
        for o in P['overlays']: draw_overlay(frame, o, t)
        enc.stdin.write(frame.tobytes())
    dec.stdout.close(); dec.wait()
    print(f'  cut {ci + 1}/{len(P["cuts"])}  {k1 / FPS:6.1f}s / {DUR:.1f}s', flush=True)
enc.stdin.close()
enc.wait()
import os
os.remove(P['out'] + '.wav')
print('wrote', P['out'])
