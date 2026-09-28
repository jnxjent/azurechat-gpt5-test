"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

export function DeskNetsCredentialRegistration() {
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [sharedReady, setSharedReady] = useState(true);
  const [transportReady, setTransportReady] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/desknets-agent/credentials", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((body) => {
        if (!active) return;
        if (typeof body?.registered === "boolean") {
          setRegistered(body.registered);
          setSharedReady(body.sharedReady === true);
          setTransportReady(body.transportReady === true);
        } else {
          setStatusError(true);
        }
      }).catch(() => { if (active) setStatusError(true); });
    return () => { active = false; };
  }, []);

  const canEdit = registered !== null && ((sharedReady && transportReady) || registered);
  const status = registered === null
    ? statusError ? "desknet's ログイン状態を確認できません" : "desknet's ログイン状態を確認中…"
    : registered
    ? "desknet's ログイン登録済み"
    : !sharedReady
    ? "desknet's 共通入口の認証が未設定です。管理者に連絡してください。"
    : !transportReady
      ? "desknet's ログイン登録の通信設定が未完了です。管理者に連絡してください。"
      : "desknet's ログイン未登録";

  async function saveCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/desknets-agent/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: data.get("username"), password: data.get("password") }),
        cache: "no-store",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? body?.message ?? "登録できませんでした。");
      form.current?.reset();
      setRegistered(true);
      setEditing(false);
      setMessage("desknet's ログイン情報を保存しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登録できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  async function removeCredentials() {
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/desknets-agent/credentials", { method: "DELETE", cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? body?.message ?? "登録を解除できませんでした。");
      form.current?.reset();
      setRegistered(false);
      setEditing(false);
      setMessage("desknet's ログイン登録を解除しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登録を解除できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="pointer-events-auto absolute bottom-[5.5rem] right-4 z-30 w-[min(19rem,calc(100%_-_2rem))] 2xl:bottom-3 2xl:left-[calc(50%_+_24.75rem)] 2xl:right-auto 2xl:w-56"
      aria-label="desknet's ログイン設定"
    >
      {editing && (
        <div id="desknets-credentials-panel" className="absolute bottom-full right-0 mb-2 w-[min(27rem,calc(100vw_-_2rem))] rounded-lg border bg-background p-4 shadow-xl">
          <p className="text-sm font-semibold">desknet's ログイン情報</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {!sharedReady
              ? "desknet's 共通入口の認証が未設定です。管理者に連絡してください。"
              : !transportReady
                ? "desknet's ログイン登録の通信設定が未完了です。管理者に連絡してください。"
                : "ご自身の ID とパスワードを入力してください。"}
          </p>
          <form ref={form} className="mt-3 grid grid-cols-2 gap-3 text-xs" onSubmit={saveCredentials}>
            {sharedReady && transportReady && <>
              <label className="flex min-w-0 flex-col gap-1">desknet's ID
                <input name="username" autoComplete="username" required maxLength={200} className="w-full rounded-md border bg-background px-2 py-1.5" />
              </label>
              <label className="flex min-w-0 flex-col gap-1">desknet's パスワード
                <input name="password" type="password" autoComplete="current-password" required maxLength={1024} className="w-full rounded-md border bg-background px-2 py-1.5" />
              </label>
            </>}
            <div className="col-span-2 flex flex-wrap justify-end gap-2">
              {sharedReady && transportReady && <button type="submit" disabled={saving} className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {saving ? "保存中…" : "暗号化して保存"}
              </button>}
              {registered && <button type="button" disabled={saving} onClick={() => void removeCredentials()} className="rounded-md border px-3 py-1.5 hover:bg-accent disabled:opacity-50">登録解除</button>}
            </div>
          </form>
          {message && <p role="status" className="mt-2 text-xs">{message}</p>}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 rounded-lg border bg-background/95 px-2.5 py-2 text-xs shadow-sm backdrop-blur-sm">
        <span className="min-w-0 leading-snug">{status}</span>
        {canEdit && <button
          type="button"
          aria-expanded={editing}
          aria-controls="desknets-credentials-panel"
          onClick={() => { setEditing((value) => !value); setMessage(""); }}
          className="shrink-0 rounded-md border border-input bg-background px-2.5 py-1 font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >{editing ? "閉じる" : registered ? "更新" : "登録"}</button>}
      </div>
      {!editing && message && <p role="status" className="absolute bottom-full right-0 mb-2 rounded-md border bg-background px-3 py-2 text-xs shadow-sm">{message}</p>}
    </section>
  );
}
