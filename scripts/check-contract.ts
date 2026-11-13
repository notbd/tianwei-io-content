/**
 * Check every post against the frontend's /contract.json: pnpm check:contract
 *
 * Fails, naming file and line, on anything the frontend could not render:
 * a component it does not have, an attribute its schema refuses, and the
 * rest of the parser's five steps. A frontend with no contract to give
 * (404, network error) is a warning by default, since a PR check is early
 * feedback; with --require, as in the deploy before the migration, it fails.
 */
import process from 'node:process'
import { checkContent, ContractUnavailableError, fetchContract } from '../src/contract.ts'
import { loadLocalEnv } from '../src/env.ts'
import { messageOf } from '../src/errors.ts'
import { frontendFromEnv } from '../src/frontend.ts'

loadLocalEnv()

const frontend = frontendFromEnv()
console.info(`[contract] Frontend: ${frontend.origin}`)

try {
  const contract = await fetchContract(frontend)
  const records = checkContent(contract)
  console.info(`[contract] All ${records.length} posts (drafts included) match the contract`)
}
catch (err) {
  if (err instanceof ContractUnavailableError && !process.argv.includes('--require')) {
    console.warn(`${err.message}; skipping the contract check (pass --require to fail instead)`)
  }
  else {
    console.error(messageOf(err))
    process.exitCode = 1
  }
}
