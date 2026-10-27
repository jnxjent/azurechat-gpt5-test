import { createHash, randomUUID } from "node:crypto";

const prefix = (thread: string) => `skill-read-v1:${createHash("sha256").update(thread).digest("hex")}:`;
/** Fresh per execution; account choices are passed explicitly, never by NL cache. */
export function skillGatewayThread(thread: string): string {
  if (!thread) throw new TypeError("Chat thread missing");
  return prefix(thread) + randomUUID();
}
/** This only selects the revalidation context. The Gateway still verifies the
 * proof signature, current principal/org/user, and every original record. */
export function proofGatewayThread(proof: string, chatThread: string): string | undefined {
  try {
    const raw = proof.split(".")[0];
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof value?.thread !== "string") return chatThread;
    if (value.thread === chatThread) return chatThread;
    const expected = prefix(chatThread);
    return value.thread.startsWith(expected) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.thread.slice(expected.length)) ? value.thread : undefined;
  } catch {
    // Legacy/invalid proofs still go through the existing Gateway verifier.
    return chatThread;
  }
}
