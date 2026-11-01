/**
 * The content deploy's last step: makes the frontend serve what was just
 * synced, then proves every page renders.
 *
 * 1. Revalidate: the frontend expires its content cache and re-fetches it.
 * 2. A minute later, revalidate again. A page that was rendering while the
 *    sync committed may have read the old rows and stored its result after
 *    the first expiry, where it would stay until the next sync. Frontend
 *    renders give up after about 30 s (its fetcher's deadlines), so by now
 *    any such write has landed, and this expiry removes it.
 * 3. Request every page in the sitemap; anything but a 200 fails the deploy.
 */
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import dotenv from 'dotenv'
import { checkEveryPage, revalidateFrontend } from '../src/frontend.ts'

dotenv.config({ path: '.env.local', quiet: true })

const SECOND_PASS_DELAY_MS = 60_000

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value)
    throw new Error(`[env] Missing required variable: ${name}`)
  return value
}

const frontendUrl = new URL(requireEnv('FRONTEND_URL'))
const secret = requireEnv('REVALIDATION_SECRET')

console.info('[revalidate] Success:', await revalidateFrontend(frontendUrl, secret))

console.info(`[revalidate] Second pass in ${SECOND_PASS_DELAY_MS / 1000} s, after any render that read the old rows has stored its result`)
await sleep(SECOND_PASS_DELAY_MS)
console.info('[revalidate] Success:', await revalidateFrontend(frontendUrl, secret))

const pages = await checkEveryPage(frontendUrl)
console.info(`[check] All ${pages.length} pages answered 200`)
