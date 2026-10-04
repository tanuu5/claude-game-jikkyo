// AQUA BLUE（Three.js の 3D 海中探索。vite の開発サーバーで window.__dbg が使える）のアダプタ。見本。
export default {
  name: 'AQUA BLUE',
  serve: { type: 'vite', dir: 'games/aqua-blue', port: 5181 },
  path: '/',
  audio: true,
  // ページのスクリプトより先に：新しいセーブ、画質は最高、操作の案内は出さない
  init: () => {
    try {
      localStorage.removeItem('aquablue.save.v1');
      localStorage.setItem('aquablue.settings.v1', JSON.stringify({ quality: 'high', help: false }));
    } catch {}
  },
  ready: 'window.__dbg && window.__dbg.game.state === "boot"',
  setup: () => {
    const D = window.__dbg, I = D.input, P = D.player, G = D.game;
    const R2D = 180 / Math.PI;
    let lastState = G.state, lastFrag = 0, lastSpecies = 0;
    window.__adapter = {
      uiSelector: '#ui *',
      // 入力はゲームの Input の状態を直接書く（ポインタロックが使えないため）
      key: (code, down) => { if (down) { I.keys.add(code); I.pressedKeys.add(code); } else I.keys.delete(code); },
      button: (i, down) => { if (down) { I.buttons |= 1 << i; I.pressedButtons |= 1 << i; } else I.buttons &= ~(1 << i); },
      move: (dx, dy) => { I.mouseDX += dx; I.mouseDY += dy; },
      pre: () => { I.locked = true; I.lastDevice = 'kbm'; },
      // 向き：yaw = 0 が北（-Z）。コンパスの方位 θ（時計回り）は yaw = -θ
      view: () => ({ yaw: P.yaw, pitch: P.pitch }),
      turnBy: (dyaw, dpitch) => {
        const s = 0.0022 * I.sensitivity * (P.aim ? 1 / P.zoom : 1);
        I.mouseDX += -dyaw / s; I.mouseDY += -dpitch / s;
      },
      yawOfHeading: (h) => (-h * Math.PI) / 180,
      headingOfYaw: (y) => (((-y * R2D) % 360) + 360) % 360,
      yawSign: -1,
      dirOfPixel: (px, py) => {
        const v = new D.THREE.Vector3((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1, 0.5).unproject(D.camera).sub(D.camera.position).normalize();
        return { yaw: Math.atan2(-v.x, -v.z), pitch: Math.asin(Math.max(-1, Math.min(1, v.y))) };
      },
      actions: {
        start: () => { if (G.screens.bootGo) G.screens.bootGo(); },
      },
      // カメラ（右ボタン）は aim:true のステップの間だけ構える
      tick: (dt, s) => { if (s.aim) I.buttons |= 4; if (s.shoot && !s.__shot) { s.__shot = 1; I.pressedButtons |= 1; } if (s.zoom && !s.__z) { s.__z = 1; I.wheel += -s.zoom; } },
      endStep: (s) => { if (!s.keepAim) I.buttons &= ~4; },
      status: () => {
        const bearing = (x, z) => ({ bearing: Math.round(((Math.atan2(x - P.pos.x, -(z - P.pos.z)) * R2D) + 360) % 360), dist: Math.round(Math.hypot(x - P.pos.x, z - P.pos.z)) });
        const near = G.fragments.nearest;
        return {
          state: G.state, pos: [P.pos.x, P.pos.y, P.pos.z].map((v) => +v.toFixed(1)), depth: +Math.max(0, -P.pos.y).toFixed(1),
          air: Math.round((G.air / 200) * 100) + '%', area: G.area ? G.area.name : null,
          fragmentHint: G.state === 'play' && near && near.dist < 38 ? bearing(near.item.pos.x, near.item.pos.z) : null,
          radarBig: (G._dots || []).filter((d) => d.big).map((d) => bearing(d.x, d.z)),
          boat: bearing(D.world.boat.ladderWorld.x, D.world.boat.ladderWorld.z),
        };
      },
      events: () => {
        const out = [];
        if (G.state !== lastState) { out.push({ kind: 'state', to: G.state }); lastState = G.state; }
        const d = D.Save.data;
        if (d) {
          if (d.fragments.length > lastFrag) { out.push({ kind: 'fragment', n: d.fragments.length }); lastFrag = d.fragments.length; }
          const n = Object.keys(d.species).length;
          if (n > lastSpecies) { out.push({ kind: 'species', n }); lastSpecies = n; }
        }
        return out;
      },
    };
  },
};
