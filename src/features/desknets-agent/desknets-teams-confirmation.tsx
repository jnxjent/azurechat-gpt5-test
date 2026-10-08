"use client";
import { useEffect, useState } from "react";
import type { DeskNetsAgentRunResponse } from "./desknets-agent-types";
import { DeskNetsApprovalCard } from "./desknets-approval-card";
import { DeskNetsCredentialRegistration } from "./desknets-credential-registration";

export function DeskNetsTeamsConfirmation({runId, chatThreadId}: {runId: string; chatThreadId: string}) {
  const [run, setRun] = useState<DeskNetsAgentRunResponse | null>(null);
  const [message, setMessage] = useState("");

  const endpoint = `/api/desknets-agent/runs/${encodeURIComponent(runId)}?chatThreadId=${encodeURIComponent(chatThreadId)}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, {cache: "no-store", signal: controller.signal}).then(async response => {
      const body = await response.json();
      if (!response.ok || !body.result?.approvalRequest || ["failed", "cancelled"].includes(body.status)) throw new Error("この候補は表示できないか期限切れです。Teamsで候補を選び直してください。");
      setRun(body);
    }).catch(error => {if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "予定内容を取得できませんでした。");});
    return () => controller.abort();
  }, [endpoint]);
  return <div className="m-auto w-full max-w-2xl space-y-4 p-6">
    <h1 className="text-xl font-semibold">DeskNets 予定内容の最終確認</h1>
    <DeskNetsCredentialRegistration />
    {run && <>
      <DeskNetsApprovalCard toolResult={{runId, chatThreadId, approvalRequest: run.result?.approvalRequest}}
        onReturnToCandidates={() => setMessage("Teamsの個人チャットに戻り、「候補に戻して」と送ってください。")} />
      <p className="text-sm">予定の変更はTeamsの個人チャットから依頼できます。最終登録はDeskNets上の「追加」で行ってください。</p>
    </>}
    {!run && !message && <p>予定内容を確認しています…</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}
