/** Produce a short display ID: first 8 characters. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
