/** The message of anything thrown, Error or not. */
export function messageOf(err: unknown): string {
  return err instanceof Error
    ? err.message
    : String(err)
}
