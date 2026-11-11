import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import dotenv from 'dotenv'

/**
 * Load .env.local into process.env (variables already set win). Every entry
 * point that reads the file goes through here: drizzle.config.ts and the
 * scripts.
 *
 * DATABASE_URL comes only from the process environment: the deploy's
 * secret, or `DATABASE_URL=... pnpm sync:prod` typed for one command. A
 * file that sets it is refused, because the migration and the sync read
 * this file: `pnpm dev:up` would migrate that database and the watcher
 * would write every save to it. A .env next to it is refused the same way:
 * nothing here loads it, but drizzle-kit does by itself.
 *
 * Synchronous on purpose: drizzle-kit loads drizzle.config.ts through a
 * require hook, where top-level await is not available.
 */
export function loadLocalEnv(file = '.env.local'): void {
  parseEnvFile(
    path.join(path.dirname(file), '.env'),
    'drizzle-kit loads that file by itself, so pnpm dev:up would migrate that database.',
  )
  const values = parseEnvFile(
    file,
    'The migration and the sync read that file, so pnpm dev:up would migrate that database and write every save to it.',
  )
  if (values !== undefined)
    dotenv.populate(process.env, values)
}

/**
 * The file's variables, or undefined without the file. Throws if it sets
 * DATABASE_URL; `risk` says what would happen otherwise, for the message.
 */
function parseEnvFile(file: string, risk: string) {
  if (!fs.existsSync(file))
    return undefined
  const values = dotenv.parse(fs.readFileSync(file))
  if ('DATABASE_URL' in values) {
    throw new Error(
      `[env] ${file} sets DATABASE_URL. ${risk} Delete the line and pass the URL for one command `
      + 'instead: DATABASE_URL=... pnpm sync:prod',
    )
  }
  return values
}

/** A variable's value; set but empty counts as unset. */
export function readEnv(name: string): string | undefined {
  const value = process.env[name]
  return value === ''
    ? undefined
    : value
}

/** The value of a variable that must be set and non-empty. */
export function requireEnv(name: string): string {
  const value = readEnv(name)
  if (value === undefined)
    throw new Error(`[env] Missing required variable: ${name} (see .env.example)`)
  return value
}
