"use client";

import { chatStore } from "@/features/chat-page/chat-store";
import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { DeskNetsApprovalRequest } from "./desknets-agent-types";

type DeskNetsApprovalToolResult = {
  runId: string;
  chatThreadId: string;
  approvalRequest: DeskNetsApprovalRequest;
};

const isApprovalRequest = (value: unknown): value is DeskNetsApprovalRequest => {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.title === "string" &&
    typeof item.start === "string" &&
    typeof item.end === "string" &&
    Array.isArray(item.participantIds) &&
    item.participantIds.every((id) => typeof id === "string") &&
    typeof item.facilityId === "string" &&
    typeof item.emailNotificationWillBeSent === "boolean";
};

const parseApprovalToolResult = (
  value: Record<string, unknown> | null,
): DeskNetsApprovalToolResult | null => {
  if (
    typeof value?.runId !== "string" ||
    typeof value.chatThreadId !== "string" ||
    !isApprovalRequest(value.approvalRequest)
  ) {
    return null;
  }
  return {
    runId: value.runId,
    chatThreadId: value.chatThreadId,
    approvalRequest: value.approvalRequest,
  };
};

const isManualConfirmationReady = (run: unknown): run is {
  status: "awaiting_user_input";
  result: { assistantMessage?: string; manualActionRequest: unknown };
} => {
  if (typeof run !== "object" || run === null) return false;
  const candidate = run as Record<string, unknown>;
  if (candidate.status !== "awaiting_user_input") return false;
  if (typeof candidate.result !== "object" || candidate.result === null) return false;
  return (candidate.result as Record<string, unknown>).manualActionRequest !== undefined;
};

const MANUAL_CONFIRMATION_MESSAGE =
  "DeskNet'sの予定追加画面を表示しました。内容を確認し、DeskNet's上の「追加」を手動で押してください。";

export const DeskNetsApprovalCard = ({
  toolResult,
}: {
  toolResult: Record<string, unknown> | null;
}) => {
  const parsed = parseApprovalToolResult(toolResult);
  if (!parsed) return null;

  return <ApprovalCard {...parsed} />;
};

const ApprovalCard = ({
  runId,
  chatThreadId,
  approvalRequest: approval,
}: DeskNetsApprovalToolResult) => {
  const [state, setState] = useState<
    "idle" | "submitting" | "ready" | "completed" | "failed"
  >("idle");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState(approval.title || "打ち合わせ");
  const [localMessage, setLocalMessage] = useState("");
  const [openingLocal, setOpeningLocal] = useState(false);
  const openOnThisPC = async () => {
    // Open synchronously on the user gesture; never navigate a shared VM tab.
    const tab = window.open("about:blank", "_blank");
    if (!tab) { setLocalMessage("ポップアップを許可して、もう一度押してください。"); return; }
    tab.opener = null;
    setOpeningLocal(true);
    try {
      const response = await fetch(`/api/desknets-agent/runs/${encodeURIComponent(runId)}?chatThreadId=${encodeURIComponent(chatThreadId)}&handoff=1`, {cache:"no-store"});
      const result = await response.json();
      if (!response.ok || typeof result.handoffUrl !== "string") throw new Error(result.message ?? "引き渡しできませんでした。");
      const url = new URL(result.handoffUrl);
      if (url.origin !== "https://desknets.midac.jp" || url.pathname !== "/dneo/dneo.cgi" ||
          url.username || url.password || url.search !== "?cmd=schindex" || new URLSearchParams(url.hash.slice(1)).get("cmd") !== "schaddtarget") throw new Error("不正な引き渡し先です。");
      if (tab.closed) throw new Error("表示先タブが閉じられました。もう一度押してください。");
      tab.location.replace(url.href);
      setLocalMessage("このPCでDeskNet'sを開きました（登録は未完了）。日時・参加者を確認し、議題・内容・会議室・通知を設定して、最後に「追加」を押してください。ログイン画面が出た場合はログイン後にこのボタンを再度押してください。");
    } catch (error) {
      tab.close();
      setLocalMessage(error instanceof Error ? error.message : "引き渡しに失敗しました。");
    } finally {setOpeningLocal(false);}
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const response = await fetch(
          `/api/desknets-agent/runs/${encodeURIComponent(runId)}?chatThreadId=${encodeURIComponent(chatThreadId)}`,
          { cache: "no-store" },
        );
        const run = await response.json();
        if (cancelled) return;
        if (isManualConfirmationReady(run)) {
          setState("ready");
          setMessage(run.result.assistantMessage ?? MANUAL_CONFIRMATION_MESSAGE);
        } else if (run.status === "completed") {
          setState("completed");
          setMessage(
            run.result?.assistantMessage ??
              "DeskNet'sへの予定登録が完了しました。",
          );
        } else if (run.status === "queued" || run.status === "running") {
          setState("submitting");
          timer = setTimeout(refresh, 1000);
        } else if (run.status === "failed" || run.status === "cancelled") {
          setState("failed");
          setMessage(run.message ?? run.error ?? "予定登録に失敗しました。");
        }
      } catch {
        // The initial refresh is best-effort. Approval reports actionable errors.
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [chatThreadId, runId]);

  const approve = async () => {
    if (state !== "idle" && state !== "failed" && state !== "ready") return;
    setState("submitting");
    setMessage("");
    try {
      const response = await fetch(
        `/api/desknets-agent/runs/${encodeURIComponent(runId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chatThreadId, title: title.trim() }),
        },
      );
      const run = await response.json();
      if (response.ok && isManualConfirmationReady(run)) {
        setState("ready");
        setMessage(run.result.assistantMessage ?? MANUAL_CONFIRMATION_MESSAGE);
        return;
      }
      if (response.ok && run.status === "completed") {
        setState("completed");
        setMessage(
          run.result?.assistantMessage ??
            "DeskNet'sへの予定登録が完了しました。",
        );
        return;
      }
      setState("failed");
      setMessage(run.message ?? run.error ?? "予定登録に失敗しました。");
    } catch (error) {
      setState("failed");
      setMessage(`予定登録に失敗しました: ${String(error)}`);
    }
  };

  const dateTime = (value: string) =>
    new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));

  return (
    <div className="space-y-3 rounded-lg border-2 border-amber-500/70 bg-amber-500/10 p-4">
      <div className="font-semibold">DeskNet&apos;s 予定内容の最終確認</div>
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">議題</dt>
        <dd>
          <input
            type="text"
            value={title}
            maxLength={100}
            disabled={state === "submitting" || state === "completed"}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded-md border bg-background px-2 py-1"
          />
        </dd>
        <dt className="text-muted-foreground">日時</dt>
        <dd>{dateTime(approval.start)} ～ {dateTime(approval.end)}</dd>
        <dt className="text-muted-foreground">参加者</dt>
        <dd>{approval.participantIds.join("、")}</dd>
        <dt className="text-muted-foreground">会議室</dt>
        <dd>{approval.facilityId}</dd>
        <dt className="text-muted-foreground">メール</dt>
        <dd>{approval.emailNotificationWillBeSent ? "送信する" : "送信しない"}</dd>
      </dl>
      {state === "completed" ? (
        <div className="flex items-center gap-2 text-sm font-medium text-emerald-600">
          <CheckCircle2 size={18} />
          {message}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void openOnThisPC()} disabled={openingLocal || state === "submitting"}
            className="rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {openingLocal ? "引き渡し先を確認中…" : "このPCのDeskNet'sで確認（日時・参加者）"}
          </button>
          <button type="button" onClick={() => void navigator.clipboard.writeText(title).then(()=>setLocalMessage("議題をコピーしました。DeskNet'sの予定欄へ貼り付けてください。"),()=>setLocalMessage("コピーできませんでした。議題を選択してコピーしてください。"))}
            className="rounded-md border px-3 py-2 text-sm">議題をコピー</button>
          <button
            type="button"
            onClick={() => void approve()}
            disabled={state === "submitting" || title.trim() === ""}
            className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {state === "submitting" && (
              <Loader2 size={16} className="animate-spin" />
            )}
            {state === "submitting"
              ? "DeskNet'sを表示しています…"
              : state === "ready" ? "実行側Edgeの予定追加画面を再表示" : "実行側Edgeの予定追加画面を表示"}
          </button>
          <button
            type="button"
            onClick={() => void chatStore.submitText("候補に戻して")}
            disabled={state === "submitting"}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-60"
          >
            <RotateCcw size={16} />候補に戻る
          </button>
        </div>
      )}
      {state === "failed" && (
        <p className="text-sm text-destructive">{message}</p>
      )}
      {state === "ready" && (
        <p className="text-sm text-emerald-600">{message}</p>
      )}
      <p className="text-xs text-muted-foreground">
        このPCへの引き渡しは日時・参加者のみです。上記の議題・会議室・メール設定は自動反映されないため、DeskNet&apos;sで入力・確認してください。「実行側Edge」はRemote環境ではVM内です。どちらも「追加」を手動で押すまで登録されません。
      </p>
      {localMessage && <p className="text-sm" role="status">{localMessage}</p>}
    </div>
  );
};
