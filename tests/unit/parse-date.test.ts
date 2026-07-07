import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTENT_TIME_ZONE } from '../../src/config.ts'
import { parseFrontmatterDate, zonedMidnight } from '../../src/parser.ts'

const ORIGINAL_TZ = process.env.TZ

afterEach(() => {
  if (ORIGINAL_TZ === undefined)
    delete process.env.TZ
  else
    process.env.TZ = ORIGINAL_TZ
})

/** The calendar date an instant falls on in the content time zone. */
function calendarDateInContentZone(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: CONTENT_TIME_ZONE })
}

describe('parseFrontmatterDate', () => {
  it('anchors yyyy-MM-dd strings to midnight in the content time zone (EST)', () => {
    // January: America/New_York is UTC-5
    const parsed = parseFrontmatterDate('2025-01-31')
    expect(parsed.getTime()).toBe(Date.UTC(2025, 0, 31, 5))
    expect(calendarDateInContentZone(parsed)).toBe('2025-01-31')
  })

  it('anchors summer dates with the DST offset (EDT)', () => {
    // June: America/New_York is UTC-4
    const parsed = parseFrontmatterDate('2024-06-15')
    expect(parsed.getTime()).toBe(Date.UTC(2024, 5, 15, 4))
    expect(calendarDateInContentZone(parsed)).toBe('2024-06-15')
  })

  it.each([
    ['2025-03-09', Date.UTC(2025, 2, 9, 5)], // spring-forward day: midnight is still EST
    ['2025-11-02', Date.UTC(2025, 10, 2, 4)], // fall-back day: midnight is still EDT
  ])('handles the DST transition day %s', (value, expected) => {
    const parsed = parseFrontmatterDate(value)
    expect(parsed.getTime()).toBe(expected)
    expect(calendarDateInContentZone(parsed)).toBe(value)
  })

  it('is deterministic across machine timezones', () => {
    // The historical bug: date-fns parse(value, 'yyyy-MM-dd', new Date())
    // produced machine-local midnight, so a laptop in Toronto and a UTC CI
    // runner wrote different timestamps for the same file.
    const timezones = ['UTC', 'America/New_York', 'Asia/Shanghai', 'Pacific/Kiritimati']
    const results = timezones.map((tz) => {
      process.env.TZ = tz
      return parseFrontmatterDate('2025-01-31').getTime()
    })
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBe(Date.UTC(2025, 0, 31, 5))
  })

  it('trims surrounding whitespace', () => {
    expect(parseFrontmatterDate(' 2024-06-15 ').getTime()).toBe(Date.UTC(2024, 5, 15, 4))
  })

  it('re-anchors Date instances (js-yaml unquoted dates) by calendar date', () => {
    // js-yaml parses unquoted `2025-10-23` as UTC midnight; only the
    // calendar date is meaningful, so it lands on content-zone midnight.
    const yamlDate = new Date(Date.UTC(2025, 9, 23))
    const parsed = parseFrontmatterDate(yamlDate)
    expect(parsed.getTime()).toBe(Date.UTC(2025, 9, 23, 4)) // October: EDT
    expect(calendarDateInContentZone(parsed)).toBe('2025-10-23')
  })

  it('rejects invalid Date instances', () => {
    expect(() => parseFrontmatterDate(new Date('nonsense'))).toThrow(/Invalid Date/)
  })

  it('rejects Date instances with a time component (YAML timestamps)', () => {
    // `createdAt: 2024-01-05 23:00:00-05:00` in YAML yields 2024-01-06T04:00Z —
    // silently truncating to a calendar date would shift the authored day.
    const timestamp = new Date(Date.UTC(2024, 0, 6, 4))
    expect(() => parseFrontmatterDate(timestamp)).toThrow(/Got a timestamp/)
  })

  it.each([
    '2024/06/15',
    '15-06-2024',
    '2024-6-5',
    '2024-06-15T10:00:00Z',
    'June 15, 2024',
    '',
  ])('rejects malformed string %j', (value) => {
    expect(() => parseFrontmatterDate(value)).toThrow(/Invalid date format/)
  })

  it.each([
    '2024-02-30',
    '2023-02-29',
    '2024-13-01',
    '2024-00-10',
    '2024-04-31',
  ])('rejects impossible calendar date %j', (value) => {
    expect(() => parseFrontmatterDate(value)).toThrow(/Impossible calendar date/)
  })

  it('accepts leap-day on leap years', () => {
    expect(parseFrontmatterDate('2024-02-29').getTime()).toBe(Date.UTC(2024, 1, 29, 5))
  })

  it.each([
    [undefined, /Missing value/],
    [null, /Missing value/],
    [42, /Unsupported type 'number'/],
    [true, /Unsupported type 'boolean'/],
  ])('rejects non-string non-Date value %j', (value, message) => {
    expect(() => parseFrontmatterDate(value)).toThrow(message)
  })
})

describe('zonedMidnight', () => {
  it('computes zone-local midnight as a UTC instant', () => {
    expect(zonedMidnight(2025, 1, 31, 'America/New_York').getTime()).toBe(Date.UTC(2025, 0, 31, 5))
    expect(zonedMidnight(2025, 7, 1, 'America/New_York').getTime()).toBe(Date.UTC(2025, 6, 1, 4))
    expect(zonedMidnight(2025, 7, 1, 'UTC').getTime()).toBe(Date.UTC(2025, 6, 1))
    expect(zonedMidnight(2025, 7, 1, 'Asia/Shanghai').getTime()).toBe(Date.UTC(2025, 5, 30, 16))
  })
})
