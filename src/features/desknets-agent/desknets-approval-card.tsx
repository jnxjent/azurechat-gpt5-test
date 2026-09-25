"use client";

import { chatStore } from "@/features/chat-page/chat-store";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DeskNetsApprovalRequest } from "./desknets-agent-types";

type DeskNetsApprovalToolResult = {
  runId: string;
  chatThreadId: string;
  approvalRequest: DeskNetsApprovalRequest;
};

/**
 * Teams WEB会議の状態。サーバーが組み立てた copyText をそのままコピーする。
 * 保証できるのはコピーする文字列まで。貼り付け先のDeskNet's本文は別オリジンのため
 * 読めず、既存本文が残ったか・二重に貼られていないかは検証できない。
 */
type WebMeetingView = {
  requested: boolean;
  status: string;
  revision: number;
  joinUrl?: string;
  meetingId?: string;
  passcode?: string;
  passcodeAvailability?: "required" | "not_required" | "unavailable";
  copyText?: string;
  complete: boolean;
  /** 保存済みの会議と、いま確定している日時・件名がずれている。 */
  scheduleChanged: boolean;
  notes: string[];
  registered: false;
  error?: string;
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

// 「不要」と「取得失敗」を同じ表示にしない。
const passcodeLabel = (view: WebMeetingView): string => {
  if (view.passcodeAvailability === "required") return view.passcode ?? "取得できませんでした";
  if (view.passcodeAvailability === "not_required") return "不要";
  return "取得できませんでした";
};

export const DeskNetsApprovalCard = ({
  toolResult,
}: {
  toolResult: Record<string, unknown> | null;
}) => {
  const parsed = parseApprovalToolResult(toolResult);
  if (!parsed) return null;

  return <ApprovalCard key={parsed.runId} {...parsed} />;
};

const ApprovalCard = ({
  runId,
  chatThreadId,
  approvalRequest: approval,
}: DeskNetsApprovalToolResult) => {
  const [localMessage, setLocalMessage] = useState("");
  const [openingLocal, setOpeningLocal] = useState(false);
  const [webMeeting, setWebMeeting] = useState<WebMeetingView | null>(null);
  const [webMeetingMessage, setWebMeetingMessage] = useState("");
  const [creatingWebMeeting, setCreatingWebMeeting] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const [manualCopyText, setManualCopyText] = useState("");

  const openOnThisPC = async () => {
    if (openingLocal) return;
    setLocalMessage("");
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
    } catch (error) {
      tab.close();
      setLocalMessage(error instanceof Error ? error.message : "引き渡しに失敗しました。");
    } finally {setOpeningLocal(false);}
  };

  const loadWebMeeting = useCallback(async (): Promise<WebMeetingView | undefined> => {
    try {
      const response = await fetch(
        `/api/desknets-agent/runs/${encodeURIComponent(runId)}?chatThreadId=${encodeURIComponent(chatThreadId)}&webMeeting=1`,
        {cache:"no-store"},
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setWebMeeting(null);
        setWebMeetingMessage(body?.message ?? "WEB会議情報を取得できませんでした。もう一度お試しください。");
        return undefined;
      }
      const view = (await response.json()) as WebMeetingView;
      setWebMeeting(view);
      return view;
    } catch {
      setWebMeeting(null);
      setWebMeetingMessage("WEB会議情報を取得できませんでした。もう一度お試しください。");
      return undefined;
    }
  }, [runId, chatThreadId]);

  useEffect(() => { void loadWebMeeting(); }, [loadWebMeeting]);

  // A later chat message can request WEB conferencing for this existing card.
  // Refresh only until that request appears; no Graph operation is performed.
  useEffect(() => {
    if (webMeeting?.requested || webMeeting?.joinUrl) return;
    const timer = window.setInterval(() => { void loadWebMeeting(); }, 3000);
    return () => window.clearInterval(timer);
  }, [webMeeting?.requested, webMeeting?.joinUrl, loadWebMeeting]);

  // 明示的な発行操作。候補選択・カード再表示・コピーからは呼ばれない。
  // 作成済みなら作り直さず、未取得の情報の取得だけを再開する。
  const createWebMeeting = async () => {
    if (creatingWebMeeting) return;
    setCreatingWebMeeting(true);
    setWebMeetingMessage("");
    setCopyMessage("");
    setManualCopyText("");
    try {
      const response = await fetch(`/api/desknets-agent/runs/${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({chatThreadId, action: "create-web-meeting"}),
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.message ?? "Teams会議を作成できませんでした。");
      setWebMeeting(body as WebMeetingView);
    } catch (error) {
      setWebMeetingMessage(error instanceof Error ? error.message : "Teams会議を作成できませんでした。");
    } finally {
      setCreatingWebMeeting(false);
    }
  };

  const copyWebMeeting = async () => {
    setCopyMessage("");
    setWebMeetingMessage("");
    setManualCopyText("");
    // コピー時に最新の保存内容を読み直す。Graphの更新は行わない。
    const latest = await loadWebMeeting();
    if (latest === undefined) return;
    if (!latest.copyText) {
      setWebMeetingMessage("WEB会議情報を取得できませんでした。もう一度お試しください。");
      return;
    }
    if (webMeeting !== null && latest.revision !== webMeeting.revision) {
      setWebMeetingMessage("会議が更新されました。表示を更新したので、新しい内容を確認してからコピーしてください。");
      return;
    }
    const copyText = latest.copyText.replaceAll("【Teams WEB会議情報ここまで】", "").trimEnd();
    try {
      await navigator.clipboard.writeText(copyText);
      // 成功したときだけ成功と表示する。
      setCopyMessage("コピーしました。DeskNet'sの「内容」欄の末尾に貼り付けてください。");
    } catch {
      setManualCopyText(copyText);
      setWebMeetingMessage("コピーできませんでした。下の内容を選択して手動でコピーしてください。");
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

  const showWebMeeting =
    webMeeting !== null && (webMeeting.requested || webMeeting.joinUrl !== undefined);

  return (
    <div className="space-y-3 rounded-lg border-2 border-amber-500/70 bg-amber-500/10 p-4">
      <div className="font-semibold">DeskNet&apos;s 予定内容の最終確認</div>
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">件名</dt>
        <dd>{approval.title}</dd>
        <dt className="text-muted-foreground">日時</dt>
        <dd>{dateTime(approval.start)} ～ {dateTime(approval.end)}</dd>
        <dt className="text-muted-foreground">参加者</dt>
        <dd>{approval.participantIds.join("、")}</dd>
        <dt className="text-muted-foreground">会議室</dt>
        <dd>{approval.facilityId}</dd>
        <dt className="text-muted-foreground">メール</dt>
        <dd>{approval.emailNotificationWillBeSent ? "送信する" : "送信しない"}</dd>
      </dl>
      {showWebMeeting && webMeeting !== null && (
        <div className="space-y-2 rounded-md border bg-background/60 p-3 text-sm">
          <div className="font-semibold">Teams WEB会議</div>
          {webMeeting.joinUrl === undefined ? (
            <>
              <p className="text-muted-foreground">
                本人名義でTeams会議を作成し、参加情報を表示します。Teams側の招待メールは送信しません。
                主催者は操作しているご本人です。他の方の名義での作成には対応していません。
              </p>
              <button type="button" onClick={() => void createWebMeeting()} disabled={creatingWebMeeting}
                className="rounded-md bg-sky-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {creatingWebMeeting ? "作成しています…" : "Teams会議を作成"}
              </button>
            </>
          ) : (
            <>
              <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">参加URL</dt>
                <dd className="break-all">{webMeeting.joinUrl}</dd>
                <dt className="text-muted-foreground">会議ID</dt>
                <dd>{webMeeting.meetingId ?? "取得できませんでした"}</dd>
                <dt className="text-muted-foreground">パスコード</dt>
                <dd>{passcodeLabel(webMeeting)}</dd>
              </dl>
              {webMeeting.notes.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {webMeeting.notes.map((note) => <li key={note}>{note}</li>)}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void copyWebMeeting()}
                  disabled={creatingWebMeeting}
                  className="rounded-md bg-sky-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
                  WEB会議情報をコピー
                </button>
                {!webMeeting.complete && (
                  <button type="button" onClick={() => void createWebMeeting()} disabled={creatingWebMeeting}
                    className="rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-60">
                    {creatingWebMeeting ? "取得しています…" : "不足している情報を再取得"}
                  </button>
                )}
              </div>
            </>
          )}
          {manualCopyText !== "" && (
            <textarea readOnly value={manualCopyText} rows={5}
              className="w-full rounded-md border bg-background p-2 font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()} />
          )}
          {copyMessage !== "" && <p role="status">{copyMessage}</p>}
          {webMeetingMessage !== "" && <p role="alert">{webMeetingMessage}</p>}
          {webMeeting.error !== undefined && webMeetingMessage === "" && (
            <p role="alert">{webMeeting.error}</p>
          )}
        </div>
      )}
      {!showWebMeeting && webMeetingMessage !== "" && <p role="alert">{webMeetingMessage}</p>}
      <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void openOnThisPC()} disabled={openingLocal}
            className="rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {openingLocal ? "開いています…" : "desknet'sを開く"}
          </button>
          <button
            type="button"
            onClick={() => void chatStore.submitText("候補に戻して")}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-60"
          >
            <RotateCcw size={16} />候補に戻る
          </button>
        </div>
      {localMessage && <p className="text-sm" role="alert">{localMessage}</p>}
    </div>
  );
};
