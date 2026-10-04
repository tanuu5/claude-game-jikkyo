# アダプタの書き方と /act の操作

## 調査の依頼文（Explore エージェントへ）

> Read-only research on the browser game at <path>. I will run a copy in headless Chrome under a virtual clock (performance.now / Date.now / rAF / setTimeout advanced 1/60 s per step), have an agent play it by injecting inputs, record every frame, and capture its Web Audio through an OfflineAudioContext. Report < 1500 words with file:line refs:
> 1. How to run locally (static? build? CDN imports? URL params / debug hooks on window)
> 2. Main loop: rAF, dt and its clamp, fixed step, pauses on blur/visibility
> 3. Wall-clock use: setTimeout/setInterval, Date.now, AudioContext.currentTime in logic, CSS animations
> 4. Boot flow and the "ready" signal; how to start a New Game from fresh localStorage; save/settings keys
> 5. Input: where keys/mouse/look are stored (to set directly), pointer-lock needs
> 6. Readable state for an agent (position, heading, objective + its position, health/air/battery, hazards) and exact paths
> 7. Audio architecture (plain AudioContext nodes? HTMLAudioElement? files?)
> 8. The first 3–5 minutes of play and 5–8 highlight moments + how they happen
> 9. Rendering: pixel ratio, auto quality / dynamic resolution to disable
> 10. Other headless / virtual-clock pitfalls

## アダプタの形

```js
export default {
  name: 'GAME',
  serve: { type: 'static', dir: 'games/<game>' },      // vite の開発サーバーなら { type: 'vite', dir, port }
  path: '/index.html',
  audio: true,                                         // Web Audio を書き出す（audioSeconds で上限秒、既定 900）
  init: () => { localStorage.clear(); /* 設定 */ },    // ページのスクリプトより先に実行
  ready: 'window.game && game.state === "title"',     // これが真になったら時計を止める
  setup: () => { window.__adapter = { /* 下の API */ }; },
};
```

`setup` はページ側で実行される（時計を止めた直後）。`window.__adapter` に置けるもの（どれも省略可）：

| 名前 | 役目 | 省略したとき |
| --- | --- | --- |
| `key(code, down)` | キーを押す／離す | DOM の keydown/keyup を送る |
| `button(i, down)` | マウスボタン | canvas に mousedown/mouseup |
| `move(dx, dy)` | マウス移動 | movementX/Y 付きの mousemove |
| `canvas()` | 入力先の要素 | 最初の canvas |
| `pre(dt)` | 毎コマ、時計を進める前（ロック状態の上書きなど） | — |
| `view()` / `turnBy(dyaw, dpitch)` | 向きの読み書き（ラジアン） | `face`/`turn`/`lookAt` が使えない |
| `yawOfHeading(deg)` / `headingOfYaw(yaw)` | コンパス方位（北 0、時計回り）との変換 | — |
| `yawSign` | `turn.yaw` の正を右回りにする符号 | — |
| `dirOfPixel(x, y)` | 画面の点（1920x1080）に向く yaw/pitch | `lookAt` が使えない |
| `actions` | `{ 名前(args, step) }` ゲーム専用の操作（ボタンを押す、依頼を受ける） | — |
| `tick(dt, step, t)` / `endStep(step)` | ステップ中の毎コマ処理（補助操作、構え）／後始末 | — |
| `status()` | 状態（JSON にできる小さなオブジェクト） | 画面の文字だけ |
| `events()` | 前回から起きた出来事の配列（`{kind, …}`） | — |
| `uiSelector` | 画面の文字を拾う範囲 | `body *` |

方針：

- **入力はゲームの内部状態を直接書くのがいちばん確実**（ポインタロックはヘッドレスで使えない）。1 回押しで処理が走る作りなら、DOM の keydown を送る既定のままにする。
- 向きは「コンパス方位」で扱うと、地図やレーダーと話が合う。`yaw = -heading` の作品が多い（-Z が北の three.js）。
- `status` は画面に出ている情報の範囲にする。目的地の方位と距離はコンパスやマーカーで見えるなら渡してよい。隠れたものの座標は渡さない。
- `events` は編集の目印になる（転倒、納品、雨の始まり、モードの切り替え）。前回値との差で出す。

## 起動オプション

`node capture/play-server.mjs <game> [--port 5190] [--run <name>] [--restore <storage.json>]`

- `--run`：録画の置き場所 `runs/<name>`。続き物や撮り直しを分ける（既定は `<game>`）。
- `--restore`：前回 /quit で保存された localStorage（ゲームのセーブ）を、アダプタの `init` のあとで戻してから始める。

## /act の本文

| キー | 意味 |
| --- | --- |
| `memo` | いま思ったこと（このコマに記録。台本の材料） |
| `mark` | 出来事の名前（自分で付ける目印） |
| `say` | その場で VOICEVOX でしゃべる（ライブ実況の試し用） |
| `snap` | 終わりの画面を `runs/<game>/snaps/<名前>.jpg` にも残す |
| `steps` | 操作の列（下） |

ステップ：`sec`（進める秒数）、`hold:[codes]`、`press: code`、`buttons:[0,2]`、`click: 0`、`look:{dx,dy}`、`face:{heading,pitch}`、`turn:{yaw,pitch}`、`lookAt:[x,y]`、`turnSec`、`do:"action", args`、`eval:"式"`、そのほかアダプタが `tick` で読む独自キー（例 `grip:"auto"`、`aim:true`）。

返り値：`frames`、`status`（`t` は録画の秒）、`events`、`errors`。画面は `runs/<game>/now.jpg`（半分の大きさ）。

## 見本

- `assets/template/adapters/aqua-blue.mjs` — vite の開発サーバーで `window.__dbg` を使う。入力状態を直接書く。カメラの構え・撮影を `tick` で。
- `assets/template/adapters/last-courier.mjs` — 静的配信、クラシックスクリプトのトップレベル変数を名前で読む。バランスの反射補助 `grip:"auto"`、ボタンは `actions.click(セレクタ)`。
