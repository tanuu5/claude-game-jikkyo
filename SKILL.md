---
name: game-jikkyo
description: ブラウザで動くゲーム（Three.js・Canvas・WebGL の自作ゲームなど）を Claude 自身が 1 手ずつ実際にプレイし、その録画に VOICEVOX の声で実況を付けた「ゲーム実況動画」を作るワークフローと道具一式。仮想時計でゲームを止めながら遊ぶので考える時間が映像に出ず、ゲームの音（Web Audio）も同じ時計で書き出す。プレイ中はメモだけ残し、あとから台本を書いて声を乗せる別撮り方式で、早送り・リプレイ・パンチイン（拡大）・集中線・テロップ・効果音といった YouTuber 風の編集をする。「Claude にゲームをプレイさせて」「実況して」「ゲーム実況動画を作って」「AI に遊ばせてみたい」「VOICEVOX で実況」「プレイ動画に声を乗せて」「この自作ゲームを遊んでみて」といった依頼では、ユーザーが「スキル」と言わなくても必ず使うこと。VOICEVOX の起動、公開時のライセンス（VOICEVOX・キャラクター規約・YouTube）の確認も含む。ゲームの紹介 PV のように「遊ぶ」のではなく演出して撮る映像は対象外。
---

# game-jikkyo：Claude がゲームを遊んで実況する

ブラウザゲームを Claude が自分で遊び、実況付きの動画にする。2 本の試行（AQUA BLUE＝遊びながら実況、LAST COURIER＝別撮り＋編集）で固まった手順と道具。

仕組みの要点は 3 つ。

- **止めながら遊ぶ。** ゲームはヘッドレス Chrome（実 GPU）の中で仮想時計（`capture/vclock.js`）に止められている。Claude が 1 手（どちらへ何秒歩く、撮る、押す）を送ると、その間だけ 1/60 秒ずつ進めて全コマを録画する。考えている間は時間が進まないので、つないだ映像は普通に遊んでいるように見える。
- **ゲームの音も同じ時計で。** `capture/vaudio.js` が `AudioContext` を `OfflineAudioContext` に差し替え、1 コマごとにその時刻まで描いて止める。効果音・BGM・環境音がコマとぴったり合う（試験で誤差 2ms）。
- **別撮りで声を乗せる。** 遊びながら喋ると、セリフが映像より長くなって後ろへずれていく（AQUA BLUE で最大 7 秒）。プレイ中は「このコマでこう思った」をメモし、あとで編集台本を書いて声を当てる。台本の段階で重なりを検査できるので、ずれない。

必要なもの：Node.js 20+、Google Chrome、ffmpeg（libx264）、Python 3 + numpy + scipy + Pillow、VOICEVOX（アプリを入れておけば、画面を開かなくてもエンジンだけ起動して使う）。Chrome と VOICEVOX の場所は `capture/env.mjs` が OS ごとに探す（見つからなければ環境変数 `CHROME_PATH` / `VOICEVOX_ENGINE` で指定）。動作を確かめたのは macOS。

## 使ってよいゲーム

自作のゲームや、ローカルで動かせるゲームが対象。ゲームのコピーを手元で動かし、内部の状態を読んだり入力を書き込んだりする。オンラインのゲームや、他人のサービス上で動くゲームには使わない（利用規約違反やチート行為になりうる）。他人が作ったゲームの実況を公開するときは、その作品の実況・配信のガイドラインを確認する。

## 始め方

1. **フォルダ。** 作業用のフォルダを決める（ユーザーに聞く。なければ新しく作る）。1 つのフォルダで複数のゲームを扱える構成になっている。
2. **ひな形を展開する。**

```bash
cp -R ~/.claude/skills/game-jikkyo/assets/template/. <project>/
cd <project> && npm install
```

できる構成：

```
capture/   play-server.mjs（遊ぶ）、build.mjs + compose.py（編集・書き出し）、voice.mjs（VOICEVOX）、env.mjs（OS ごとの既定値）、vclock.js、vaudio.js、sheet.sh
adapters/  <game>.mjs（ゲームごとの差分。aqua-blue / last-courier が見本）
games/     <game>/（ゲームのコピー。元のリポジトリには触れない）
runs/      <game>/（録画 play.mp4、game_audio.wav、session.json、edit.json、out/）
```

3. **ゲームをコピーする。** `rsync -a --exclude .git <元のフォルダ>/ games/<game>/`。ビルドが要る作品は node_modules ごと（`--exclude dist` は node_modules 内の dist も消すので使わない）。

## 流れ

### 1. 調べる（読み取り専用のサブエージェント）

Explore エージェントに、ゲームの「撮影に必要な情報」を調べさせる（依頼文の型は `references/adapter.md`）。メインループと dt、壁時計を使う箇所、起動と「準備完了」の判定、入力の持ち方（直接書けるか）、カメラ、読める状態（位置・目的地・体力など）、音の作り、最初の数分で起きる見せ場。ここが良いと、次のアダプタがすぐ書ける。

### 2. アダプタを書く（`adapters/<game>.mjs`）

配信方法、ページより先に入れる設定（セーブ消去、画質固定、案内の表示）、準備完了の式、ページ側の `window.__adapter`（入力・向き・状態・出来事）を書く。詳細と見本は `references/adapter.md`。状態（`status`）は「画面に出ている情報」と同じ程度にとどめる。プレイヤーが知り得ない答え（隠しアイテムの座標など）を渡すと、遊んでいることにならない。

### 3. 遊ぶ（メモを残す）

```bash
node capture/play-server.mjs <game>          # バックグラウンドで起動
curl -s localhost:5190/act -d '{"memo":"…","steps":[{"hold":["KeyW"],"face":{"heading":300},"sec":6}]}'
# → runs/<game>/now.jpg（いまの画面）と status / events が返る。画面を見て次の手を決める
curl -s localhost:5190/quit                  # 録画をつなぎ、ゲームの音を書き出す
```

- 1 手ごとに `now.jpg` を見て判断する。細かい部分は ffmpeg で切り出して拡大して見る。
- **memo を必ず書く。** 何を見て、何を考えて、次に何をするか。驚き、迷い、失敗も。これが台本の材料になる。山場には `mark` も付ける。
- 実況映えするのは、迷う・失敗する・ぎりぎり助かる場面。安全策ばかりにせず、プレイヤーとして自然な判断（急ぎたいから走る、など）をする。ただし結果を作為しない（わざと転ぶ等）。
- 反射神経が要る操作（バランス取りなど）は、アダプタの補助（LAST COURIER の `grip:"auto"`）を使ってよい。使ったことは最後にユーザーへ伝える。
- 録画は 1 コマ約 50ms。4 分の素材で 15〜20 分ほど。1 本の目安は素材 3〜5 分 → 編集後 2〜3 分。

### 4. 台本を書く（`runs/<game>/edit.json`）

```bash
bash capture/sheet.sh runs/<game>/play.mp4 runs/<game>/sheet.jpg 4 8   # 4 秒ごとの一覧
python3 -c "import json;[print(m['frame'],m['text']) for m in json.load(open('runs/<game>/session.json'))['memos']]"
```

memo と一覧画像から、カット表（早送り・リプレイ）、セリフ、演出を書く。形と書き方は `references/editing.md`。

```bash
node capture/build.mjs <game> --check     # セリフの重なりと「あと何文字入るか」を表で出す
node capture/build.mjs <game> --preview   # 960x540 で通し（2.5 分の動画で約 1 分）
node capture/build.mjs <game>             # 本番 1080p60（約 3〜4 分）→ runs/<game>/out/<game>_jikkyo.mp4
```

- 声の速さは約 6.8 文字/秒（春日部つむぎ・話速 1.12）。--check が通るまで、言い回しを削るか時刻をずらす。
- プレビューから要所を静止画で抜き出し、1 枚にまとめて見る（テロップと HUD の重なり、ズームの中心、字幕の高さ）。

### 5. 確かめて渡す

- 音は耳で確認できないので数値で見る。全体のラウドネス（ebur128。書き出しで -16 LUFS にそろう）と、セリフのある区間とない区間の音量差。ゲーム音の素の音量が小さい作品は `game_audio.gain` を上げる（LAST COURIER は 2.2）。
- 「音は数値で確認しただけ」と正直に伝え、聞いてもらう。
- 補助を使った操作、ゲームのデータから得た情報（地図の位置など）があれば、それも伝える。

## 公開するとき

YouTube などに出すときは `references/licenses.md` を確認する。VOICEVOX は「VOICEVOX:キャラ名」のクレジットが必要（edit.json の `credits` で動画の最後に出る。概要欄にも書く）。ゲームの元の権利、キャラクター規約の禁止事項、YouTube の AI 開示もここにまとめてある。規約は変わることがあるので、公開の直前に原文を読み直す。

## 参考ファイル

- `references/adapter.md` — アダプタの書き方、`/act` の操作一覧、調査の依頼文の型
- `references/editing.md` — edit.json の形、YouTuber 風の演出の使いどころ、台本の書き方
- `references/licenses.md` — VOICEVOX・キャラクター規約・YouTube の開示・クレジットの例
- `references/pitfalls.md` — つまずいた点と対処
