import { getSharedCanvas, changeSharedCanvas } from "@/features/canvas/shared-canvas-service";
import { canvasShareFailure, canvasShareInput, requireCanvasOrigin, sharedCanvasHeaders } from "@/features/canvas/shared-canvas-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try { return Response.json(await getSharedCanvas(params.id), { headers: sharedCanvasHeaders }); }
  catch (error) { return canvasShareFailure(error); }
}
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  try {
    requireCanvasOrigin(request);
    return Response.json(await changeSharedCanvas(params.id, await canvasShareInput(request)), { headers: sharedCanvasHeaders });
  } catch (error) { return canvasShareFailure(error); }
}
