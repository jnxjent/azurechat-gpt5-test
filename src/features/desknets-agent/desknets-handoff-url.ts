export function validatedDeskNetsHandoffUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("引き渡し先を取得できませんでした。");
  const url = new URL(value);
  if (url.origin !== "https://desknets.midac.jp" || url.pathname !== "/dneo/dneo.cgi" ||
      url.username || url.password || url.search !== "?cmd=schindex" ||
      new URLSearchParams(url.hash.slice(1)).get("cmd") !== "schaddtarget") throw new Error("不正な引き渡し先です。");
  return url.href;
}
