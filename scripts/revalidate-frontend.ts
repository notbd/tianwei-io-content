/**
 * The content deploy's last step: makes the frontend serve what was just
 * synced, then proves every page renders.
 *
 * 1. Revalidate: the frontend reads the content through the API and, only
 *    if every read worked, expires its content cache.
 * 2. A minute later, revalidate again. A page that was rendering while the
 *    sync committed may have read the old rows and stored its result after
 *    the first expiry, where it would stay until the next sync. Frontend
 *    renders give up after about 30 s (its fetcher's deadlines), so by now
 *    any such write has landed, and this expiry removes it.
 * 3. Request every page in the sitemap; anything but a 200 fails the deploy,
 *    so a page that does not render is reported at once.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { loadLocalEnv, requireEnv } from '../src/env.ts'
import { checkEveryPage, frontendFromEnv, revalidateFrontend } from '../src/frontend.ts'

loadLocalEnv()

const SECOND_PASS_DELAY_MS = 60_000

const frontend = frontendFromEnv()
const secret = requireEnv('REVALIDATION_SECRET')
console.info(`[revalidate] Frontend: ${frontend.url.origin}`)

console.info('[revalidate] Success:', await revalidateFrontend(frontend, secret))

console.info(`[revalidate] Second pass in ${SECOND_PASS_DELAY_MS / 1000} s, after any render that read the old rows has stored its result`)
await sleep(SECOND_PASS_DELAY_MS)
console.info('[revalidate] Success:', await revalidateFrontend(frontend, secret))

const pages = await checkEveryPage(frontend)
console.info(`[check] All ${pages.length} pages answered 200`)
