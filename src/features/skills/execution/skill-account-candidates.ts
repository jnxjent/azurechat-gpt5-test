import type { SkillSearchResult } from "./skill-search-policy";

const safeText = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>|]/g, "\\$&");

// Selection is application UI, not generated prose. Keep every displayed number tied to its actual ID.
export function formatAccountCandidates(result: SkillSearchResult, reference: string): string {
  if (result.status !== "needs_confirmation" || !Array.isArray(result.data) || !result.data.length) throw new Error("Account candidates missing");
  const rows = result.data.map((row, index) => {
    const item = row as Record<string, unknown>;
    const url = new URL(String(item.lightning_url));
    if (url.protocol !== "https:" || !/\.(?:lightning\.force\.com|salesforce\.com)$/.test(url.hostname) || url.pathname !== `/lightning/r/Account/${item.Id}/view` || !/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(String(item.Id))) throw new Error("Invalid Account candidate link");
    const address = [item.BillingPostalCode ? `〒${item.BillingPostalCode} ` : "", item.BillingCountry, item.BillingState, item.BillingCity, item.BillingStreet].filter(Boolean).join("");
    return `| ${index + 1} | [${safeText(item.Name)}](${url.href}) | ${safeText(address || "[未設定]")} | ${safeText(item.OwnerName || "[未設定]")} | ${item.Id} |`;
  });
  return "対象のSalesforce取引先が複数あります。取引先・請求先住所・社内担当営業を確認し、対象を1つ選択してください。\n\n"
    + "| 番号 | 取引先 | 請求先住所 | 社内担当営業 | Account ID |\n|---:|---|---|---|---|\n"
    + rows.join("\n")
    + `\n\n候補${rows.length}件を表示しています。${result.truncated ? "取得・表示上限により候補の一部です。対象がなければ会社名・拠点名を絞って再検索してください。" : ""}`
    + "\n番号は今回の一覧内だけで有効です。以前の一覧と同じ番号でも同じ取引先とは限りません。番号またはAccount IDで指定してください。"
    + "\n請求先住所はSalesforceのBilling住所、社内担当営業はAccount所有者です。同名・同住所でも二重登録とは断定できません。"
    + "\n選択後、元のSkillの依頼を続行します。\n\n" + reference;
}
