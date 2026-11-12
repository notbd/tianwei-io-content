/**
 * The message of anything thrown, Error or not, with the messages of its
 * causes: fetch reports every network failure as "fetch failed" and keeps
 * the reason (a refused connection, a reset, a name that does not resolve)
 * in `cause`.
 */
export function messageOf(err: unknown): string {
  const seen = new Set<unknown>()
  const describe = (current: unknown): string => {
    if (!(current instanceof Error))
      return String(current)
    seen.add(current)
    // a cause that loops back is left out rather than followed forever
    return current.cause === undefined || seen.has(current.cause)
      ? current.message
      : `${current.message} (${describe(current.cause)})`
  }
  return describe(err)
}
