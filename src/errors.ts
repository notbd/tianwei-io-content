/**
 * The message of anything thrown, Error or not, with the messages of its
 * causes: fetch reports every network failure as "fetch failed" and keeps
 * the reason (a refused connection, a reset, a name that does not resolve)
 * in `cause`.
 */
export function messageOf(err: unknown): string {
  if (!(err instanceof Error))
    return String(err)
  return err.cause === undefined
    ? err.message
    : `${err.message} (${messageOf(err.cause)})`
}
