/** Source selection is explicit; ACL permission alone is not retrieval intent. */
export function allowsLibrarySearch(message: string, selectedNames: string[], knowledgeRoute = false): boolean {
  if (knowledgeRoute) return true;
  if (selectedNames.some(name => typeof name === "string" && /^(?:azure\s*)?ai\s*search$|社内(?:資料|文書)?検索/i.test(name.trim()))) return true;
  return /sharepoint|\bSL\b|社内(?:資料|文書|規程|ルール|情報)|個人(?:ファイル|フォルダ)|部署共通|全社共通|共有(?:資料|文書|フォルダ)|添付(?:資料|ファイル|文書)|(?:この|その|上記の?)(?:資料|文書|PDF)|\.(?:pdf|docx?|xlsx?|pptx?)\b/i.test(message);
}
