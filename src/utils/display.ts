/** Produce a short display ID. For pending-<pid> show the full string; otherwise first 8 chars. */
export function shortId(id: string): string {
  if (id.startsWith("pending-")) return id;
  return id.slice(0, 8);
}
