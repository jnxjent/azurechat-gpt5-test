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
  const message =
    run.result?.assistantMessage?.trim() ||
    run.message?.trim() ||
    run.error?.trim() ||
    run.result?.summary?.trim() ||
    "DeskNet's Agentの処理が完了しました。";

  return {
    status: run.status,
    runId: run.id || run.runId,
    chatThreadId,
    message,
    ...(run.result?.approvalRequest === undefined
      ? {}
      : { approvalRequest: run.result.approvalRequest }),
    ...(run.result?.booking === undefined
      ? {}
      : { booking: run.result.booking }),
  };
}

export function createDeskNetsAgentTool(
  chatThreadId: string,
  userPrompt: string
): RunnableToolFunction<DeskNetsToolArguments> {
  return {
    type: "function",
    function: {
      name: "desknets_schedule_agent",
      description:
        "DeskNet'sの予定調整を行う。最新のユーザー発言を構造化すること。会議室変更ではpreferredを第一希望にする。「空いていなければ」「埋まっていれば」「予約済みなら」「だめなら」などの代替条件があれば、その場所をfallbackLocation、会議室・応接室の種別をfallbackType、どこでもよい場合をanyAvailable=trueにする。明示されていない値はnullまたは空配列にし、推測しない。最終登録は別の確認操作で行う。",
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
        const run = await runDeskNetsAgent(userPrompt, chatThreadId, args);
        // Do not expose or persist the full browser run, screenshots, participant
        // identifiers, or facility inventory in the normal chat transcript.
        return formatToolResult(run, chatThreadId);
      },
    },
  };
}
