/**
 * Scaffold a draft post: pnpm new-post "Post title" [category]
 *
 * Writes content/<category>/<slug>.mdx (category defaults to "articles")
 * with today's date in CONTENT_TIME_ZONE and isPublished: false, taking the
 * author from the newest existing post, then parses it with the sync's own
 * parser so the file is valid from the start. A slug any existing post
 * already has, in any category, is refused before anything is written.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { CONTENT_ROOT } from '../src/config.ts'
import { newPostFile, todayInContentTimeZone } from '../src/newPost.ts'
import { parseAllPosts, parseMdxFile } from '../src/parser.ts'

const [title, category = 'articles'] = process.argv.slice(2)
if (title === undefined || title.trim() === '') {
  console.error('Usage: pnpm new-post "Post title" [category]')
  process.exit(2)
}
// a category is one folder name under content/
if (category !== path.basename(category) || category.startsWith('.')) {
  console.error(`[new-post] category "${category}" must be a folder name, not a path`)
  process.exit(2)
}

const posts = parseAllPosts()
const newest = posts.toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
const { slug, text } = newPostFile(
  title.trim(),
  newest?.author ?? '',
  todayInContentTimeZone(),
  new Set(posts.map(post => post.slug)),
)

const filePath = path.join(CONTENT_ROOT, category, `${slug}.mdx`)
if (fs.existsSync(filePath)) {
  console.error(`[new-post] ${path.relative(process.cwd(), filePath)} already exists`)
  process.exit(1)
}

fs.mkdirSync(path.dirname(filePath), { recursive: true })
fs.writeFileSync(filePath, text, { flag: 'wx' })
try {
  parseMdxFile(filePath)
}
catch (err) {
  // never leave a file behind that would fail the next sync and CI
  fs.rmSync(filePath)
  throw err
}
console.info(`[new-post] Created ${path.relative(process.cwd(), filePath)} (unpublished). Set isPublished: true when it is ready.`)
