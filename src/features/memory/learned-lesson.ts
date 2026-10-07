export const LESSON_MEMO_TITLE = "LearnedLesson：再発防止";
export const LESSON_MEMO_CONTENT = "作業の成功は結果を確認してから報告する。失敗原因は未確認のまま断定しない。過去の失敗の詳細と再確認手順はLearnedLessonメモに保存し、指定されたときに参照する。";

function excerpt(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n（長文のため末尾を省略）` : value;
}

// PoC keeps user evidence verbatim. It does not invent a diagnosis or a tested fix.
export function buildLearnedLesson(props: {
  feedback: string;
  previousAssistant?: string;
  previousUser?: string;
  reportedAt: string;
  suffix: string;
}): { title: string; content: string } {
  const requestedName = props.feedback.match(/(?:名前|保存名)(?:は|を|[:：])\s*「([^」]+)」/)?.[1];
  const summary = props.feedback.replace(/^(?:エラーでした|エラーです|失敗しました|失敗でした)[。!！\s：:]*/, "").split("\n")[0].slice(0, 35);
  const title = requestedName || `LearnedLesson：${summary || "失敗の振り返り"} ${props.reportedAt.slice(0, 10)}-${props.suffix}`;
  const content = [
    "# LearnedLesson",
    `記録日時: ${props.reportedAt}`,
    "状態: 利用者による失敗報告。原因・修正方法は未検証。",
    "\n## 利用者の指摘",
    excerpt(props.feedback, 3000),
    "\n## 直前の依頼",
    excerpt(props.previousUser || "取得できませんでした。", 2000),
    "\n## 失敗したと指摘された回答",
    excerpt(props.previousAssistant || "取得できませんでした。対象の回答・エラー内容を追加してください。", 5000),
    "\n## 次回の再確認手順",
    "1. 指摘と対象の回答・実行結果を照合し、失敗した箇所を特定する。",
    "2. 原因が不明なら、エラー全文・再現条件・期待する結果を確認する。",
    "3. 修正後に同じ条件で再検証し、確認できた結果だけを報告する。",
    "4. 確認できた原因と修正手順を、このメモの本文に追記する。",
  ].join("\n");
  return { title, content };
}
