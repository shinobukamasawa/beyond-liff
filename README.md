# LIFF の画面（web/）

生徒が LINE のリッチメニューから開く画面。静的ファイルだけで、データは GAS の doPost と往復する（docs/screen-line.md）。

| ファイル | 内容 |
|---|---|
| index.html | 入れ物。LIFF SDK と app.js を読む |
| app.js | 全画面（初回登録、先生選択、カレンダー、提案、確認、一覧、残り回数、お問い合わせ） |
| style.css | 見た目（スマホ幅） |
| config.js | LIFF ID と GAS の Web アプリ URL（公開されてよい値だけ） |
| logic/ | 提案ロジックの **写し**（正本は gas/logic/）。直さないこと。`npm run sync:logic` で作り直す。ずれていると配置が止まる |

## 置き場と URL

- 開発中：蒲澤の GitHub の公開リポジトリ `beyond-liff` に、このフォルダの中身をそのまま置き、GitHub Pages（main ブランチ／root）で公開する
  - URL：`https://shinobukamasawa.github.io/beyond-liff/`
- LINE Developers の LIFF アプリの「エンドポイント URL」にこの URL を設定する
- 納品時：beyond.english.system で GitHub アカウントを作ってリポジトリを移管し、エンドポイント URL を新しい URL に差し替える

## 画面の入口（リッチメニューの1項目。2026-09-24 にん決定）

| 項目 | URL |
|---|---|
| レッスンの予約・確認 | `https://liff.line.me/2011635422-YUCoskrr`（`p` なし＝ホーム） |

- ホーム＝残り回数＋これからの予約＋「レッスンを予約する」「予約の確認・振替」。お問い合わせ・お子さんの切り替え・もう1人登録・ホームへ は右上の「☰ メニュー」
- 古いリンク用に `?p=book`（先生選択から）・`?p=list`・`?p=count`（＝ホーム）・`?p=contact` も動く

## 開発中の確認（LINE を通さない）

GAS のスクリプトプロパティ `DEV_KEY` が設定されているときだけ、URL に `?dev=<DEV_KEY>&sub=<仮のユーザーID>` を付けると LINE ログインなしで開ける。

```
python -m http.server 8765 --directory web
http://localhost:8765/?p=book&dev=xxxx&sub=Udev-taro
```

`DEV_KEY` は納品前に削除する。

## 通信の約束

- `fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON })`。text/plain にするのは CORS の事前確認を避けるため
- 書き込み系（register / confirm / cancel）には `reqId` を付ける。通信に失敗して再試行しても、GAS 側が同じ reqId には1回目の結果を返す（二重予約の防止）
- GAS の Web アプリ URL を変えたら config.js の `apiUrl` を差し替える（新しいデプロイを作ると URL が変わる。既存デプロイの更新なら変わらない）

## 更新を確実に効かせる

ブラウザ（LINE のアプリ内ブラウザを含む）は app.js などを使い回す。app.js・style.css・config.js を変えたら、index.html の `?v=` の値を変えてから配置する（例：`app.js?v=20260919b`）。index.html 自体は GitHub Pages が最長10分キャッシュする。
