# ADR-0003: Calendar dates are authored in a configured content time zone

- **Status**: Accepted (2026-07)
- **Repos affected**: tianwei-io-content (parse), tianwei.io (display; see its ADR-0004)

## Context

Frontmatter dates are calendar dates (`createdAt: 2025-10-23`) with no
time component. Two earlier bugs came from leaving their zone implicit:

1. date-fns parsed them at **machine-local** midnight: a laptop in
   Toronto and a UTC CI runner stored different instants for the same file.
2. After normalizing storage to UTC midnight, any renderer that *didn't*
   force UTC display shifted the date a day (Oct 23 00:00Z is Oct 22
   evening in New York).

The author lives in US Eastern time and wants all dates presented in ET.

## Decision

One explicit model, one constant per side:

- **Authoring semantics**: `createdAt: 2025-10-23` means "October 23 in
  `CONTENT_TIME_ZONE`" (`America/New_York`, defined in `src/config.ts`).
  The value must be the string `yyyy-MM-dd` (quoted or not). Frontmatter
  YAML is loaded with js-yaml's `CORE_SCHEMA`, which has no timestamp
  type, so the parser sees the authored text and rejects impossible dates
  such as `2024-02-30` instead of letting YAML roll them over to March 1
  (`FRONTMATTER_OPTIONS` in `src/parser.ts`, `parseFrontmatterDate` in
  `src/date.ts`).
- **Storage**: the UTC **instant** of that zone's midnight (e.g.
  `2025-10-23T04:00:00Z` in EDT, `05:00Z` in EST), computed with
  `Temporal`, which Node ships (`PlainDate.toZonedDateTime`; it handles
  DST transition days). Deterministic on any machine.
- **Display**: the frontend renders every date with its
  `DISPLAY_TIME_ZONE` constant, which MUST equal `CONTENT_TIME_ZONE`.
  With the pair matched, stored instants render back as exactly the
  authored calendar date, in any month of the year.

## Consequences

- Changing the zone means editing both constants **and running a full
  re-sync** (stored instants are derived from the zone at parse time).
- Rollout order matters once: rows stored under the old UTC-midnight
  encoding display one day early in ET, so the content re-sync must
  deploy before (or with) the frontend's ET display change. (Done in the
  2026-07 release.)
- If per-visitor timezone display is ever wanted, storage needs no
  change: instants are unambiguous; only the display constant would
  become a user preference.
