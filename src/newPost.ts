import slugify from '@sindresorhus/slugify'
import { CONTENT_TIME_ZONE } from './config.ts'

/** Today's calendar date where posts are authored, as frontmatter wants it ('yyyy-MM-dd'). */
export function todayInContentTimeZone(now: Date = new Date()): string {
  // en-CA formats dates as yyyy-mm-dd
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONTENT_TIME_ZONE }).format(now)
}

/**
 * The file for a new draft: its slug (the filename the parser will derive)
 * and frontmatter that passes the parser, unpublished until the author says
 * otherwise. `takenSlugs` holds every existing post's slug, drafts included:
 * the sync keys posts on the slug across all categories, so a second file
 * with it would fail the next sync.
 */
export function newPostFile(title: string, author: string, today: string, takenSlugs: ReadonlySet<string>): { slug: string, text: string } {
  const slug = slugify(title)
  if (slug === '')
    throw new Error(`[new-post] "${title}" has no letters or digits to build a slug from`)
  // the slug column is varchar(200), which the parser enforces too
  if (slug.length > 200)
    throw new Error(`[new-post] "${title}" makes a ${slug.length}-character slug (max 200); shorten the title`)
  if (takenSlugs.has(slug))
    throw new Error(`[new-post] a post with the slug "${slug}" already exists (slugs are unique across categories, drafts included); choose another title`)

  const text = [
    '---',
    `title: ${JSON.stringify(title)}`,
    '# description: "One sentence for the post list, the feed and link previews."',
    `createdAt: ${today}`,
    '# updatedAt: yyyy-MM-dd',
    `author: ${JSON.stringify(author)}`,
    'isPublished: false',
    '---',
    '',
    'Start writing here.',
    '',
  ].join('\n')

  return { slug, text }
}
