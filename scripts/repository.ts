import type { ContentRecord } from './types.ts'
import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '@/drizzle/db.ts'
import { posts } from '@/drizzle/schema.ts'
import { parseAllPosts, parseMdxFile, validateMdxFileStructure } from './parser.ts'

/**
 * Validate file structure and upsert the post if valid.
 */
export async function handleUpsert(filePath: string, quiet: boolean = false) {
  const structure = validateMdxFileStructure(filePath)
  if (!structure) {
    console.error(`[repo] Skipping upsert: invalid structure for "${filePath}"`)
    return
  }

  try {
    if (!fs.existsSync(filePath)) {
      console.error(`[repo] Skipping upsert: file missing "${filePath}"`)
      return
    }

    const post = parseMdxFile(filePath)

    if (post) {
      await upsertPost(post, quiet)
    }
  }
  catch (err) {
    throw new Error(`[repo] Failed to handle upsert for "${filePath}" \n${(err as Error).message}`)
  }
}

/**
 * Validate file structure and delete post by slug if valid.
 */
export async function handleDelete(filePath: string, quiet: boolean = false) {
  const structure = validateMdxFileStructure(filePath)
  if (!structure) {
    console.error(`[repo] Error: invalid structure for "${filePath}"`)
    return
  }

  const { slug } = structure

  try {
    await deletePostBySlug(slug, quiet)
  }
  catch (err) {
    throw new Error(`[repo] Failed to handle delete for "${filePath}" \n${(err as Error).message}`)
  }
}

/**
 * Insert or update a content record in the posts table.
 */
async function upsertPost(post: ContentRecord, quiet: boolean = false) {
  await db
    .insert(posts)
    .values({
      slug: post.slug,
      category: post.category,
      title: post.title,
      description: post.description,
      author: post.author,
      createdAt: post.createdAt,
      isPublished: post.isPublished,
      content: post.content,
    })
    .onConflictDoUpdate({
      target: posts.slug,
      set: {
        category: post.category,
        title: post.title,
        description: post.description,
        author: post.author,
        createdAt: post.createdAt,
        isPublished: post.isPublished,
        content: post.content,
      },
    })

  if (!quiet) {
    console.info(`[repo] Upserted post "${post.slug}"`)
  }
}

/**
 * Deletes the record corresponding to the given slug.
 */
async function deletePostBySlug(slug: string, quiet: boolean = false) {
  await db.delete(posts).where(eq(posts.slug, slug))

  if (!quiet) {
    console.info(`[repo] Deleted post "${slug}"`)
  }
}

/**
 * Removes all rows from the posts table.
 */
export async function clearAllPosts(quiet: boolean = false) {
  await db.delete(posts)

  if (!quiet) {
    console.info('[repo] Cleared posts table')
  }
}

/**
 * Parses and adds all posts from the /content directory to the database.
 * Returns the number of posts added.
 */
export async function addAllPosts(quiet: boolean = false) {
  const allPosts = parseAllPosts()
  for (const post of allPosts) {
    await upsertPost(post, true)
  }

  if (!quiet) {
    console.info(`[repo] Added ${allPosts.length} posts to the database`)
  }

  return allPosts.length
}
