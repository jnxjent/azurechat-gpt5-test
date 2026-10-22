export type SalesforceAccount = { id: string; name: string; billing_city?: string | null };
export type SalesforceAccountChoice = { account: SalesforceAccount; originalRequest: string };
const accountId = /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
export const ACCOUNT_SELECTION_TITLE = "Salesforceの取引先を選択してください。";
const cell = (value: unknown) => String(value ?? "未確認").replace(/[\r\n]/g, " ").replace(/[\\`*_[\]<>|]/g, "\\$&");

export function isSalesforceAccountChoiceReply(message: string, recent: Array<{role:string;content:unknown}>): boolean {
  const lastAssistant=recent.find(item=>item.role==="assistant");
  return typeof lastAssistant?.content==="string" && lastAssistant.content.startsWith(ACCOUNT_SELECTION_TITLE) &&
    /^(?:(?:それでは|では|じゃあ)[、,\s]*)?(?:\d{1,2}(?:番|番目)?(?:で|を)?(?:お願いします|選択します|にしてください|です)?[。.!！]?|001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)$/.test(message.normalize("NFKC").trim());
}

/** Presentation only. Server-side account authorization uses persisted tool state. */
export function salesforcePresentationRequest(message: string, recent: Array<{role:string;content:unknown}>): string {
  if (!isSalesforceAccountChoiceReply(message, recent)) return message;
  const selection = recent.findIndex(item => item.role === "assistant");
  const original = recent.slice(selection + 1).find(item => item.role === "user");
  return typeof original?.content === "string" ? original.content : message;
}

export function validAccountCandidates(value: unknown): SalesforceAccount[] {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item && accountId.test(item.id) && typeof item.name === "string" && item.name.length <= 255).slice(0, 50);
}

export function accountSelectionText(candidates: SalesforceAccount[], truncated: boolean): string {
  return [ACCOUNT_SELECTION_TITLE, "同名・支店違いの取引先を自動で混ぜず、選択したAccount IDだけを検索します。",
    "| 番号 | 取引先名 | 所在地（市区町村） | Account ID |", "| --- | --- | --- | --- |",
    ...candidates.map((item, index) => `| ${index + 1} | ${cell(item.name)} | ${cell(item.billing_city)} | ${item.id} |`),
    truncated ? "候補は一部です。表示した候補の番号・IDを指定するか、会社名に支店名・部署名を加えて再検索してください。" : "対象の番号（例：1番で）または上記Account IDを指定してください。",
    "選択後、元の依頼の期間・集計条件で検索します。"].join("\n\n").replace(/\|\n\n\|/g, "|\n|");
}

/** Only server-persisted tool state from the current user's owned thread is accepted. */
export function resolveSalesforceAccountChoice(message: string, recent: Array<{ role: string; content: unknown }>, now = Date.now()): SalesforceAccountChoice | undefined {
  const input = message.normalize("NFKC").trim().replace(/^(?:それでは|では|じゃあ)[、,\s]*/, "");
  const number = input.match(/^(\d{1,2})(?:番|番目)?(?:で|を)?(?:お願いします|選択します|にしてください|です)?[。.!！]?$/)?.[1];
  if (!number && !accountId.test(input)) return;
  // recent is newest first. An intervening conversation invalidates the choice.
  const assistantIndex = recent.findIndex(item => item.role === "assistant");
  if (assistantIndex < 0 || recent.slice(0, assistantIndex).some(item => item.role === "user")) return;
  const assistant = recent[assistantIndex];
  if (typeof assistant.content !== "string" || !assistant.content.startsWith(ACCOUNT_SELECTION_TITLE)) return;
  const stateMessage = recent.slice(assistantIndex + 1).find(item => item.role === "tool");
  if (typeof stateMessage?.content !== "string") return;
  try {
    const state = JSON.parse(stateMessage.content);
    const age = now - Date.parse(state.observedAt);
    if (state.integration !== "sf_account_selection" || !Number.isFinite(age) || age < 0 || age > 600_000 || typeof state.originalRequest !== "string" || state.originalRequest.length > 10000) return;
    const candidates = validAccountCandidates(state.candidates);
    const account = number ? candidates[Number(number) - 1] : candidates.find(item => item.id === input);
    if (account) return { account, originalRequest: state.originalRequest };
  } catch { /* Other tool results cannot resume a selection. */ }
}

/** Decimal strings keep cents and large totals exact before chart conversion. */
export function formatSalesforceAmount(value: string, thousands = false): string {
  const match=value.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if(!match)return "未取得";
  const digits=match[2]+(match[3]??""),scale=(match[3]?.length??0)+(thousands?3:0);
  const padded=digits.padStart(scale+1,"0"),whole=(scale?padded.slice(0,-scale):padded).replace(/^0+(?=\d)/,"");
  const fraction=scale?padded.slice(-scale).replace(/0+$/,""):"";
  return `${match[1]}${whole.replace(/\B(?=(\d{3})+(?!\d))/g,",")}${fraction?"."+fraction:""}`;
}

function sumDecimalValues(values: string[]): string {
  const scale=Math.max(0,...values.map(value=>value.split(".")[1]?.length??0));
  const total=values.reduce((sum,value)=>{
    const [whole,fraction=""]=value.split(".");
    return sum+BigInt(whole+fraction.padEnd(scale,"0"));
  },BigInt(0));
  const negative=total<BigInt(0),digits=(negative?-total:total).toString().padStart(scale+1,"0");
  return `${negative?"-":""}${scale?digits.slice(0,-scale)+"."+digits.slice(-scale):digits}`;
}

export function salesforceMonthlyReport(body: any, canvasRequested = false): string | undefined {
  const analysis = body.analysis, plan = body.request_plan;
  if (!analysis || !plan?.aggregation || plan.aggregation.interval !== "month" || !Array.isArray(analysis.items)) return;
  if (!analysis.items.length) return typeof body.zero_reason_message === "string" ? body.zero_reason_message : "指定条件の商談は0件でした。未取得の月を0では補完していません。";
  const operation = { SUM: "合計", AVG: "平均", COUNT: "件数" }[plan.aggregation.func as "SUM" | "AVG" | "COUNT"];
  if (!operation) return;
  const count = plan.aggregation.func === "COUNT";
  const amounts=analysis.items.map((row:any)=>String(row.value));
  const complete=analysis.complete&&analysis.items.every((row:any)=>row.value!==null&&/^-?\d+(?:\.\d+)?$/.test(String(row.value)));
  const total=!count&&plan.aggregation.func==="SUM"&&complete?sumDecimalValues(amounts):undefined;
  // Apply the requested yen display policy; choose one scale for the whole report.
  const thousands=!count&&[...amounts,...(total===undefined?[]:[total])].some(value=>/^-?\d+(?:\.\d+)?$/.test(value)&&Math.abs(Number(value))>=1_000_000_000);
  const unit=count?"件":thousands?"千円":"円";
  return [canvasRequested ? "<!-- salesforce:monthly-report -->" : "", `# ${cell(plan.resolved_account_name ?? plan.account_name ?? "商談")}の月別${count ? "商談件数" : "商談金額" + operation}`,
    `単位：${unit}`, `対象期間：${cell(plan.dateRange?.start)}〜${cell(plan.dateRange?.end)}`,
    `出典：Salesforce${plan.account_id ? `（Account ID：${plan.account_id}）` : ""}`,
    analysis.complete ? "取得した対象商談から集計しました。商談のない月は補完していません。" : "取得結果が不完全なため、確定した月別金額・件数は表示していません。",
    ...(total===undefined?[]:[`対象期間の商談合計金額：${formatSalesforceAmount(total,thousands)} ${unit}`]),
    `| 月 | ${count ? "商談件数" : "商談金額" + operation}（${unit}） | 対象レコード数 |`, "| --- | --- | --- |",
    ...analysis.items.map((row: any) => `| ${cell(row.period)} | ${analysis.complete && row.value !== null ? formatSalesforceAmount(String(row.value),thousands) : "未取得"} | ${cell(row.record_count)} |`),
    "", "元データ（取得明細の表示範囲）：",
    ...(Array.isArray(body.items) ? body.items : []).slice(0, 20).map((item: any) => {
      const url = typeof item.lightning_url === "string" && /^https:\/\/[A-Za-z0-9.-]+\/lightning\/r\/Opportunity\/[A-Za-z0-9]+\/view$/.test(item.lightning_url) ? item.lightning_url : undefined;
      return `- ${cell(item.Name ?? item.name ?? "商談")}${url ? ` [開く](${url})` : ""}`;
    })].join("\n");
}
