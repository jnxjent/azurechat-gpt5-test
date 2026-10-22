# Step3 Canvas共有の初期実装（2026-10-22）

## 今回の範囲

固定URLの認証付きWeb表示、指定ユーザーだけの閲覧、所有者の共有設定/解除、同じURLで最新内容の再取得。初期導線は本人検索テスト画面から「現在の条件で共有用Canvasを作成」。未分類の旧Canvasを無条件に公開しない。

## 構成

- `CanvasDocument` を表示モデルとして再利用。SF取得/閲覧権限再確認は `canvas-source.ts` のprovider契約に分離。共有ACL・保存・版管理は `shared-canvas-service.ts` に分離し、個別質問を正規表現で特別扱いしない。
- 作成API `POST /api/canvas/shared`、取得/変更API `/api/canvas/shared/[id]`、Web表示 `/canvas/shared/[id]`。URLはUUIDで固定。所有者だけ内容更新/共有設定を変更可能。閲覧者は読み取りのみ。
- 新規の `SHARED_CANVAS` レコードを既存HistoryContainerの専用partition `CANVAS_SHARE` に保存。既存チャット・Canvasレコードの移行/変更なし。最新document/source・owner/readers・revision・sealを1レコードで原子的に更新。ETag条件付きreplaceで競合を拒否。署名は正規化JSON＋別ドメインHMAC。
- 初期feature allowlist `CANVAS_SHARE_USERS_JSON=[{principal,email},...]`。Microsoftの認証済みtenant/object IDとメールが両方一致する利用者だけ。共有先も同設定の同tenantユーザーに限定。重複設定は停止。通常SF_PERSONAL_MODEのOFF状態とは独立。
- 作成時はSFを本人接続で再取得し、Gatewayが署名したsnapshot proofがある結果だけ保存。出所不明・proofのない集計は422で停止。proof/debug/SOQL/内部instructionはブラウザーへ返さない。
- 初期状態は非共有（ownerのみ）。共有設定を明示保存してから他利用者が閲覧可能。URLを転送してもACLのない利用者へ本文・タイトルは返さず、SFにも問い合わせない。
- GETのたびに閲覧者の現在のSF sessionで元レコード/項目/関連先の参照権限を再確認。共有権限だけでSF権限を代替しない。許可結果のリクエスト横断cacheなし。Gatewayに専用 `/api/sf/revalidate_shared` を追加し、元proofの所有者登録/組織/世代/署名を検証後、閲覧者sessionで既存のproof v2 checksを実行。
- SF照会後に共有レコードを再読取し、途中での共有解除/変更も検知。権限失効時は本文を返さず、所有者は本文を見られなくても共有解除可能。
- 応答no-store。画面は30秒間隔・フォーカス復帰時に再確認。非表示タブの本文はクリアし、復帰時に再取得。競合する古い応答で本文を復活させない。既に閲覧/コピーされた情報の回収は対象外。
- 共有URLコピーは手動。Teamsへ自動送信していない。

## 更新と後続

- 今回は所有者が「SFから内容を更新」で同じ依頼を再検索し、同じ共有IDのdocument/sourceを更新する。閲覧画面の再読込時に最新版を表示する。
- 現段階の更新条件は保存された自然文。自動定期更新は未実装。後続で構造化された取得条件/期間を保存し、定期処理ではAIに再解釈させない方式へ拡張する。
- 旧Canvasの出典移行、既存編集画面からの任意Canvas共有、集計の全寄与レコード証跡、手書き注記/グラフ設定の編集、定期更新は後続。現段階では署名出典のあるSF一覧を起点にした共有を実確認する。

## 検証

- 新規共有service＋実APIテスト：未共有/第三者拒否、閲覧者本人署名、現在権限拒否、同URL最新版、共有解除中の競合、古い版更新拒否、署名改ざん、権限喪失した所有者による解除、未認証401、CSRF/no-store。
- Gateway：元所有者と別の閲覧者で元proofを検証、通常本人用proofの横流し拒否、元レコード参照不可・別組織・元所有者登録無効化の拒否。分離Test tree全264pytest成功。
- AC：共有/本人接続/本人検索/strict履歴/Canvas回帰とtscを実行。実ユーザー間での共有・解除はTest配置後に確認する。

本番・既存共有Gateway・旧履歴の設定は変更しない。

## 通常SFチャットのCanvasから共有（同日追加）

- 本人別検索は通常SFチャットに統合済み。共有のために本人検索テスト画面へ戻す導線は使わない。
- Canvasヘッダーの「共有」→名前・メールの検索→候補のチェック選択→「共有を保存」→固定URLのコピー。共有画面側の共有先編集も同じ検索部品を利用する。
- 候補は既存 `CANVAS_SHARE_USERS_JSON` のうち、同じtenant・SF利用許可のある本人以外。任意メールの入力で権限を増やさない。表示名は同設定の任意 `name` を使用し、未登録時はメール表示。社内ディレクトリ全体の検索APIは追加しない。
- `GET /api/canvas/shared/people` は認証後のみ候補を返し、principalは返さない。検索応答の競合はAbortControllerで処理する。最大20候補、選択は最大50名。
- `/api/canvas/shared/from-thread` はサーバーに保存された本人のCanvasだけを共有する。ブラウザーから本文やproofを受け取らず、所有チャット・保存版・Canvas署名・元回答署名と依存proofを検証する。共有前および閲覧時に現在のSF権限で全proofを確認する。
- 共有する本文・単位・期間・グラフ設定・商談リンクは保存済みCanvasを維持する。別のSF検索やモデルで作り直さない。出典の確認できない旧Canvasや未保存の変更はそのまま共有しない。
- 同じ本人・Canvasには固定の共有IDを使用する。保存後に再度「共有を保存」するか、共有画面の「保存済みCanvasを反映」で同じURLへ最新版を反映する。更新競合はrevisionとETagで拒否する。共有解除はSF権限喪失後も可能。
- 定期的なSF再取得・Canvas保存時の自動公開は今回の範囲外。元の初期実装のSF再検索式レポートは既存動作を維持する。
- ローカル検証：通常チャットの保存済みCanvasの内容・グラフ維持、全依存proof、候補のtenant/許可制限、第三者拒否、固定URL更新、解除、保存版競合、改ざん拒否、CSRF、未認証応答。実ユーザーによる画面操作はTestSite反映後に確認する。
