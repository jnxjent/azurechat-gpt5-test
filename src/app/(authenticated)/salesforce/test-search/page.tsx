"use client";
import { useState } from "react";
type Result = { text: string; items: Record<string, string | number | boolean | null>[]; total: number | null; userId: string; orgId: string };
const labels: Record<string, string> = { Id: "レコードID", Name: "名称", name: "名称", id: "レコードID", StageName: "フェーズ", Amount: "金額", CloseDate: "完了予定日", OwnerId: "所有者ID", owner_name: "担当者", url: "リンク", status: "状況" };
export default function SalesforceTestSearchPage() {
  const [q, setQ] = useState("私の取引先を挙げて");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  async function createCanvas() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/canvas/shared", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q }), cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Canvasを作成できませんでした。");
      window.location.assign(`/canvas/shared/${encodeURIComponent(data.id)}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Canvasを作成できませんでした。"); setBusy(false); }
  }
  async function search(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/salesforce/test-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q }), cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "検索できませんでした。");
      setResult(data);
    } catch (e) { setError(e instanceof Error ? e.message : "検索できませんでした。"); }
    finally { setBusy(false); }
  }
  const columns = Array.from(new Set(result?.items.flatMap(item => Object.keys(item)) ?? []));
  return <main className="mx-auto max-w-5xl p-8 space-y-4">
    <h1 className="text-xl font-semibold">Salesforce 本人別検索テスト</h1>
    <p>FullSandのご自身の参照権限で検索します。この画面の検索結果は履歴へ保存しません。通常チャットと過去の履歴はそのままです。</p>
    <form onSubmit={search} className="space-y-3">
      <label className="block">質問<input value={q} onChange={e => setQ(e.target.value)} maxLength={1000} className="mt-1 block w-full rounded border bg-background p-3" /></label>
      <p className="text-sm">例：私の取引先を挙げて ／ 私の商談を挙げて ／ 私の部下を挙げて。毎回、対象と条件を含めて質問してください。</p>
      <button type="submit" disabled={busy || !q.trim()} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy ? "検索中…" : "本人の権限で検索する"}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {result && <section aria-live="polite" className="space-y-3">
      <button type="button" disabled={busy} onClick={() => { void createCanvas(); }} className="rounded border px-4 py-2">現在の条件で共有用Canvasを作成</button>
      <p className="whitespace-pre-wrap">{result.text}</p>
      <p>表示：{result.items.length}件（最大20件）／全件数：{result.total === null ? "未確認" : result.total.toLocaleString("ja-JP")}</p>
      {columns.length > 0 && <div className="overflow-x-auto"><table className="w-full border-collapse text-sm"><thead><tr>{columns.map(key => <th key={key} className="border p-2 text-left">{labels[key] ?? key}</th>)}</tr></thead><tbody>{result.items.map((item, i) => <tr key={i}>{columns.map(key => <td key={key} className="border p-2">{item[key] == null ? "未取得" : String(item[key])}</td>)}</tr>)}</tbody></table></div>}
      <p className="text-sm">照合用 SFユーザーID：{result.userId} ／ 組織ID：{result.orgId}</p>
    </section>}
  </main>;
}
