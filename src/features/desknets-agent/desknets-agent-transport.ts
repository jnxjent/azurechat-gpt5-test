/** A transport error is not a DeskNet's login failure. Never retry POSTs here. */
export function deskNetsTransportMessage(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "BrowserAgentへの接続がタイムアウトしました。VMとAPIの稼働状態を確認してください。処理が開始済みの可能性があるため、実行状態を確認してから再試行してください。";
  }
  return "BrowserAgentに接続できません。VMとAPIの稼働状態を確認してください。DeskNet'sの再ログインが必要かどうかは、接続復旧後に確認します。";
}

export function fetchDeskNetsAgent(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
}
