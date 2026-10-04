// LAST COURIER（Three.js の 3D 配送ゲーム。静的配信、three は CDN）のアダプタ。
// ゲームの変数はクラシックスクリプトのトップレベル（G, player, input, camState …）なので、ページ側で名前のまま読める。
export default {
  name: 'LAST COURIER',
  serve: { type: 'static', dir: 'games/last-courier' },
  path: '/index.html',
  audio: true,
  init: () => {
    try {
      localStorage.clear();
      localStorage.setItem('last-courier-guide', '1');      // 道しるべ：次の行き先を表示
      localStorage.setItem('last-courier-quality', 'high'); // 自動で画質を落とさない
    } catch {}
  },
  ready: 'window.__LC && G.mode === "title" && !document.querySelector("#btnNew").disabled && document.fonts.status === "loaded"',
  setup: () => {
    input.lockFailed = true; // ポインタロックなし：カメラは camState を直接動かす
    const R2D = 180 / Math.PI;
    const comp = (dx, dz) => Math.round(((Math.atan2(dx, -dz) * R2D) + 360) % 360);
    const rel = (x, z) => ({ bearing: comp(x - player.pos.x, z - player.pos.z), dist: Math.round(Math.hypot(x - player.pos.x, z - player.pos.z)) });
    let last = { mode: G.mode, state: player.state, falls: 0, delivered: 0, acks: 0, cargo: 0, rain: 0, prompt: null };
    window.__adapter = {
      canvas: () => document.getElementById('game'),
      button: (i, down) => { input.mouse[i] = down; },
      pre: () => { input.lockFailed = true; },
      // 向き：カメラの yaw。W は (-sin yaw, -cos yaw) へ進む → コンパスの方位 θ は yaw = -θ
      view: () => ({ yaw: camState.yaw, pitch: camState.pitch }),
      turnBy: (dy, dp) => { camState.yaw += dy; camState.pitch = Math.max(-0.35, Math.min(1.25, camState.pitch + dp)); },
      yawOfHeading: (h) => (-h * Math.PI) / 180,
      headingOfYaw: (y) => (((-y * R2D) % 360) + 360) % 360,
      yawSign: -1,
      dirOfPixel: (px, py) => {
        const v = new THREE.Vector3((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1, 0.5).unproject(camera).sub(camera.position).normalize();
        return { yaw: Math.atan2(-v.x, -v.z), pitch: camState.pitch };
      },
      actions: {
        click: (sel) => { const el = document.querySelector(sel); if (el) el.click(); },
        accept: (id) => { const o = G.orders.find((o) => o.id === id); if (o) acceptOrder(o); },
      },
      // grip:"auto" … 傾きに合わせて反射的に重心を戻す（人の反射の代わり）。"both" … 両方押して安定歩行
      tick: (dt, s) => {
        if (s.grip === 'auto') {
          const tx = player.tilt.x;
          input.keys.KeyQ = tx > (s.gripAt ?? 0.3);
          input.keys.KeyE = tx < -(s.gripAt ?? 0.3);
        } else if (s.grip === 'both') { input.keys.KeyQ = input.keys.KeyE = true; }
        if (s.fHold) { input.keys.KeyF = true; input.fHeld = true; }
      },
      endStep: (s) => {
        if (s.grip) input.keys.KeyQ = input.keys.KeyE = false;
        if (s.fHold) { input.keys.KeyF = false; input.fHeld = false; }
      },
      status: () => {
        const objs = (typeof mainObjectives === 'function' ? mainObjectives() : []).map((m) => ({ kind: m.kind, order: m.o.title, node: m.node.name, ...rel(m.node.x, m.node.z) }));
        const echoes = G.echoes.filter((e) => e.state !== 'gone').map((e) => ({ state: e.state, ...rel(e.pos.x, e.pos.z) })).filter((e) => e.dist < 60);
        return {
          mode: G.mode, state: player.state,
          pos: [player.pos.x, player.pos.y, player.pos.z].map((v) => +v.toFixed(1)),
          facing: comp(Math.sin(player.heading), Math.cos(player.heading)),
          speed: +player.speed.toFixed(2),
          tilt: { x: +player.tilt.x.toFixed(2), z: +player.tilt.z.toFixed(2) },
          battery: Math.round(player.battery), cond: Math.round(player.cond),
          cargo: player.cargo.map((c) => `${c.name}${c.w}kg(${Math.round(c.cond)}%)`),
          groundCargo: G.cargo.filter((c) => c.loc === 'ground').length,
          waterDepth: +player.depth.toFixed(2), rain: +(typeof envRain === 'number' ? envRain : 0).toFixed(2),
          echoSensor: +player.sensor?.toFixed?.(2) || 0, echoes,
          objectives: objs, waypoint: G.waypoint ? rel(G.waypoint.x, G.waypoint.z) : null,
          prompt: promptAction ? promptAction.type : null,
          stats: { falls: G.stats.falls, delivered: G.stats.delivered, acks: G.stats.acksRecv, grades: G.stats.grades },
        };
      },
      events: () => {
        const out = [];
        if (G.mode !== last.mode) { out.push({ kind: 'mode', to: G.mode }); last.mode = G.mode; }
        if (player.state !== last.state) { out.push({ kind: 'state', to: player.state }); last.state = player.state; }
        if (G.stats.falls > last.falls) { out.push({ kind: 'fall' }); last.falls = G.stats.falls; }
        if (G.stats.delivered > last.delivered) { out.push({ kind: 'delivered' }); last.delivered = G.stats.delivered; }
        if (G.stats.acksRecv > last.acks) { out.push({ kind: 'ack', n: G.stats.acksRecv }); last.acks = G.stats.acksRecv; }
        if (player.cargo.length !== last.cargo) { out.push({ kind: 'cargo', n: player.cargo.length }); last.cargo = player.cargo.length; }
        const r = typeof envRain === 'number' ? envRain : 0;
        if ((r > 0.3) !== (last.rain > 0.3)) out.push({ kind: r > 0.3 ? 'rain-start' : 'rain-stop' });
        last.rain = r;
        return out;
      },
    };
  },
};
