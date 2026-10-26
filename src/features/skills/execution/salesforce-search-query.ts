// These safeguards apply only to Skill searches. The legacy Salesforce route is unchanged.
export function hasInvalidCompanyFilter(soql: unknown): boolean {
  return typeof soql === "string" && /\b(?:Name|Id|AccountId)\s*(?:=|LIKE)\s*'%?(?:None|undefined|null)%?'/i.test(soql);
}

export function withSalesforceRecordId(record: Record<string, unknown>, object: string): Record<string, unknown> {
  if (typeof record.Id === "string" && record.Id) return record;
  if (typeof record.lightning_url !== "string") return record;
  try {
    const url = new URL(record.lightning_url);
    if (url.protocol !== "https:" || !/(?:^|\.)(?:lightning\.force\.com|salesforce\.com)$/.test(url.hostname)) return record;
    const match = url.pathname.match(/^\/lightning\/r\/(Account|Opportunity|Contact)\/([A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)\/view\/?$/);
    return match && match[1] === object ? { ...record, Id: match[2] } : record;
  } catch { return record; }
}

export function sameSalesforceId(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return left === right || (/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(left) && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(right) && left.slice(0, 15) === right.slice(0, 15));
}

function companyKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)/g, "").toLowerCase();
}

export function matchesCompanyName(value: unknown, requested: string): boolean {
  return typeof value === "string" && companyKey(value).includes(companyKey(requested));
}

export function companyForLookup(message: string, supplied?: unknown): string | undefined {
  if (typeof supplied === "string" && supplied.trim().length <= 120) {
    const key = companyKey(supplied.trim());
    if (key.length >= 2 && companyKey(message).includes(key)) return supplied.trim();
  }
  const suffix = message.match(/([^\s、。「」『』"'()（）:：,!?？！]{2,80}(?:株式会社|有限会社|合同会社|㈱))/)?.[1];
  const prefix = message.match(/(?:株式会社|有限会社|合同会社)[^\s、。「」『』"'()（）:：,!?？！]{2,80}/)?.[0]
    ?.replace(/(?:について|(?:を|に|へ)(?:訪問|伺|調べ|検索|確認)|の(?:情報|商談|案件|活動|売上|概要|訪問))[\s\S]*$/, "");
  if (!suffix && !prefix) return undefined;
  const name = (suffix ?? prefix!).replace(/^(?:(?:取引先|顧客|訪問先|会社名)(?:の|は|が)|対象の)+/, "");
  return companyKey(name).length >= 2 ? name : undefined;
}

export function isCompanyLookup(query: string): boolean {
  return /Account|取引先|会社|企業/i.test(query) && !/商談|Opportunity|Contact|連絡先|取引先責任者|活動履歴|活動一覧|Task|Event|日報|売上|集計|件数|合計|私の|自分の|部下|所有|期間|以降|以前/i.test(query);
}

export function buildAccountCandidateQuery(company: string): string {
  const core = company.normalize("NFKC").replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)/g, "").trim();
  if (core.length < 2 || /[\n\r「」'";%]/.test(core)) throw new TypeError("会社名を確認してください。");
  return `取引先名に${core}を含む取引先を検索して`;
}
