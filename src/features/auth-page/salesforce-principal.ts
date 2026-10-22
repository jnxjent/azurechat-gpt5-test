/** Use claims from the verified identity provider, never an email or request body. */
export function salesforcePrincipalFromProfile(provider: string, profile: Record<string, unknown>, tenant: string | undefined): string | undefined {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const { tid, oid } = profile;
  if (provider !== "azure-ad" || typeof tid !== "string" || typeof oid !== "string" ||
      !uuid.test(tid) || !uuid.test(oid) || tid.toLowerCase() !== tenant?.toLowerCase()) return undefined;
  return `${tid}:${oid}`.toLowerCase();
}
