import { userSession } from "@/features/auth-page/helpers";
import { redirect } from "next/navigation";
import { DeskNetsTeamsConfirmation } from "@/features/desknets-agent/desknets-teams-confirmation";

export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: {searchParams: {runId?: string; chatThreadId?: string}}) {
  const valid = (value?: string) => Boolean(value && /^[A-Za-z0-9_-]{1,200}$/.test(value));
  if (!valid(searchParams.runId) || !valid(searchParams.chatThreadId)) return <p>予定の確認リンクが正しくありません。Teamsで候補を選び直してください。</p>;
  if (!await userSession()) {
    const callback = `/desknets-agent/confirm?${new URLSearchParams({runId: searchParams.runId!, chatThreadId: searchParams.chatThreadId!})}`;
    redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(callback)}`);
  }
  return <DeskNetsTeamsConfirmation runId={searchParams.runId!} chatThreadId={searchParams.chatThreadId!} />;
}
