import { CONTENT_TIME_ZONE } from './config.ts'

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Milliseconds the given zone's wall clock is ahead of UTC at `utcTs`. */
function timeZoneOffsetMs(utcTs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utcTs)).map(part => [part.type, part.value]),
  )
  const wallClockAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return wallClockAsUtc - utcTs
}

/**
 * The UTC instant of midnight of the given calendar date in the given
 * zone. Two correction passes converge across DST transitions.
 */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  let ts = Date.UTC(year, month - 1, day)
  for (let i = 0; i < 2; i++)
    ts = Date.UTC(year, month - 1, day) - timeZoneOffsetMs(ts, timeZone)
  return new Date(ts)
}

/**
 * Parse a frontmatter date value into the UTC instant of midnight in
 * CONTENT_TIME_ZONE — i.e. `createdAt: 2025-10-23` means "October 23
 * where the author lives", stored as an unambiguous instant.
 *
 * Accepts only 'yyyy-MM-dd' strings: parseMdxFile loads frontmatter
 * without YAML's timestamp type, so unquoted dates arrive as the text the
 * author wrote.
 *
 * Deterministic regardless of machine timezone. Throws on anything else,
 * including calendar-impossible dates such as 2024-02-30.
 */
export function parseFrontmatterDate(value: unknown): Date {
  if (value === undefined || value === null)
    throw new Error(`[parser/date] Missing value: expected 'yyyy-MM-dd'`)
  if (typeof value !== 'string')
    throw new TypeError(`[parser/date] Unsupported type '${typeof value}': expected a 'yyyy-MM-dd' string`)

  const match = DATE_ONLY_RE.exec(value.trim())
  if (!match)
    throw new Error(`[parser/date] Invalid date format for '${value}': expected 'yyyy-MM-dd'`)

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  // Round-trip check rejects impossible dates (e.g. 2024-02-30 rolls over to March)
  const probe = new Date(Date.UTC(year, month - 1, day))
  const roundTrips
    = probe.getUTCFullYear() === year
      && probe.getUTCMonth() === month - 1
      && probe.getUTCDate() === day
  if (!roundTrips)
    throw new Error(`[parser/date] Impossible calendar date '${value}'`)

  return zonedMidnight(year, month, day, CONTENT_TIME_ZONE)
}
