/** One place for "what do I print for this thrown value". */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
