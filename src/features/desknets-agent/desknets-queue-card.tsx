"use client";

import { useEffect, useRef, useState } from "react";
import { DeskNetsApprovalCard } from "./desknets-approval-card";
import type { DeskNetsAgentRunResponse } from "./desknets-agent-types";

type InitialResult = { integration?: unknown; runId?: unknown; chatThreadId?: unknown; status?: unknown };

export function DeskNetsQueueCard({ toolResult }: { toolResult: InitialResult | null }) {
  const runId = typeof toolResult?.runId === "string" ? toolResult.runId : "";
  const threadId = typeof toolResult?.chatThreadId === "string" ? toolResult.chatThreadId : "";
  const enabled = toolResult?.integration === "desknets_schedule_agent" &&
    ["queued", "running"].includes(String(toolResult.status)) &&
    /^[A-Za-z0-9_-]+$/.test(runId) && /^[A-Za-z0-9_-]+$/.test(threadId);
  const [run, setRun] = useState<DeskNetsAgentRunResponse | null>(null);
  const [startedAfterWait, setStartedAfterWait] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    cancelledRef.current = false;
    let active = true;
    let waitingObserved = toolResult?.status === "queued";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (cancelledRef.current) return;
      try {
        const response = await fetch(
          `/api/desknets-agent/runs/${encodeURIComponent(runId)}?chatThreadId=${encodeURIComponent(threadId)}`,
          { cache: "no-store" },
        );
        const body = await response.json() as DeskNetsAgentRunResponse;
        if (!active || cancelledRef.current) return;
        if (!response.ok) throw new Error(body.message ?? "処理状態を取得できませんでした。");
        if (body.status === "queued") waitingObserved = true;
        if (body.status === "running" && waitingObserved) setStartedAfterWait(true);
        setRun(body);
        if (["queued", "running"].includes(body.status)) timer = setTimeout(refresh, 1500);
      } catch (error) {
        if (!active || cancelledRef.current) return;
        setRun({ status: "failed", message: error instanceof Error ? error.message : "処理状態を取得できませんでした。" });
      }
    };
    void refresh();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [enabled, runId, threadId, toolResult?.status]);

  if (!enabled) return null;
  const status = run?.status ?? toolResult?.status;
  const position = typeof run?.queue?.waitingPosition === "number" ? run.queue.waitingPosition : undefined;
  const waiting = status === "queued";
  const running = status === "running";
  const message = status === "cancelled" ? "DeskNet's の待機を取り消しました。"
    : waiting
    ? `DeskNet's の処理待ちです${position === undefined ? "" : `。待ち順 ${position} 番目` }。空き次第、自動で開始します。`
    : running
      ? startedAfterWait ? "順番が来ました。DeskNet's の処理を開始しました。" : "DeskNet's を処理中です。"
      : run?.result?.assistantMessage ?? run?.message ?? run?.error ?? run?.result?.summary ?? "処理が終了しました。";
  const approval = run?.result?.approvalRequest ?? run?.result?.manualActionRequest;

  return (
    <div className="rounded-md border border-orange-300 bg-orange-50 p-3 text-sm text-slate-900" role="status" aria-live="polite">
      <p className="whitespace-pre-wrap">{message}</p>
      {waiting && <button type="button" disabled={cancelling} className="mt-2 rounded border px-2 py-1 disabled:opacity-50"
        onClick={async () => {
          setCancelling(true);
          setCancelError("");
          try {
            const response = await fetch(`/api/desknets-agent/runs/${encodeURIComponent(runId)}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chatThreadId: threadId, action: "cancel" }),
              cache: "no-store",
            });
            const body = await response.json() as DeskNetsAgentRunResponse;
            if (!response.ok || body.status !== "cancelled") throw new Error(body.message ?? "待機を取り消せませんでした。");
            cancelledRef.current = true;
            setRun(body);
          } catch (error) {
            setCancelError(error instanceof Error ? error.message : "待機を取り消せませんでした。");
          } finally {
            setCancelling(false);
          }
        }}>{cancelling ? "取消中…" : "待機を取り消す"}</button>}
      {cancelError && <p role="alert" className="mt-2">{cancelError}</p>}
      {approval && <DeskNetsApprovalCard toolResult={{ runId, chatThreadId: threadId, approvalRequest: approval }} />}
    </div>
  );
}
