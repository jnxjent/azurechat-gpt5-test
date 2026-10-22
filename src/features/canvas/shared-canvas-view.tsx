"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CanvasChart } from "./canvas-panel";
import { canvasTables, type CanvasDocument } from "./canvas-rules";
type Report = { revision: number; updatedAt: string; owner: boolean; readers?: string[]; enabled?: boolean; restricted: boolean; document?: CanvasDocument; query?: string };
export function SharedCanvasView({ id }: { id: string }) {
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState("");
  const [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [readers, setReaders] = useState<string | null>(null), [enabled, setEnabled] = useState<boolean | null>(null);
  const generation = useRef(0), active = useRef<AbortController | null>(null);
  const endpoint = `/api/canvas/shared/${encodeURIComponent(id)}`;
  const load = useCallback(async (force = false) => {
    if (document.hidden || (active.current && !force)) return;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    const current = ++generation.current;
    try {
      const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (current !== generation.current) return;
      if (!response.ok) throw Error(data.error || "Canvasを読み込めませんでした。");
      setReport(data); setError("");
    } catch (e) { if (current === generation.current && !controller.signal.aborted) { setReport(null); setError(e instanceof Error ? e.message : "Canvasを読み込めませんでした。"); } }
    finally { if (active.current === controller) active.current = null; }
  }, [endpoint]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 30000);
    const visibility = () => {
      if (document.hidden) { generation.current++; active.current?.abort(); active.current = null; setReport(null); }
      else void load(true);
    };
    const focus = () => { void load(); };
    const restore = () => { setReport(null); void load(true); };
    document.addEventListener("visibilitychange", visibility); window.addEventListener("focus", focus); window.addEventListener("pageshow", restore);
    return () => { generation.current++; active.current?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("focus", focus); window.removeEventListener("pageshow", restore); };
  }, [load]);
  async function change(action: "access" | "refresh") {
    if (!report) return; setBusy(true); setNotice(""); setOperationError("");
    generation.current++; active.current?.abort(); active.current = null;
    try {
      const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: report.revision, action, ...(action === "access" ? { readers: (readers ?? report.readers?.join("\n") ?? "").split(/[,;\n]/).map(v => v.trim()).filter(Boolean), enabled: enabled ?? report.enabled ?? false } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "更新できませんでした。");
      setReaders(null); setEnabled(null); setNotice(action === "access" ? "共有設定を更新しました。" : "最新データを取得しました。同じURLで表示できます。");
    } catch (e) { setOperationError(e instanceof Error ? e.message : "更新できませんでした。"); }
    finally { setBusy(false); void load(true); }
  }
  const doc = report?.document, table = doc ? canvasTables(doc.content)[doc.tableIndex] : undefined;
  return <main className="mx-auto max-w-6xl p-6 space-y-5">
    <h1 className="text-2xl font-semibold">{doc?.title ?? "共有Canvas"}</h1>
    <p>指定された共有先だけが閲覧できます。表示時にSalesforceの現在の参照権限を確認します。</p>
    <button type="button" className="underline" onClick={() => { void load(true); }}>表示を再確認</button>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {operationError && <p role="alert">{operationError}</p>}
    {!report && !error && <p role="status">閲覧権限を確認しています…</p>}
    {report && <p>最終更新：{new Date(report.updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}（日本時間）／版：{report.revision}</p>}
    {report?.restricted && <p role="alert">現在のSalesforce権限を確認できないため、本文は表示していません。共有解除は下の設定から行えます。</p>}
    {report?.owner && <section className="rounded border p-4 space-y-3">
      <h2 className="font-semibold">共有と更新</h2>
      <label className="block">共有先のメールアドレス（1行に1人）<textarea className="block w-full rounded border bg-background p-2" value={readers ?? report.readers?.join("\n") ?? ""} onChange={e => setReaders(e.target.value)} /></label>
      <label className="flex gap-2"><input type="checkbox" checked={enabled ?? report.enabled ?? false} onChange={e => setEnabled(e.target.checked)} />指定した相手への共有を有効にする</label>
      <div className="flex flex-wrap gap-4">
        <button disabled={busy} type="button" className="rounded bg-primary px-3 py-2 text-primary-foreground" onClick={() => { void change("access"); }}>共有設定を保存</button>
        <button disabled={busy} type="button" className="rounded border px-3 py-2" onClick={() => { void change("refresh"); }}>SFから内容を更新</button>
        <button type="button" className="rounded border px-3 py-2" onClick={() => { void navigator.clipboard.writeText(window.location.href).then(() => setNotice("共有URLをコピーしました。Teamsに貼り付けられます。")).catch(() => setError("アドレス欄からURLをコピーしてください。")); }}>共有URLをコピー</button>
      </div>
      <p className="text-sm">共有を無効にすると、閲覧者の次回アクセス・再確認時に表示を停止します。更新は同じ依頼で再検索します。取得条件の自動更新は後続で追加します。</p>
      {report.query && <p className="text-sm">取得依頼：{report.query}</p>}
    </section>}
    {doc && <article className="prose max-w-none dark:prose-invert">
      <p>出典：{doc.source}{doc.period ? ` ／ 対象期間：${doc.period}` : ""}</p>
      {table && doc.unit && doc.period && <CanvasChart table={table} column={doc.valueColumn} columns={doc.valueColumns} type={doc.chartType} unit={doc.unit} />}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
    </article>}
  </main>;
}
