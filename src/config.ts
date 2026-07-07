import path from 'node:path'
import process from 'node:process'

/**
 * Default content directory: /content at the repository root.
 * All parsing entry points accept an explicit root so tests can
 * point at fixture directories instead.
 */
export const CONTENT_ROOT = path.resolve(process.cwd(), 'content')

/**
 * IANA time zone in which frontmatter calendar dates are authored.
 * `createdAt: 2025-10-23` means "October 23 in this zone"; it is stored
 * as the UTC instant of that zone's midnight.
 *
 * MUST match DISPLAY_TIME_ZONE in the tianwei.io frontend — the pairing
 * is what makes stored instants render back as the authored calendar
 * date. Changing either requires a full re-sync. See docs/adr/0003.
 */
export const CONTENT_TIME_ZONE = 'America/New_York'
