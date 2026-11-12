/**
 * The message of anything thrown, Error or not, with the messages of its
 * causes: fetch reports every network failure as "fetch failed" and keeps
 * the reason (a refused connection, a reset, a name that does not resolve)
 * in `cause`.
 */
export function messageOf(err: unknown, seen = new Set<unknown>()): string {
  if (!(err instanceof Error))
    return String(err)
  seen.add(err)
  // a cause that loops back is left out rather than followed forever
  return err.cause === undefined || seen.has(err.cause)
    ? err.message
    : `${err.message} (${messageOf(err.cause, seen)})`
}
