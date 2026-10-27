import type { UserSkill } from "../skill-rules";

export type { FiscalPeriod } from "@/lib/fiscal-period";
export { resolveFiscalPeriod as readFiscalPeriod } from "@/lib/fiscal-period";
import { resolveFiscalPeriod, hasFiscalPeriodExpression } from "@/lib/fiscal-period";

function defaultFiscalTerm(content: string): string {
  // A Skill may request the previous fiscal year without making the user repeat it.
  // Examples or dates in imported text never redefine the company's calendar.
  return /前会計年度|前年度|去年度|昨年度/.test(content) ? "前年度" : "";
}

export function skillSearchRequirements(skills: UserSkill[], message: string) {
  const content = skills.map(skill => skill.content).join("\n");
  const combined = content + "\n" + message;
  const excludes = (name: string) => new RegExp(`(?:${name})[^。\\n]{0,24}(?:省略|不要|使わ|使用しない|検索しない|除外)`, "i").test(message);
  const salesforce = /Salesforce|セールスフォース/i.test(combined) && !excludes("Salesforce|セールスフォース") && !/(?:Web|ウェブ|社内資料)(?:検索)?(?:だけ|のみ)/i.test(message);
  return {
    operations: salesforce ? ["accounts", ...(/Opportunity|商談/i.test(combined) ? ["opportunities"] : []), ...(/Activity|Task|Event|活動履歴/i.test(combined) ? ["activities"] : []), ...(/Sales__c|Billing__c|売上|受注合計/i.test(combined) && !excludes("売上|受注") ? ["sales"] : [])] : [],
    web: /Web|web_search|ニュース|公開情報/i.test(combined) && !excludes("Web|ニュース"),
    slack: /Slack|slack_search/i.test(content),
    canvas: /Canvas/i.test(content),
    fiscalPeriod: resolveFiscalPeriod(message) ?? (!hasFiscalPeriodExpression(message) ? resolveFiscalPeriod(defaultFiscalTerm(content)) : undefined),
    queryBudget: /1[〜～~~\-–]?2回のクエリ/.test(content.normalize("NFKC")) ? 2 : undefined,
  };
}

export const SKILL_RESULT_PRESENTATION = [
  "Skill固有の必須項目・件数・並び順を優先し、その範囲で読みやすく整形する。Canvas指定はチャット内の文書形式に置き換え、末尾に一度だけ説明する。",
  "候補選択・追加質問だけの回答を除き、冒頭に根拠のある要点を3〜5行。会社概要は簡潔に、商談・売上明細は表（HTML指定ならHTML表、それ以外はMarkdown表）、活動とニュースは短い箇条書き、話題候補は3〜5件とする。HTML指定ではレポート全体をHTMLにする。",
  "取得範囲・未取得理由・未対応機能は末尾の一箇所へ集約し、同じ説明を繰り返さない。Opportunityは商談、Accountは取引先、truncatedは取得上限に達したため一部取得と表記する。顧客担当者と社内担当営業を区別する。",
  "最新10件の活動は取得できた10件を表示する。本文の長さにより抜粋するなら、取得N件中M件を掲載と明記する。ActivityDate順の取得を最終更新日順と混同しない。",
  "会社の会計年度は4月1日〜翌年3月31日。今期・前期・上期・下期・四半期はサーバーの解釈済み期間を使用し、再計算しない。fiscalStart以上fiscalEndExclusive未満が集計範囲であり、回答は終了日の前日までを年月日で明記する。年度・半期・四半期の集計をすべて前年度合計と呼ばず、実際の指定期間に合わせて表示する。今期は年度全体を意味し、今日までの累計を意味しない。",
  "売上のisBillingAccount=falseが確認できた場合は売上状況を省略。検索失敗・未実行・権限不足は請求先でないことを意味しない。fiscalPeriodRequired=trueなら会計年度の開始日・終了日を質問し、年度合計を推測しない。recentPeriod=LAST_N_MONTHS:3は直前の完了した3暦月であり、年度合計や全期間の売上ではない。fiscalRecordCount=0は[データなし]。SUMがnullで対象件数がある場合は金額未設定として扱い0円としない。",
  "事実から先の状態を断定しない。承認回付の開始から契約締結済みを推測しない。提案は確認事項として書く。出典リンクは取得したものだけを使う。",
].join("\n");
