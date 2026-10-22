export default function SalesforceConnectPage() {
  return <main className="mx-auto max-w-xl p-8 space-y-4">
    <h1 className="text-xl font-semibold">Salesforce本人接続</h1>
    <p>FullSandのご自身のアカウントでログインし、AzureChatとの連携を許可してください。</p>
    <form action="/api/salesforce/connection/start" method="post">
      <button type="submit" className="rounded bg-primary px-4 py-2 text-primary-foreground">Salesforceに接続する</button>
    </form>
    <p>接続完了後はAzureChatへ戻り、新しい会話で検索してください。</p>
  </main>;
}
