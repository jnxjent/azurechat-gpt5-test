import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { getCurrentUser } from "@/features/auth-page/helpers";

export type CanvasActor={email:string;salesforcePrincipal?:string};
const actors=new AsyncLocalStorage<CanvasActor>();
/** Server-only bridge: callers must authenticate the Teams activity and verify its roster identity. */
export function withCanvasActor<T>(actor:CanvasActor,operation:()=>T):T {return actors.run(Object.freeze({...actor}),operation);}
export async function getCanvasActor():Promise<CanvasActor> {return actors.getStore()??await getCurrentUser();}
