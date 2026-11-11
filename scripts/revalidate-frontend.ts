/**
 * The content deploy's last step: makes the frontend serve what was just
 * synced, then proves it does.
 *
 * 1. Revalidate: the frontend reads the content through the API and, only
 *    if every read worked, expires its content cache.
 * 2. A minute later, revalidate again. A page that was rendering while the
 *    sync committed may have read the old rows and stored its result after
 *    the first expiry, where it would stay until the next sync. Such a
 *    render ends within about 40 s of the sync: a page reads the API in
 *    two steps at most (a post page: the list, then the post), the read in
 *    flight returns within its 10 s attempt, and the step after it gives
 *    up after about 30 s (the frontend fetcher's deadlines). So by now any
 *    such write has landed, and this expiry removes it.
 * 3. Reconcile: every page answers, and each post page reports the hash of
 *    the body synced here (src/frontend.ts reconcile). A page that failed
 *    to render keeps serving its previous version with a 200, so only the
 *    hash shows that a change did not go live.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { loadLocalEnv, requireEnv } from '../src/env.ts'
import { frontendFromEnv, reconcile, revalidateFrontend } from '../src/frontend.ts'

loadLocalEnv()

const SECOND_PASS_DELAY_MS = 60_000

const frontend = frontendFromEnv()
const secret = requireEnv('REVALIDATION_SECRET')
console.info(`[revalidate] Frontend: ${frontend.url.origin}`)

console.info('[revalidate] Success:', await revalidateFrontend(frontend, secret))

console.info(`[revalidate] Second pass in ${SECOND_PASS_DELAY_MS / 1000} s, after any render that read the old rows has stored its result`)
await sleep(SECOND_PASS_DELAY_MS)
console.info('[revalidate] Success:', await revalidateFrontend(frontend, secret))

const checked = await reconcile(frontend)
console.info(`[reconcile] All ${checked} requests answered as expected; every post page shows the synced body`)
