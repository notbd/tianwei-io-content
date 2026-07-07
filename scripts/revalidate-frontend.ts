import process from 'node:process'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local', quiet: true })

const FRONTEND_URL = process.env.FRONTEND_URL
const REVALIDATION_SECRET = process.env.REVALIDATION_SECRET

function assertEnv(name: string, value: string | undefined) {
  if (!value) {
    throw new Error(`[env] Missing required variable: ${name}`)
  }
}

async function triggerRevalidation(frontend: URL, secret: string) {
  const endpoint = new URL('/api/revalidate', frontend)

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${secret}`,
    },
    body: JSON.stringify({ tags: ['posts'] }),
    // a hung frontend must fail the deploy step, not stall it for minutes
    signal: AbortSignal.timeout(60_000),
  })

  const rawBody = await response.text()

  if (!response.ok) {
    throw new Error(`[revalidate] Failed (${response.status}): ${rawBody}`)
  }

  let payload: { success?: boolean, error?: string }
  try {
    payload = JSON.parse(rawBody) as { success?: boolean, error?: string }
  }
  catch {
    // e.g. a proxy/CDN HTML error page with a 2xx status
    throw new Error(`[revalidate] Non-JSON response (${response.status}) from ${endpoint}: ${rawBody.slice(0, 300)}`)
  }

  // A 207 Multi-Status (revalidated but warming failed) counts as ok by
  // response.ok — check the payload so a cold cache fails the deploy loudly.
  if (payload.success !== true) {
    throw new Error(`[revalidate] Partial failure (${response.status}): ${JSON.stringify(payload)}`)
  }

  console.info('[revalidate] Success:', payload)
}

async function main() {
  assertEnv('FRONTEND_URL', FRONTEND_URL)
  assertEnv('REVALIDATION_SECRET', REVALIDATION_SECRET)

  const frontendUrl = new URL(FRONTEND_URL!)
  await triggerRevalidation(frontendUrl, REVALIDATION_SECRET!)

  console.info('[revalidate] Completed.')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
