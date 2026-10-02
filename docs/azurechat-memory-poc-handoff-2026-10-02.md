# AzureChat メモリー機能 PoC 作業メモ（2026-10-02）

## TestSite 反映準備（2026-10-02 追記）

- 利用者から TestSite 自動デプロイの指示あり。本番上書きは禁止。
- 対象は `jnxjent/azurechat-gpt5-test` の `testsite/fix-toggle-selfscope-20260323`、Azure WebApp は `azurechat-gpt5-test` のみ。
- TestSite 先端 `ac94d83fc6b9d5da053e7f0bef59bd9df68fcd8e` を起点に、専用作業ツリーへメモ機能の差分だけを抽出した。
- 最新のローカル実装にはメモ・スキルの区分、名前変更・削除、LearnedLesson の記録も含まれる。保存基盤は共通の `USER_MEMORY`。
- メモ機能のテスト（参照判定、自然言語コマンド、LearnedLesson、保存モック、チャット処理）が成功。既存 DeskNet's 回帰テスト 25 件も成功。
- `.env.local` を配置コミットへ含めない。配置は既存の TestSite 設定を使用する。
- 以下は初回実装時点の記録。実データでのログイン後の保存・参照、利用者分離の操作確認は引き続き必要。

## 現在の状態

- ローカルの実装まで完了。TestSite と本番サイトにはデプロイしていない。次は PC 再起動後のローカル操作検証。
- 既存の Cosmos DB `history` コンテナーに、ログイン利用者の `userId` で分離した `USER_MEMORY` 文書を保存する。追加 VM は不要。メモの保存・参照で Cosmos DB の RU、保存容量、LLM の入力トークンは増える。
- ワークツリーには他機能の変更が多数ある。メモリー機能以外の変更を巻き戻したり、一括コミット・一括デプロイしたりしない。

## 実装内容

- `/memories` 画面で、自分の Markdown メモを作成・一覧・編集・無効化・削除できる。参照条件は「毎回」「条件に合えば必須」「名前を指定した時だけ」。適用語は必須参照メモに設定する。
- チャットで「この内容を〇〇としてメモに残して」「メモ一覧を見せて」「あのデプロイの時のメモを見せて」などを処理する。直前の回答を保存する指示にも対応する。曖昧な名前で複数件見つかった場合は名前の指定を求める。
- 通常のチャットでは参照条件に合うメモを選び、ユーザー作成の参照情報としてモデルへ渡す。回答末尾に参照メモ名と版を表示する。TestSite と本番のデプロイメモを区別する判定を含む。
- 保存・編集・削除・一覧 API は `/api/memories`。未ログインのアクセスは 401。メモはユーザー単位で取得し、削除はソフト削除。

## 主な変更ファイル

- `src/features/memory/memory-rules.ts`: 参照条件の判定、名前からの呼び出し、プロンプト用の整形。
- `src/features/memory/memory-service.ts`: Cosmos DB への保存と入力検証。
- `src/features/memory/memory-chat.ts`, `memory-chat-handler.ts`: 自然言語コマンドとチャット応答。
- `src/features/memory/memory-page.tsx`, `src/app/(authenticated)/memories/page.tsx`: 管理画面。
- `src/app/(authenticated)/api/memories/route.ts`: API。
- `src/features/chat-page/chat-services/chat-api/chat-api.ts`, `open-ai-stream.ts`: チャットへの注入と参照メモ表示。
- `src/features/main-menu/main-menu.tsx`: メモ画面へのメニュー。
- `src/scripts/test-memory-poc.cjs`: 判定のローカルテスト。

## 済んだ確認

- `cd C:\Users\021213\azurechat-office-work\src` で `npx tsc --noEmit --pretty false` が成功。
- 同じ場所で `node scripts/test-memory-poc.cjs` が成功。毎回参照、TestSite と本番の振り分け、手動呼び出し、無効化、自然言語保存を確認。
- 開発サーバー上の `http://localhost:3000/memories` は HTTP 200。未ログインの `/api/memories` は HTTP 401。
- `npm run build` は稼働中の Next 開発サーバーと `.next` が競合し、`.next/trace` の EPERM で完了できなかった。試行後に開発サーバーが一時的に 500 となったため起動し直し、`/memories` の 200 を確認した。ビルドを再試行する場合は、開発サーバーを停止してから行う。

## PC 再起動後の再開手順

1. PowerShell で `cd C:\Users\021213\azurechat-office-work\src`、続けて `npm run dev`。既にポート 3000 が使用中なら稼働中のプロセスを確認する。
2. ログイン済みのブラウザーで `http://localhost:3000/memories` を開く。メモの作成・編集・無効化・削除を試し、自分のメモだけが見えることを確認する。
3. チャットで「この内容をデプロイ手順としてメモに残して。TestSiteへのデプロイ時は必ず参照して」を試す。保存した本文と適用語が画面で意図どおりか確認する。
4. 「TestSite デプロイのメモを見せて」「テスト環境へ反映して」を試す。TestSite メモが参照され、本番メモが混ざらず、回答末尾に参照したメモ名・版が出ることを確認する。
5. 本番向けメモも作って「あのデプロイの時のメモ」を試す。複数候補なら名前の指定を求めることを確認する。実際のデプロイ操作は依頼しない。
6. 動作確認後、必要なら開発サーバーを止めて `npm run build` を実行する。TestSite・本番へのデプロイは、別途明示の指示があるまで行わない。

## 残る確認・制約

- ログインした状態での Cosmos DB 保存・取得を使った一連の操作は未検証。上記のブラウザー操作が次の主な確認事項。
- PoC の参照はタイトル・適用語と限られた言い換えの判定。意味検索や自動要約は実装していない。
- メモ本文は最大 12,000 文字、チャットへ渡す件数は最大 6 件。長いメモや「毎回」参照を増やすと応答費用が増える。
