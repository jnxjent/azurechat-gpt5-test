# Skill本人別Salesforce検索と候補表示（2026-10-26）

ローカル実装。本番・TestSiteのデプロイや設定変更は行っていない。

## 動作

- Web: 入力内容と本人の有効な保存済みSkillの名前・説明を照合し、入力欄の上に最大3件の候補を表示する。Tabで先頭、クリックで任意の候補を選択。Shift+Tabは通常のフォーカス移動、Escapeは現在の入力に対する候補を閉じる。日本語変換中は選択しない。
- 選択すると `Skill「保存名」を使って、元の依頼` に変わる。候補表示や選択だけでは検索・送信を実行しない。入力内容を候補検索APIやLLMへ送らない。
- Teams: 標準のチャット入力欄の入力途中やTabキーはBOTが制御できない。依頼の送信後に候補カードを表示し、選択すると実行する。明示的なSkill指定なら直接実行。個人チャットでSDK認証と名簿による本人確認を行い、Webと同じ所有者のSkillだけを参照する。
- Teamsの取引先選択・集計期間の指定はカードから続行する。カードは本人・会話・BOT・Skill版・有効期限に署名で結び付け、取引先IDを送信時に検証する。Skillの更新・無効化後は再依頼を求める。

## Salesforce Step2

- Skill専用の `personal_route_not_enabled` ガードを置き換え、本人用Gatewayへ署名付きで送る。共有Gatewayや共有キーへのフォールバックはしない。通常の件数問い合わせは本人用NL読み取り経路を使う。
- SFGの `/api/skills/salesforce/search` を本人認証ミドルウェアの対象に追加。固定した読み取りクエリだけを実行し、共有セッションを参照しない。
- 応答の接続方式・principal・SFユーザー/組織を検証し、保存する回答・内部継続データにすべての参照元の検証証跡を付ける。証跡が1つでも欠ける場合は厳格モードで保存済み回答を非表示にする。
- 候補選択時は現在の本人権限でAccountを再取得する。古い候補の基本情報をそのままモデルへ渡さない。会社が1件ならそのAccount IDで商談・活動・売上の取得へ続行する。
- COUNT/SUM集計は現行の厳格なレコード証跡では再検証できないため、その集計を含む保存済み回答は再読込後に非表示になる。これは現在の厳格ポリシーを維持した制限。Teamsへ送ったメッセージ自体の表示はTeamsが管理する。

## 有効化・デプロイ時

1. 必ず `docs/testsite-deploy-memo.md` を読み、最新TestSiteを基点に今回の変更だけを取り込む。古い作業ツリーでファイルを丸ごと上書きしない。Word翻訳・会議機能などを保持する。
2. ACと本人用SFGの両方の変更が必要。共有SFGや本番には出さない。
3. 本人用SFGのみ `SF_PERSONAL_SKILL_READ_ENABLED=true` が必要（既定OFF）。従来の `SF_SKILL_READ_ENABLED` / 共有キーとは別。ACは既存の `SKILL_SEARCH_ENABLED=true` とStep2本人接続の設定・本人登録を使う。ローカル実装では環境設定を変更していない。
4. WebでAOK訪問の依頼を入力し、候補→Tab→送信を確認。本人権限で取引先・商談・活動が取得できることを確認。
5. 検証用BOTの個人チャットで同じ依頼を送り、候補カード→実行→取引先選択の流れを確認。Teamsの認証省略環境では本人データを取得しない。

## 検証コマンド

ACの `src` で:

```powershell
node scripts/test-skill-suggestions.cjs
node scripts/test-skill-personal.cjs
node scripts/test-skill-search.cjs
node scripts/test-skills.cjs
node scripts/test-skill-chat-authoring.cjs
node scripts/test-teams-canvas.cjs
node scripts/test-teams-usage-counting.cjs
npx tsc --noEmit --pretty false
```

本人用SFGの作業ツリーで:

```powershell
python -m unittest tests.test_skill_read_personal tests.test_skill_read_routes tests.test_sf_personal
```

実データ・ブラウザー・Teamsクライアントによる受入確認は未実施。認証・検索結果・Teams送信は自動テストで代替している。

上記ACテスト7本と型チェックは成功。本人用SFGの3スイート・42テストも成功。
