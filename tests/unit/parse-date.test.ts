import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTENT_TIME_ZONE } from '../../src/config.ts'
import { parseFrontmatterDate, zonedMidnight } from '../../src/date.ts'

afterEach(() => {
  vi.unstubAllEnvs()
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
    // spring-forward day: midnight is still EST
    [
      '2025-03-09',
      Date.UTC(2025, 2, 9, 5),
    ],
    // fall-back day: midnight is still EDT
    [
      '2025-11-02',
      Date.UTC(2025, 10, 2, 4),
    ],
  ])('handles the DST transition day %s', (value, expected) => {
    const parsed = parseFrontmatterDate(value)
    expect(parsed.getTime()).toBe(expected)
    expect(calendarDateInContentZone(parsed)).toBe(value)
  })

  it('is deterministic across machine timezones', () => {
    // The historical bug: date-fns parse(value, 'yyyy-MM-dd', new Date())
    // produced machine-local midnight, so a laptop in Toronto and a UTC CI
    // runner wrote different timestamps for the same file.
    const timezones = [
      'UTC',
      'America/New_York',
      'Asia/Shanghai',
      'Pacific/Kiritimati',
    ]
    const results = timezones.map((tz) => {
      vi.stubEnv('TZ', tz)
      return parseFrontmatterDate('2025-01-31').getTime()
    })
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBe(Date.UTC(2025, 0, 31, 5))
  })

  it('trims surrounding whitespace', () => {
    expect(parseFrontmatterDate(' 2024-06-15 ').getTime()).toBe(Date.UTC(2024, 5, 15, 4))
  })

  it.each([
    '2024/06/15',
    '15-06-2024',
    '2024-6-5',
    '2024-06-15T10:00:00Z',
    // a YAML timestamp: truncating it to a calendar date could shift the day
    '2024-01-05 23:00:00-05:00',
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
    [
      new Date(Date.UTC(2025, 9, 23)),
      /Unsupported type 'object'/,
    ],
  ])('rejects non-string value %j', (value, message) => {
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
