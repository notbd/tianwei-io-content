import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import dotenv from 'dotenv'

/**
 * Load .env.local into process.env (variables already set win). Every entry
 * point that reads the file goes through here.
 *
 * DATABASE_URL comes only from the process environment: the deploy's
 * secret, or `DATABASE_URL=... pnpm sync:prod` typed for one command. A
 * file that sets it is refused. Local development never reads the
 * variable, but `pnpm db:migrate` and `pnpm sync:prod` do, and with the
 * URL in this file they would use that database without being told to. A
 * .env next to it is refused the same way: nothing here loads it, but
 * drizzle-kit does by itself.
 *
 * Synchronous on purpose: drizzle-kit loads drizzle.config.ts through a
 * require hook, where top-level await is not available.
 */
export function loadLocalEnv(file = '.env.local'): void {
  // read only for the refusal: nothing from .env is loaded here
  readRefusingDatabaseUrl(
    path.join(path.dirname(file), '.env'),
    'drizzle-kit loads that file by itself, so pnpm db:migrate would migrate that database without being told to.',
  )
  dotenv.populate(process.env, readRefusingDatabaseUrl(
    file,
    'The migration and the sync read that file, so pnpm db:migrate and pnpm sync:prod would use that database without being told to.',
  ))
}

/**
 * The file's variables, none without the file. Throws if it sets
 * DATABASE_URL; `risk` says what would happen otherwise, for the message.
 */
function readRefusingDatabaseUrl(file: string, risk: string): Record<string, string> {
  if (!fs.existsSync(file))
    return {}
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
