import { createSharedCanvas } from "@/features/canvas/shared-canvas-service";
import { canvasShareFailure, canvasShareInput, requireCanvasOrigin, sharedCanvasHeaders } from "@/features/canvas/shared-canvas-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    requireCanvasOrigin(request);
    const input = await canvasShareInput(request);
    return Response.json(await createSharedCanvas(typeof input.q === "string" ? input.q : ""), { headers: sharedCanvasHeaders });
  } catch (error) { return canvasShareFailure(error); }
}
