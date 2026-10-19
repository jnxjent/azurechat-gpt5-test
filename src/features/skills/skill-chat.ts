export type SkillCommand = { kind: "list" } | { kind: "show" | "delete"; query: string }
  | { kind: "rename"; query: string; title: string }
  | { kind: "save"; title: string; content: string } | { kind: "needs_content" } | { kind: "needs_name" };

export function parseSkillCommand(message: string, previousAssistant?: string): SkillCommand | undefined {
  const text = message.trim();
  const first = text.split(/\r?\n/)[0];
  if (/^(?:私の|保存した)?(?:skills?|スキル)(?:の)?一覧(?:を)?(?:見せて|見たい|表示して|教えて|出して)?[。?？]?$/i.test(text)) return { kind: "list" };
  if (!/skills?|スキル/i.test(first)) return undefined;
  const names = Array.from(first.matchAll(/[「『]([^」』]+)[」』]/g)).map(match => match[1].trim());
  if (names.length >= 2 && /[」』]に(?:変更|改名)して(?:ください)?[。！!]?$/i.test(first)) return { kind: "rename", query: names[0], title: names[1] };
  if (names.length && /[」』](?:の(?:skills?|スキル))?を(?:削除|消去)して(?:ください)?[。！!]?$/i.test(first)) return { kind: "delete", query: names[0] };
  if (/(?:保存|保管|登録|残)して(?:ください)?[。！!]?$/.test(first)) {
    if (!names[0]) return {kind:"needs_name"};
    const body = text.includes("\n") ? text.slice(text.indexOf("\n") + 1).trim() : "";
    const fenced = body.match(/^```(?:md|markdown)?\s*\n([\s\S]*?)\n```\s*$/i)?.[1];
    const content = (fenced ?? body) || (/(?:この回答|この内容|今の回答|今の説明|直前の回答|直前の説明|これを)/.test(first) ? previousAssistant ?? "" : "");
    return content.trim() ? { kind:"save", title:names[0], content:content.trim() } : {kind:"needs_content"};
  }
  if (names.length && /(?:見せて|表示して|内容を教えて)[。?？]?$/.test(first)) return {kind:"show",query:names[0]};
  return undefined;
}
