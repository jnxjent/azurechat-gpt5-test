import type { SkillInput, UserSkill } from "./skill-rules";

export const SALES_ANALYSIS_PROFILES = [
  { key: "account", title: "取引先情報", question: "Salesforceで「J＆T環境㈱」の取引先情報を教えてください", sections: "基本情報、社内担当営業、取得範囲、不足項目" },
  { key: "progress", title: "営業進捗管理", question: "黄さんの営業進捗をまとめてください", sections: "進行中・成約・失注、活動、確認順、次の行動" },
  { key: "outcomes", title: "成約失注分析", question: "黄さんの2026年10月1日から2026年10月29日までの成約と失注を分析してください", sections: "成約・失注の件数、取得Amount値、失注理由、データ不足" },
  { key: "activity", title: "営業活動分析", question: "黄さんの今月の営業活動を分析してください", sections: "Task完了・未完了・未確認、Event、期限超過、活動の種類" },
  { key: "director", title: "AI営業部長", question: "黄さんの商談と活動をもとに課題と次の行動を提案してください", sections: "根拠のある課題、進捗、活動、確認すべき事項、行動提案" },
  { key: "office", title: "営業所管理", question: "対象担当者：黄。営業所管理の形式で商談と活動をまとめてください", sections: "指定担当者ごとの商談・活動、課題、行動提案、対象範囲" },
  { key: "weekly", title: "週ミーティング", question: "黄さんの今週の商談と活動から週ミーティングの議題を作成してください", sections: "指定週の商談と活動（予定と完了を区別）、課題、議題、次回までの行動、未取得情報" },
  { key: "monthly", title: "営業所月次分析", question: "対象担当者：黄。2026年10月の営業所月次分析を作成してください", sections: "指定月・指定担当者の商談・活動、成約失注、課題、翌月の確認事項" },
] as const;
export type SalesAnalysisKey = typeof SALES_ANALYSIS_PROFILES[number]["key"];
export function salesAnalysisProfile(skills: Pick<UserSkill, "title" | "content">[]) {
  if (skills.length !== 1) return;
  // Explicit opt-in: an existing custom Skill with the same title must keep its
  // own search instructions instead of silently switching to a fixed profile.
  return SALES_ANALYSIS_PROFILES.find(profile => skills[0].content.split(/\r?\n/).includes(`分析プロファイル: ${profile.key}`));
}
export function salesAnalysisTemplate(key: SalesAnalysisKey): SkillInput {
  const profile = SALES_ANALYSIS_PROFILES.find(item => item.key === key)!;
  return { title: profile.title, description: `本人権限のSalesforce情報を使って${profile.title}を行う`, enabled: true, shared: false,
    content: [`# ${profile.title}`, `分析プロファイル: ${key}`, "SalesforceのAccount・Opportunity・Activityを本人権限で読み取り、サーバーで確定した件数・順位・集計を使う。登録・更新はしない。",
      "対象は依頼に明示した会社・担当者に限る。複数担当者は『対象担当者：氏名、氏名』で指定する。営業所所属・部下範囲は推測しない。",
      "期間指定時の商談はCloseDate、活動はActivityDateを基準とし、開始日以上・終了日翌日未満。今週は日本時間の月曜～日曜。期間未指定で必要な分析は質問する。",
      "商談区分は現場確認待ちの暫定基準。Amountを売上・予算・原価に置換しない。通貨・税区分は未確認。取得上限・エラー・未実行・0件を区別。未取得データは推測しない。",
      `出力: ${profile.sections}。事実と提案を区別し、取得元リンクと適用条件を明示する。`, `代表質問: ${profile.question}`].join("\n\n") };
}
