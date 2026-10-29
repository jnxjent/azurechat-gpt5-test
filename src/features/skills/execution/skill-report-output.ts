import type { ChatCompletionStreamingRunner } from "openai/resources/beta/chat/completions";

const reports = new WeakMap<object, { reason?: string; reference: string }>();
export const SKILL_OUTPUT_LIMIT_NOTE = "※出力上限に達したため、レポートの一部を省略しました。未掲載の情報を0件とは扱っていません。";
export const SKILL_CONTENT_FILTER_NOTE = "※生成内容の制限により、回答の一部を表示できませんでした。";
export function skillReportReasoningOptions() {
  const effort=process.env.SKILL_REPORT_REASONING_EFFORT?.trim();
  if(!effort)return {};
  if(!["low","medium","high"].includes(effort))throw Error("Invalid SKILL_REPORT_REASONING_EFFORT");
  return {reasoning_effort:effort as "low"|"medium"|"high"};
}
export const SKILL_REPORT_OUTPUT_RULES = [
  "activitySummaryは容量制限前の取得明細内でコードが計算した活動内訳。completedTasks/openTasksはTask.IsClosedの真偽値だけで判定し、未確認はunverifiedTasks、Eventはeventsに分離する。overdueOpenTasksは期限を過ぎた未完了Taskだけ。完了済みTaskとEventを未完了・期限超過件数に加えない。complete=falseなら全体の未完了件数と呼ばない。",
  "progressRankはサーバーが確定した取得範囲内の確認順位。結論・一覧・次の行動で同じ番号を使い、AIが振り直さない。progressSummaryの段階別件数は容量制限前にコードで計算した取得明細内の値。complete=trueの場合だけ対象検索の全件として扱える。omittedFieldsの項目はAI入力から省略済みなので未取得と混同せず、その内容を推測しない。",
  "進捗の並び順では日付未入力の確認を最優先する。lastActivityMissing/closeDateMissingがtrueなら『入力漏れの可能性』に掲載し、活動していない・期限超過とは断定しない。以降は返却順を守る。未入力に架空の経過日数を付けない。",
  "営業進捗では冒頭に取得範囲内の最優先3件と理由・次の行動を示す。progressEvidenceがある商談は返却順（予定日超過の有無、超過日数、活動経過日数、金額の順）を維持し、結論・一覧・フォローアップで順位を一致させる。これは取得範囲内の確認順であり、全商談の順位ではない。日数はprogressEvidenceの値を使い、予定日当日は超過と呼ばない。停滞の業務基準は未確定なので日数から停滞と断定しない。ToDoはTaskとEventを区別し、Taskの状態が未確認なら未完了と断定しない。未取得の原価回答・見積について作文しない。",
  "fetchedCountはGatewayから取得した明細数、modelVisibleCountは容量制限後にAIが確認できる明細数。両者が違うときは『取得後、AIへ渡す際に一部省略』と説明し、Salesforceから取得できなかったと書かない。成約・失注の別検索があればその結果を使用し、全段階明細だけで判定しない。期間未指定の成約・失注結果は全期間と明示し、期間がないことだけを理由に取得済み案件を未取得と書かない。参照元は実際のリンクを掲載し、存在しないリンクを表内に記載したと説明しない。",
  "レポート全体を完結させる。先に要点・取得範囲・未取得項目を示し、取引先別の商談明細は全体で最大20行、活動は最大10件、成約・失注例は各5件まで。Skillにより少ない件数指定があればそれに従う。より多い指定があっても掲載上限と省略件数を明示し完全掲載と説明しない。",
  "SF上の総件数、AIへ渡された明細数、回答の掲載件数を区別する。truncatedの明細から全体の段階別件数や集計を計算しない。優先度順と説明できるのは、取得できた明細内で比較した場合だけ。",
  "成約・失注・担当者・期間などの検索条件は、各検索結果のappliedFiltersに実際にある値だけを転記する。取得したIsClosed/IsWonなどの属性から検索条件を逆算・補完しない。appliedFiltersがなければ検索条件は未確認と明記する。複数検索の条件を混ぜない。",
  "『最近』の既定期間とテスト・ダミーの除外条件を勝手に設定しない。全期間の件数を最近の件数と呼ばない。表示上限に収まるよう重複説明と長い表を減らし、成約・失注、活動、フォローアップ、データ不足と参照表示を最後まで含める。",
].join("\n");

export function trackSkillReport(runner: ChatCompletionStreamingRunner, reference: string, channel: string) {
  const state = { reference, reason: undefined as string | undefined };
  reports.set(runner, state);
  // SDK emits finalChatCompletion before finalContent; Web persistence and Teams
  // therefore use the same completion status without making a second model call.
  runner.on("finalChatCompletion", completion => {
    state.reason = completion.choices[0]?.finish_reason;
    console.info("[skill-report] completed", { channel, finishReason: state.reason ?? null,
      completionTokens: completion.usage?.completion_tokens ?? null,
      reasoningTokens: completion.usage?.completion_tokens_details?.reasoning_tokens ?? null });
  });
}
export function finalizeSkillReport(runner: object, content: string, completion?: {choices:{finish_reason?:string|null}[]}): string {
  const state = reports.get(runner);
  if (!state) return content;
  let text = content.trimEnd();
  const reason=completion ? completion.choices[0]?.finish_reason : state.reason;
  if (reason === "length" && !text.includes(SKILL_OUTPUT_LIMIT_NOTE)) text += "\n\n" + SKILL_OUTPUT_LIMIT_NOTE;
  if (reason === "content_filter" && !text.includes(SKILL_CONTENT_FILTER_NOTE)) text += "\n\n" + SKILL_CONTENT_FILTER_NOTE;
  if (!text.includes(state.reference)) text += "\n\n" + state.reference;
  return text;
}
