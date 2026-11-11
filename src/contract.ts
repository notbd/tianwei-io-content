/**
 * The frontend's /contract.json: what it can render, published so the
 * content can be checked against it before anything is written. The PR
 * check and the deploy's gate both run `pnpm check:contract`.
 */
import type { ComponentRules } from './parser.ts'
import type { ContentRecord } from './types.ts'
import { z } from 'zod'
import { CONTENT_ROOT, CONTENT_TIME_ZONE } from './config.ts'
import { messageOf } from './errors.ts'
import { REQUEST_TIMEOUT_MS } from './frontend.ts'
import { parseAllPosts } from './parser.ts'

const CONTRACT_PATH = '/contract.json'

// Only the keys this engine knows: z.object drops the rest, so the
// frontend may add keys without breaking older content deploys.
const contractShape = z.object({
  timeZone: z.string(),
  mdx: z.object({
    components: z.record(z.string(), z.object({
      // JSON Schema of the component's attributes, as the frontend's zod
      // schema exported it; z.fromJSONSchema turns it back into a validator
      attributes: z.record(z.string(), z.unknown()),
      children: z.boolean(),
    })),
  }),
})

export type Contract = {
  timeZone: string
  components: ComponentRules
}

/** Read a /contract.json document into the rules the parser applies. */
export function readContract(json: unknown): Contract {
  const { timeZone, mdx } = contractShape.parse(json)
  return {
    timeZone,
    components: new Map(Object.entries(mdx.components).map(([name, { attributes, children }]) => [
      name,
      {
        attributes: z.fromJSONSchema(attributes),
        children,
      },
    ])),
  }
}

/**
 * The frontend has no contract to give: a 404 (a frontend from before the
 * contract existed) or a network error. A PR check skips on this; the
 * deploy's gate fails.
 */
export class ContractUnavailableError extends Error {}

/** GET /contract.json from the frontend. */
export async function fetchContract(frontend: URL): Promise<Contract> {
  const url = new URL(CONTRACT_PATH, frontend)
  let response: Response
  let body: string
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    body = await response.text()
  }
  catch (err) {
    throw new ContractUnavailableError(`[contract] ${url.href} could not be fetched: ${messageOf(err)}`)
  }
  if (response.status === 404)
    throw new ContractUnavailableError(`[contract] ${url.href} answered 404`)
  if (!response.ok)
    throw new Error(`[contract] ${url.href} answered ${response.status}: ${body.slice(0, 300)}`)

  try {
    return readContract(JSON.parse(body))
  }
  catch (err) {
    throw new Error(`[contract] ${url.href} is not a contract this engine can read: ${messageOf(err)}`)
  }
}

/**
 * Hold the content to the contract: the time zone dates are anchored to
 * (ADR-0003), and every post, drafts included (they are synced and the
 * draft preview renders them too), through the parser's five steps. Throws
 * one error listing every problem with its file and line.
 */
export function checkContent(contract: Contract, contentRoot: string = CONTENT_ROOT): ContentRecord[] {
  const errors: string[] = []
  if (contract.timeZone !== CONTENT_TIME_ZONE)
    errors.push(`[contract] the frontend displays dates in ${contract.timeZone}, but CONTENT_TIME_ZONE is ${CONTENT_TIME_ZONE} (see docs/adr/0003)`)

  let records: ContentRecord[] = []
  try {
    records = parseAllPosts(contentRoot, contract.components)
  }
  catch (err) {
    errors.push(messageOf(err))
  }

  if (errors.length > 0)
    throw new Error(errors.join('\n'))
  return records
}
