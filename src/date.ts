import { CONTENT_TIME_ZONE } from './config.ts'

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse a frontmatter date value into the UTC instant of midnight in
 * CONTENT_TIME_ZONE, i.e. `createdAt: 2025-10-23` means "October 23
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

  // the format is checked first: PlainDate.from reads other spellings too (20251023, a date with a time)
  const text = value.trim()
  if (!DATE_ONLY_RE.test(text))
    throw new Error(`[parser/date] Invalid date format for '${value}': expected 'yyyy-MM-dd'`)

  let date: Temporal.PlainDate
  try {
    date = Temporal.PlainDate.from(text)
  }
  catch {
    throw new Error(`[parser/date] Impossible calendar date '${value}'`)
  }
  return new Date(date.toZonedDateTime(CONTENT_TIME_ZONE).epochMilliseconds)
}
