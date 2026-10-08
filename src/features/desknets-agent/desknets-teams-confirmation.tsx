"use client";
import { useEffect, useState } from "react";
import type { DeskNetsAgentRunResponse } from "./desknets-agent-types";
import { validatedDeskNetsHandoffUrl } from "./desknets-handoff-url";
import { DeskNetsCredentialRegistration } from "./desknets-credential-registration";

export function DeskNetsTeamsConfirmation({runId, chatThreadId}: {runId: string; chatThreadId: string}) {
  const [run, setRun] = useState<DeskNetsAgentRunResponse | null>(null);
  const [message, setMessage] = useState("");
  const [opening, setOpening] = useState(false);
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
  async function open() {
    const tab = window.open("about:blank", "_blank");
    if (!tab) { setMessage("ポップアップを許可して、もう一度押してください。"); return; }
    tab.opener = null; setOpening(true); setMessage("");
    try {
      const response = await fetch(`${endpoint}&handoff=1`, {cache: "no-store"});
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "この候補は期限切れです。Teamsで候補を選び直してください。");
      tab.location.replace(validatedDeskNetsHandoffUrl(body.handoffUrl));
      setMessage("DeskNetsの予定追加画面を開きました。議題などの内容を確認し、DeskNets上の「追加」を押してください。まだ予定は登録していません。");
    } catch (error) { tab.close(); setMessage(error instanceof Error ? error.message : "引き渡しに失敗しました。"); }
    finally { setOpening(false); }
  }
  return <div className="m-auto w-full max-w-2xl space-y-4 p-6">
    <h1 className="text-xl font-semibold">DeskNets 予定内容の最終確認</h1>
    <DeskNetsCredentialRegistration />
    {run && <><p className="whitespace-pre-wrap">{run.result?.assistantMessage || run.result?.summary || run.message}</p>
      <p>この操作では予定を登録しません。DeskNetsにログインし、予定追加画面で議題・日時・参加者・会議室・通知設定を確認してから「追加」を押してください。</p>
      <button className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50" disabled={opening} onClick={() => void open()}>{opening ? "開いています…" : "DeskNetsの予定追加画面を開く"}</button></>}
    {!run && !message && <p>予定内容を確認しています…</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}
