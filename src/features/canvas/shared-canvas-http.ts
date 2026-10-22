import { CanvasShareError } from "./shared-canvas-service";
import { CanvasSourceError } from "./canvas-source";
export const sharedCanvasHeaders = { "Cache-Control": "private, no-store", "Vary": "Cookie", "Referrer-Policy": "same-origin" };
export function requireCanvasOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(process.env.NEXTAUTH_URL ?? request.url).origin) throw new CanvasShareError(403, "同じサイトから操作してください。");
}
export async function canvasShareInput(request: Request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 8000) throw new CanvasShareError(400, "入力内容が大きすぎます。");
  try { const value = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(); return value; }
  catch { throw new CanvasShareError(400, "入力内容を確認してください。"); }
}
export function canvasShareFailure(error: unknown) {
  const login = error instanceof Error && error.message === "User not found";
  const known = error instanceof CanvasShareError || error instanceof CanvasSourceError;
  return Response.json({ error: login ? "ログインしてください。" : known ? error.message : "Canvasを確認できませんでした。" }, { status: login ? 401 : known ? error.status : 503, headers: sharedCanvasHeaders });
}
