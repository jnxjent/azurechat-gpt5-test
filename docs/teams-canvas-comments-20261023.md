# Teams AzureChatBOT：共有Canvasコメント（2026-10-23）

## 利用方法と範囲

1. Webで共有済みのCanvasのURLを、AzureChatBOTとの個人チャットへ送る。
2. 閲覧権限を確認した後、操作カードを表示する。「レポート・共有設定を開く」で、同じURLのWeb画面を開ける。
3. コメント可の利用者には、コメント本文と返信先を選ぶ入力欄を表示する。投稿・返信はWebと同じ保存先に入る。
4. 返信先は削除されていない親コメントの最新20件を日時で選択する。古い会話や本文の閲覧、共有先・権限の変更、コメントの編集・削除はWeb画面を併用する。

今回の範囲は既存の共有レポートへの操作。Teamsの本人SF検索や新規Canvas生成を自動で有効化する変更ではない。相手への自動DM通知、グループ・チャネルへのレポート配信は含まない。実際のTeams送信や利用者データへの書き込みを開発ツールから行っていない。

## 本人・権限・データの扱い

- 入口は既存のTeams SDK認証済み `message` および `card.action` ハンドラー。認証省略環境では操作を許可しない。
- 個人チャット、設定tenant、activity tenant、会話メンバーAPIのAAD object ID・メールを確認し、既存 `SF_PERSONAL_USERS_JSON` の本人対応付けと照合する。カード内のメール・principalは本人確認に使用しない。
- server-onlyのCanvas専用AsyncLocalStorageで確認済み本人を渡す。Webは従来どおり認証済みCookieを使う。一般認証ヘルパーを変更せず、リクエスト間で本人を共有しない。
- 読み取り・投稿はWebと同じCanvasサービスを使用する。SF権限セットの候補ディレクトリ、共有ACL、コメント可権限、現在のSF参照権限を通す。
- カードの操作データはHMACで本人・会話・レポート・版・30分期限に結び付ける。他人への転送、改ざん、期限切れを拒否する。秘密鍵は既存SF署名キーを用途別の署名文字列で使い、カードに含めない。
- 二重送信・古いカードはレポートrevision/ETag競合で二重投稿を防ぐ。コメント保存後の状態取得失敗は「保存済み」と明示し、保存失敗と混同しない。
- Teams履歴に権限解除後も残る本文・レポート名・コメント本文のコピーを作らない。閲覧は都度SF権限を確認するWeb画面へ誘導する。カードには操作案内と返信先の日時を表示する。
- 通常チャットのLLM・検索・自動メモリへ、コメント内容を流さない。利用統計は会話・activity IDだけを記録し、記録失敗で投稿済み処理を失敗扱いにしない。

## SDK形式と検証

- Adaptive Card 1.4 / Action.Submitを生成し、既存の会話message経路で処理する。SDKのcard.action形式にも同じ処理で対応する。
- Microsoft公式の[会話内Action.Submitの応答形式](https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/how-to/action-commands/respond-to-task-module-submit)と[カードアクション](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-actions)を参照。SDKのインストール済み型でも確認。
- `test-teams-canvas.cjs`：実際のCanvasサービス＋署名＋Cosmos模擬保存で、SDK両入口、投稿・返信、Cookieなし本人確認、同時リクエスト分離、改ざん・期限・別人転送、別tenant・group拒否、閲覧のみ・SF拒否・共有解除、重複投稿防止を検証。
- 既存Teams DeskNets、Teams SF/画像、Canvas共有・保存済み共有・候補ディレクトリのテストも成功。
- 全体ビルドは前段のCanvas実装時に長時間化で中断。この段階では再実行していない。反映前にCIビルドと、実際のTeamsクライアントからの受入確認が必要。

## 配置状態

- 実装・テストまで。commit/push、TestSite・Gateway・本番へのデプロイ、オンライン設定変更、BOTの接続先変更は行っていない。
- 設定は前段Canvas共有と同じ。TestSiteと本人GatewayのSF権限セット連携設定、Teams側の本人登録8名を照合してから、Test用BOTで確認する。本番のBOT・Webサイトは変更禁止。
- 配置用分離worktree：`C:/Users/021213/ac-personal-oauth-pick-20261022`。通常の作業ツリーには他の未完了変更があるため、一括配置しない。
