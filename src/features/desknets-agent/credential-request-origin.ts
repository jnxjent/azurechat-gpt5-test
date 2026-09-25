/** Match the browser's Origin against the public app URL behind Azure's proxy. */
export function isAllowedCredentialOrigin(
  origin: string | null,
  requestOrigin: string,
  publicAppUrl: string | undefined,
): boolean {
  if (!origin) return false;
  try {
    return origin === new URL(publicAppUrl ?? requestOrigin).origin;
  } catch {
    return false;
  }
}
