import "server-only";

import { RunnableToolFunction } from "openai/lib/RunnableFunction";
import { isDeskNetsAgentEnabled, runDeskNetsAgent } from "./desknets-agent-client";
import type { DeskNetsAgentRunResponse } from "./desknets-agent-types";
import {
  DESKNETS_STRUCTURED_COMMAND_SCHEMA,
  parseDeskNetsStructuredCommand,
  type DeskNetsStructuredCommand,
} from "./desknets-structured-command";

type DeskNetsToolArguments = DeskNetsStructuredCommand;

function formatToolResult(run: DeskNetsAgentRunResponse, chatThreadId: string) {
  if (run.webMeetingAdded) {
    return {
      integration: "desknets_schedule_agent",
      status: "completed",
      message: "WEB会議の希望を追加しました。先ほどのオレンジのカードにTeams会議の作成ボタンが表示されます。",
    };
  }
  const message =
    run.result?.assistantMessage?.trim() ||
    run.message?.trim() ||
    run.error?.trim() ||
    run.result?.summary?.trim() ||
    "DeskNet's Agentの処理が完了しました。";

  return {
    integration: "desknets_schedule_agent",
    status: run.status,
    runId: run.id || run.runId,
    chatThreadId,
    message,
    ...((run.result?.approvalRequest ?? run.result?.manualActionRequest) === undefined
      ? {}
      : { approvalRequest: run.result?.approvalRequest ?? run.result?.manualActionRequest }),
    ...(run.result?.booking === undefined
      ? {}
      : { booking: run.result.booking }),
  };
}

export function createDeskNetsAgentTool(
  chatThreadId: string,
  userPrompt: string,
  history: unknown[] = [],
): RunnableToolFunction<DeskNetsToolArguments> {
  return {
    type: "function",
    function: {
      name: "desknets_schedule_agent",
      description:
        "最短の依頼では、ツールが返した開始時刻順の最大5候補を表示し、先頭の＜最短＞を必ず残す。自動で候補1を選択せず、ユーザーが後の日時を選ぶこともできるようにする。" +
        "候補を回答するときはツール出力の番号と日時の対応をそのまま表示する。候補番号を省略・付け替えしない。『では、1で』は表示済みの候補1の選択であり、日付の1日や所要時間1分ではない。" +
        "『では上記1で。WEB会議も設定して』は候補1の選択とWEB会議希望。action=select_candidate、candidateNumber=1、facility.preferred=null。WEB会議・Teams会議・オンライン会議は会議室名ではない。会議室を別途指定された場合だけfacility.preferredにその実在会議室を入れる。WEB希望だけではTeams会議を発行しない。" +
        "『アクトの別会議室で』『では同じ場所の他の部屋で』は直前の会議日時・参加者を維持した会議室変更。action=change_facility、facility.preferred=場所名（例:アクト）、anyAvailable=true、fallbackType=meeting_room。『別』は直前の部屋を除く意味。場所が発言や履歴で明らかなら聞き直さない。" +
        "同一スレッドの予定調整を継続する。日時・参加者・会議時間は履歴でユーザーが指定済みの値を引き継ぎ、最新の変更だけ上書きする。『16時開始で』には保存済み会議時間を使用し、時間を聞き直さない。開始日時の次に『60分』と答えた場合はselect_timeで既出の日付・開始時刻とdurationMinutes=60を渡す。会議室省略時はAPIが個人・部署の優先順位で選択するので指定を要求しない。メールと本人通知は既定ON。候補の選択・変更は必ずこのツールを実行し、OutlookやTeamsで手動登録するよう誘導しない。カードはapprovalRequestから表示され、カードのボタンは入力済みのDeskNet's予定追加画面を表示する。最終登録はユーザーがDeskNet's上の「追加」を手動で押す。" +
"DeskNet'sの予定調整を行う。スレッド内で指定済みの条件に最新のユーザー発言を反映して構造化すること。会議室変更ではpreferredを第一希望にする。「有玉のどこかの会議室」「有玉で空いている会議室」のような場所内の任意指定は、preferredに場所名だけ（例: 有玉）、fallbackTypeにmeeting_room、anyAvailable=trueを設定し、文章全体を設備名にしない。「空いていなければ」「埋まっていれば」「予約済みなら」「だめなら」など、第一希望とは別の代替条件がある場合だけ、その場所をfallbackLocationへ設定する。応接室ならfallbackType=reception_room、設備種別を問わなければanyを使う。スレッド内でも明示されていない値はnullまたは空配列にし、推測しない。最終登録は別の確認操作で行う。",
      parameters: DESKNETS_STRUCTURED_COMMAND_SCHEMA,
      parse: parseDeskNetsStructuredCommand,
      function: async (args: DeskNetsToolArguments) => {
        if (!isDeskNetsAgentEnabled()) {
          return {
            status: "disabled",
            message: "DeskNet's Agent is not enabled in this environment.",
          };
        }

        // Preserve the exact message as a deterministic fallback. The Agent API
        // validates the model-generated command before using any structured field.
        let remainingCharacters = 40000;
        const conversationHistory = history.slice().reverse().flatMap((entry) => {
          const message = entry as { role?: string; content?: unknown };
          if (remainingCharacters <= 0 || (message?.role !== "user" && message?.role !== "assistant") || typeof message.content !== "string") return [];
          const content = message.content.slice(0, Math.min(12000, remainingCharacters));
          remainingCharacters -= content.length;
          return [{ role: message.role as "user" | "assistant", content }];
        }).slice(0, 100).reverse();
        const run = await runDeskNetsAgent(userPrompt, chatThreadId, args, conversationHistory);
        // Do not expose or persist the full browser run, screenshots, participant
        // identifiers, or facility inventory in the normal chat transcript.
        return formatToolResult(run, chatThreadId);
      },
    },
  };
}
