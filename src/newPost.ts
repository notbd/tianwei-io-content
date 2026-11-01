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
 * otherwise.
 */
export function newPostFile(title: string, author: string, today: string): { slug: string, text: string } {
  const slug = slugify(title)
  if (slug === '')
    throw new Error(`[new-post] "${title}" has no letters or digits to build a slug from`)

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
