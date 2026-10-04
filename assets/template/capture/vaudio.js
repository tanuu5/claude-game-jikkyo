// Virtual audio: makes a game's Web Audio render in lockstep with the virtual clock.
//
// Injected before any page script (after vclock.js). window.AudioContext is replaced by a
// subclass of OfflineAudioContext. The capture driver calls __vaudio.advance(VC.now) after
// every __vc.step(): the offline context renders exactly up to the new virtual time and
// suspends again, so ctx.currentTime == virtual time and every node the game starts,
// every gain it sets, lands on the same frame as the picture. At the end __vaudio.finish()
// renders the rest and hands back 16-bit PCM.
//
// Limits: <audio>/HTMLMediaElement and MediaStream sources are not captured. AnalyserNode
// works but sees offline data. The offline buffer is preallocated (window.__VAUDIO_SECONDS,
// default 900 s, stereo 48 kHz ≈ 350 MB float) – set it before load for longer sessions.
(() => {
  if (window.__vaudio || !window.OfflineAudioContext) return;
  const OAC = window.OfflineAudioContext;
  const P = OAC.prototype;
  const SR = 48000;
  const Q = 128 / SR; // render quantum
  const list = [];

  class VAudioContext extends OAC {
    constructor() {
      super({ numberOfChannels: 2, length: Math.ceil((window.__VAUDIO_SECONDS || 900) * SR), sampleRate: SR });
      this.__v = { started: false, startVT: 0, at: 0, done: null };
      list.push(this);
    }
    get state() { return 'running'; }
    get baseLatency() { return 0; }
    get outputLatency() { return 0; }
    resume() { return Promise.resolve(); }   // games call these on gestures / blur
    suspend() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: performance.now() }; }
  }
  window.AudioContext = VAudioContext;
  window.webkitAudioContext = VAudioContext;

  const V = {
    contexts: list,
    // Render every context up to virtual time nowMs (performance.now() of the virtual clock).
    async advance(nowMs) {
      for (const c of list) {
        const v = c.__v;
        if (!v.started) { v.started = true; v.startVT = nowMs; continue; }
        const target = Math.floor((nowMs - v.startVT) / 1000 / Q) * Q;
        if (target <= v.at + 1e-9) continue;
        const reached = P.suspend.call(c, target);
        if (!v.done) v.done = P.startRendering.call(c);
        else P.resume.call(c);
        await reached;
        v.at = target;
      }
    },
    // Finish rendering and keep [0, endMs) of each context as interleaved int16.
    async finish(endMs) {
      V.out = [];
      for (const c of list) {
        const v = c.__v;
        if (!v.done) continue;
        P.resume.call(c);
        const buf = await v.done;
        const n = Math.max(0, Math.min(buf.length, Math.round(((endMs - v.startVT) / 1000) * SR)));
        const L = buf.getChannelData(0), R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0);
        const pcm = new Int16Array(n * 2);
        for (let i = 0; i < n; i++) {
          pcm[2 * i] = Math.max(-1, Math.min(1, L[i])) * 32767;
          pcm[2 * i + 1] = Math.max(-1, Math.min(1, R[i])) * 32767;
        }
        V.out.push({ startVT: v.startVT, samples: n, bytes: new Uint8Array(pcm.buffer) });
      }
      return V.out.map((o) => ({ startVT: o.startVT, samples: o.samples, size: o.bytes.length }));
    },
    // base64 slice of finished context k (for transfer to the driver in chunks)
    chunk(k, from, len) {
      const b = V.out[k].bytes.subarray(from, from + len);
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return btoa(s);
    },
  };
  window.__vaudio = V;
})();
