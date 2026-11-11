import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLocalEnv, requireEnv } from '../../src/env.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tio-env-'))
  vi.stubEnv('DATABASE_URL', undefined)
  vi.stubEnv('TIO_TEST_FROM_FILE', undefined)
  vi.stubEnv('TIO_TEST_FROM_SHELL', 'shell')
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

function envFile(text: string): string {
  const file = path.join(dir, '.env.local')
  fs.writeFileSync(file, text)
  return file
}

describe('loadLocalEnv', () => {
  it('refuses a file that sets DATABASE_URL, before loading anything from it', () => {
    const file = envFile('TIO_TEST_FROM_FILE=file\nDATABASE_URL=postgresql://x:y@127.0.0.1:9/z\n')
    expect(() => loadLocalEnv(file)).toThrow(/sets DATABASE_URL.*DATABASE_URL=\.\.\. pnpm sync:prod/s)
    expect(process.env.DATABASE_URL).toBeUndefined()
    expect(process.env.TIO_TEST_FROM_FILE).toBeUndefined()
  })

  it('refuses the key even with an empty value', () => {
    expect(() => loadLocalEnv(envFile('DATABASE_URL=\n'))).toThrow(/sets DATABASE_URL/)
  })

  it('refuses a .env next to it that sets DATABASE_URL, which drizzle-kit would load by itself', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgresql://x:y@127.0.0.1:9/z\n')
    const file = envFile('TIO_TEST_FROM_FILE=file\n')
    expect(() => loadLocalEnv(file)).toThrow(/\.env sets DATABASE_URL/)
    expect(process.env.TIO_TEST_FROM_FILE).toBeUndefined()
  })

  it('loads the other keys, and the shell environment wins', () => {
    loadLocalEnv(envFile('TIO_TEST_FROM_FILE=file\nTIO_TEST_FROM_SHELL=file\n'))
    expect(process.env.TIO_TEST_FROM_FILE).toBe('file')
    expect(process.env.TIO_TEST_FROM_SHELL).toBe('shell')
  })

  it('does nothing without a file', () => {
    expect(() => loadLocalEnv(path.join(dir, 'missing'))).not.toThrow()
  })
})

describe('requireEnv', () => {
  it('names the missing variable', () => {
    expect(requireEnv('TIO_TEST_FROM_SHELL')).toBe('shell')
    expect(() => requireEnv('DATABASE_URL')).toThrow('[env] Missing required variable: DATABASE_URL')
  })
})
