// Virtual clock, injected before any page script runs (evaluateOnNewDocument).
//
// While "real", everything passes through to the browser. After __vc.freeze(),
// performance.now / Date.now stop, requestAnimationFrame callbacks and timers are
// queued, and nothing happens until the capture driver calls __vc.step(ms): the clock
// advances, due timers fire in order, then every queued rAF callback runs once with
// the new timestamp. A game therefore renders exactly one frame per step, however
// long the screenshot takes, and slow motion is just a smaller step.
(() => {
  if (window.__vc) return;
  const nRAF = window.requestAnimationFrame.bind(window);
  const nCAF = window.cancelAnimationFrame.bind(window);
  const nPerf = performance.now.bind(performance);
  const nDate = Date.now.bind(Date);
  const nSetTimeout = window.setTimeout.bind(window);
  const nClearTimeout = window.clearTimeout.bind(window);
  const nSetInterval = window.setInterval.bind(window);
  const nClearInterval = window.clearInterval.bind(window);

  const VC = {
    frozen: false,
    now: 0,
    dateOffset: nDate() - nPerf(),
    raf: new Map(),        // id -> cb   (queued while frozen)
    rafNative: new Map(),  // id -> native id (registered while real)
    timers: new Map(),     // id -> { due, cb, args, interval, native }
    nextId: 1,
    frames: 0,
    errors: [],
  };
  window.__vc = VC;

  const call = (fn, args) => {
    try { if (typeof fn === 'function') fn(...args); }
    catch (e) { VC.errors.push(String((e && e.stack) || e)); console.error(e); }
  };

  performance.now = function now() { return VC.frozen ? VC.now : nPerf(); };
  Date.now = function now() { return VC.frozen ? Math.floor(VC.dateOffset + VC.now) : nDate(); };

  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    const id = VC.nextId++;
    if (VC.frozen) { VC.raf.set(id, cb); return id; }
    const nid = nRAF((ts) => {
      VC.rafNative.delete(id);
      if (VC.frozen) { VC.raf.set(id, cb); return; }
      call(cb, [ts]);
    });
    VC.rafNative.set(id, nid);
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    VC.raf.delete(id);
    const nid = VC.rafNative.get(id);
    if (nid !== undefined) { nCAF(nid); VC.rafNative.delete(id); }
  };

  function addTimer(cb, ms, args, repeat) {
    const id = VC.nextId++;
    const delay = Math.max(0, +ms || 0);
    const t = { due: (VC.frozen ? VC.now : nPerf()) + delay, cb, args, interval: repeat ? Math.max(1, delay) : 0, native: null };
    VC.timers.set(id, t);
    if (!VC.frozen) arm(id, t);
    return id;
  }
  function arm(id, t) {
    const fire = () => {
      if (VC.frozen) return;                 // moved to the virtual queue at freeze
      if (t.interval) t.due += t.interval; else VC.timers.delete(id);
      call(t.cb, t.args);
    };
    t.native = t.interval ? nSetInterval(fire, t.interval) : nSetTimeout(fire, Math.max(0, t.due - nPerf()));
  }
  function clearTimer(id) {
    const t = VC.timers.get(id);
    if (!t) return;
    if (t.native != null) { t.interval ? nClearInterval(t.native) : nClearTimeout(t.native); }
    VC.timers.delete(id);
  }
  window.setTimeout = function setTimeout(cb, ms, ...args) { return addTimer(cb, ms, args, false); };
  window.setInterval = function setInterval(cb, ms, ...args) { return addTimer(cb, ms, args, true); };
  window.clearTimeout = clearTimer;
  window.clearInterval = clearTimer;

  VC.freeze = () => {
    if (VC.frozen) return VC.now;
    VC.now = nPerf();
    VC.frozen = true;
    for (const t of VC.timers.values()) {
      if (t.native != null) { t.interval ? nClearInterval(t.native) : nClearTimeout(t.native); t.native = null; }
    }
    return VC.now;
  };

  // Advance virtual time by ms: fire due timers in order, then one round of rAF.
  VC.step = (ms, { raf = true } = {}) => {
    const target = VC.now + ms;
    for (let guard = 0; guard < 100000; guard++) {
      let id = null, best = null;
      for (const [k, t] of VC.timers) if (t.due <= target && (!best || t.due < best.due)) { id = k; best = t; }
      if (!best) break;
      VC.now = Math.max(VC.now, best.due);
      if (best.interval) best.due += best.interval; else VC.timers.delete(id);
      call(best.cb, best.args);
    }
    VC.now = target;
    if (raf) {
      const q = VC.raf;
      VC.raf = new Map();
      for (const cb of q.values()) call(cb, [VC.now]);
    }
    VC.frames++;
    return VC.frames;
  };

  // Run n steps in one call (for fast-forwarding without capturing).
  VC.run = (n, ms) => { for (let i = 0; i < n; i++) VC.step(ms); return VC.now; };
})();
