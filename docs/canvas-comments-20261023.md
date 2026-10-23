# Canvas共有・コメント（2026-10-23）

## 実装範囲

- 正式タイトルをMarkdown構文木から取得し、レポート先頭に表示する。共有管理は折りたたむ。本文、数値、グラフ、リンクは再生成しない。
- 共有先ごとに「閲覧可／コメント可」。既存共有は既定で閲覧のみ。本文編集・所有権移譲・Teams通知は含まない。
- 全体コメント、返信、本人の編集・削除。投稿時のレポート版を保存し、Canvas更新・再共有でも保持する。削除は本文を空にした墓標を残し、返信を失わない。
- レポートと同じMicrosoft本人認証、共有ACL、現在のSF参照権限を全操作で検証。コメントも署名対象。revision/ETag競合、解除中の書き込み、他人の編集、閲覧のみの投稿、CSRFを拒否。
- SF接続・部署ディレクトリ喪失時も、認証済み所有者には本文・コメントを出さず解除だけを許可する。
- コメント上限はレポートごと200件、1件4000 UTF-8バイト、保存レコードは1.5MBまで。本文はプレーンテキストとして表示し、HTMLを実行しない。

## Salesforceが正となる候補ディレクトリ

- Gateway追加：署名付き本人セッション専用 `GET /api/sf/share_people`。
- `SF_CANVAS_SHARE_PERMISSION_SET_NAME` に指定した権限セットの有効な登録ユーザーを取得し、既存の `SF_PERSONAL_BINDINGS_JSON` の有効なMicrosoft対応付けと同組織・同tenantで照合する。
- 氏名はSF User.Name、部署はUser.Department。未登録は「部署未登録」。ロール名やMicrosoftの部署で補完しない。
- AzureChatもSF利用許可リストで絞り込む。共有候補に載っても、閲覧には本人のSF接続と対象データの現在の権限確認が必要。
- 取得失敗時に古い名簿や共有接続へフォールバックしない。SF側でPermissionSetAssignment/Userの取得権限がない利用者では候補取得エラーになるため、TestSiteで実ユーザー確認が必要。
- 有効化設定：AzureChat TestSite `CANVAS_SHARE_DIRECTORY_PROVIDER=salesforce`、本人Gateway Test `SF_CANVAS_SHARE_PERMISSION_SET_NAME=AzureChat_Step2_Test_Access`（API名は実環境で照合する）。未設定なら従来2名の静的ディレクトリを維持。
- 調査時点のTest登録件数：AzureChat本人対象8、Gateway本人対応付け8、従来Canvas共有対象2。設定値・秘密鍵・トークンはメモに保存しない。

## 検証

- Gateway全277テスト成功（SFディレクトリ・本人認証・OAuthを含む）。
- AzureChat型チェック、既存Canvas/共有/保存テスト、新規タイトル構文解析・HTMLエスケープ・ディレクトリ境界テスト成功。
- 共有テストは返信、本人編集・削除、閲覧のみ拒否、降格、所有者のSF権限喪失、コメント署名改ざん、共有解除との競合、CSRF、未認証、更新後の会話保持を含む。
- 実ユーザーでのSF権限セット取得、部署表示、2名間コメントの受入試験は配置後に行う。
- 本番のpush・デプロイ・設定変更は禁止。今回の実装をそのまま本番へ出さない。

## Current delivery status

Implementation synchronized to the main AzureChat and SF Gateway workspaces. No commit, push, deployment, or online setting changes in this task. Typecheck and six Canvas suites passed; all 277 Gateway tests passed. Local full Next build was interrupted after prolonged compilation; require a completed CI build before TestSite deployment. Real-user SF directory/department and two-person comments acceptance remains pending.
