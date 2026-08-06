/**
 * Stable fingerprint of document title + ProseMirror JSON for Bluefox
 * Accepted → re-review gating (hide "Request re-review" when content matches
 * the last approved snapshot).
 */
export function bluefoxContentFingerprint(opts: {
  title?: string | null;
  data?: unknown;
}): string {
  const payload = `${opts.title || ""}\n${JSON.stringify(opts.data ?? null)}`;
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
