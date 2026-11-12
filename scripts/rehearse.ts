/**
 * A rehearsal of a release, on this machine: pnpm rehearse [--keep]
 *
 * Starts the three checkouts as they are (this one, the API's and the
 * frontend's: ../tianwei-io-api and ../tianwei.io unless API_DIR and
 * WEB_DIR name others, dependencies installed), wires them to each other
 * and to nothing else, and plays the deploy against them: contract check,
 * sync, revalidate, reconcile, and the failures the deploy must catch.
 *
 * It cannot reach production. The database is in this process, and the
 * three services listen on 127.0.0.1, on ports it picks itself; both
 * secrets are made up for the run. It does not read FRONTEND_URL or
 * REVALIDATION_SECRET and loads no .env.local. The API gets its two
 * per-run values through `wrangler dev --var` and an empty --env-file, so
 * no key of a .dev.vars in that checkout comes in; everything else is
 * wrangler.jsonc's `vars`, the production configuration.
 *
 * What it changes: posts only in a temporary copy; WEB_DIR's production
 * build (`next build` runs there, after .next/cache/fetch-cache is
 * removed, since with that cache a build reads nothing from the API).
 * From its start until it holds (--keep) or ends, nothing else may use
 * WEB_DIR's .next: a `next start` there reads the files this replaces.
 * A lock in WEB_DIR/.next/cache keeps a second rehearsal out, and only
 * that; it does not look for other processes.
 *
 * Stopping: SIGINT, SIGTERM and SIGHUP only ask for a stop. Everything
 * the run holds is released in one place, the `finally` of the outermost
 * `try`, in the reverse order it was taken, with one exception: the
 * build's process group is released as soon as the build ends, since its
 * number may be given to another process while the stack is held. A step
 * that calls the deploy's own functions (sync, contract check, revalidate,
 * reconcile) is not interrupted; the stop takes effect when it returns.
 *
 * --keep holds the stack after every scenario passed, and prints its
 * addresses and secrets, until interrupted.
 */
import type { ChildProcess } from 'node:child_process'
import type { Server } from 'node:http'
import type { ContentRecord } from '../src/types.ts'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { CONTENT_ROOT } from '../src/config.ts'
import { checkContent, fetchContract } from '../src/contract.ts'
import { readEnv } from '../src/env.ts'
import { messageOf } from '../src/errors.ts'
import { postBodyHash, postBodyHashesIn, reconcile, revalidateFrontend } from '../src/frontend.ts'
import { openLocalDb, serveNeonHttp } from '../src/localDb.ts'
import { parseAllPosts, parseMdxFile } from '../src/parser.ts'
import { syncPosts } from '../src/sync.ts'

// Every wait has a limit. The build's is generous: under load it is slow.
const BUILD_TIMEOUT_MS = 10 * 60_000
const READY_TIMEOUT_MS = 3 * 60_000
const REQUEST_TIMEOUT_MS = 30_000
const POLL_MS = 500
const GROUP_TERM_WAIT_MS = 5_000
const GROUP_KILL_WAIT_MS = 30_000
const EXIT_EVENT_WAIT_MS = 5_000
const LOG_TAIL_LINES = 50
const RECONCILE_ROUND_DELAY_MS = 1_000

const keep = process.argv.includes('--keep')
const apiDir = path.resolve(readEnv('API_DIR') ?? '../tianwei-io-api')
const webDir = path.resolve(readEnv('WEB_DIR') ?? '../tianwei.io')
const lockPath = path.join(webDir, '.next/cache/rehearse.lock')

const say = (line: string) => console.info(`[rehearse] ${line}`)

// --------------------------------------------------------------------------
// Stopping and cleaning up
// --------------------------------------------------------------------------

// A stop request is this controller being aborted; there is no other flag.
// The first reason is the one reported.
const stopping = new AbortController()
function requestStop(reason: string): void {
  if (!stopping.signal.aborted)
    stopping.abort(reason)
}

/** Thrown through the main flow once a stop was requested. */
function stopIfRequested(): void {
  if (stopping.signal.aborted)
    throw new Error(String(stopping.signal.reason))
}

/** What the run holds, in the order it was taken; released in reverse. */
const held: { what: string, release: () => Promise<void> | void }[] = []
/** What the main flow is doing, for the line a signal prints. */
let step = 'starting'
/** The signal that asked for the stop, when a signal was the first to ask. */
let interruptedBy: NodeJS.Signals | undefined
/** A process group outlived SIGKILL: the lock stays, since the group may still use WEB_DIR's .next. */
let groupLeftBehind = false

// A closed terminal makes writes to these fail later, as an event: with
// no listener that is an uncaught exception in the middle of the cleanup.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

// `on`, not `once`: through pnpm one Ctrl-C arrives twice (the terminal's
// and pnpm's own), and a second signal without a listener would end the
// process on the spot. SIGHUP is a closed terminal; the children have
// their own process groups and would be left behind.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (stopping.signal.aborted)
      return
    interruptedBy = signal
    say(`Received ${signal} while ${step}; stopping`)
    requestStop(`received ${signal}`)
  })
}

// --------------------------------------------------------------------------
// The lock
// --------------------------------------------------------------------------

/** Appends a line to the lock, so a later run can say what this one left. */
function note(line: string): void {
  fs.appendFileSync(lockPath, `${line}\n`)
}

/**
 * The lock exists: say whose it is and what to do, and take nothing. It
 * looks at one thing, whether the pid in the lock exists; what that pid
 * and the recorded groups are is for a person to check, with the commands
 * printed.
 */
function refuse(): void {
  let text = ''
  try {
    text = fs.readFileSync(lockPath, 'utf8')
  }
  catch (err) {
    say(`The lock could not be read: ${messageOf(err)}`)
  }
  // Nothing but a positive number counts: an empty lock would read as 0,
  // and `kill -INT 0` signals the caller's own process group.
  const pid = /^pid ([1-9]\d*)$/m.exec(text)?.[1]
  say(`Refused: ${lockPath} exists.`)
  if (pid === undefined) {
    say('The lock records no pid that can be read: it was left behind.')
  }
  else if (exists(Number(pid))) {
    say(`pid ${pid} is running. If it is a rehearsal (\`ps -o args= -p ${pid}\` shows scripts/rehearse.ts), wait for it to end or stop it with \`kill -INT ${pid}\`; it cleans up after itself. Or point WEB_DIR at another checkout.`)
    say('Only if it is not a rehearsal (the system reuses pids) was the lock left behind. Then, and only then, follow the steps below.')
  }
  else {
    say(`pid ${pid} is gone: the lock was left behind.`)
  }
  say('What the lock records:')
  for (const line of text.split('\n').filter(line => line !== ''))
    say(`  ${line}`)
  say('To clean up after a rehearsal that is gone:')
  say('  1. For each "group <n>" above without a "released <n>": run `ps -o pid,args -g <n>`. If it lists the rehearsal\'s processes (next, wrangler, workerd), run `kill -TERM -- -<n>`, and `kill -KILL -- -<n>` if they stay. If it lists anything else, leave that group alone: the system reuses the numbers.')
  say('  2. Delete the "tmp" directory.')
  say(`  3. Delete ${lockPath} and run again.`)
}

/** The code of a system error (ESRCH, EEXIST), if `err` has one. */
function errorCode(err: unknown): unknown {
  return err instanceof Error && 'code' in err
    ? err.code
    : undefined
}

/** Whether a process (its pid) or a process group (its number, negated) exists. */
function exists(id: number): boolean {
  try {
    process.kill(id, 0)
    return true
  }
  catch (err) {
    // ESRCH: no such process. Anything else (EPERM): it exists.
    return errorCode(err) !== 'ESRCH'
  }
}

// --------------------------------------------------------------------------
// Child processes
// --------------------------------------------------------------------------

type Child = {
  name: string
  process: ChildProcess
  /** its process group: it is started detached, so the group is its pid */
  group: number
  /** the last LOG_TAIL_LINES lines it printed, kept in memory only */
  tail: string[]
  /** how it ended, once it has */
  ended?: string
  /** true for the build, which ends by itself */
  endsByItself: boolean
}

const children: Child[] = []

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null
    ? `exit code ${code}`
    : `signal ${signal}`
}

/**
 * Starts a child in its own process group and holds it. Its three `error` sources (the process and its two output
 * streams, which are separate objects) get their listeners in the turn it
 * is spawned: a command that does not exist reports that one turn later,
 * and an error nobody listens to is an uncaught exception.
 */
function start(name: string, cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv, endsByItself = false): Child {
  const spawned = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  spawned.on('error', err => requestStop(`the ${name} process failed: ${messageOf(err)}`))
  spawned.stdout.on('error', err => requestStop(`the standard output of ${name} failed: ${messageOf(err)}`))
  spawned.stderr.on('error', err => requestStop(`the standard error of ${name} failed: ${messageOf(err)}`))
  if (spawned.pid === undefined) {
    // nothing to hold: it never ran
    requestStop(`${name} could not start (${command} in ${cwd})`)
    throw new Error(String(stopping.signal.reason))
  }
  const child: Child = {
    name,
    process: spawned,
    group: spawned.pid,
    tail: [],
    endsByItself,
  }

  held.push({
    what: name,
    release: async () => stopGroup(child),
  })
  children.push(child)
  note(`group ${child.group} ${name}`)
  say(`Started ${name}: pid ${child.group}, process group ${child.group}`)

  // Lines are cut here, not by readline: its Interface re-emits the
  // stream's errors from itself, one more object to listen on.
  for (const stream of [spawned.stdout, spawned.stderr]) {
    stream.setEncoding('utf8')
    let partial = ''
    const keepLine = (line: string) => {
      child.tail.push(line)
      if (child.tail.length > LOG_TAIL_LINES)
        child.tail.shift()
    }
    stream.on('data', (chunk: string) => {
      const lines = (partial + chunk).split('\n')
      // the last piece is an unfinished line until the next chunk says otherwise
      partial = lines.pop() ?? ''
      lines.forEach(keepLine)
    })
    stream.on('end', () => {
      if (partial !== '')
        keepLine(partial)
    })
  }

  spawned.on('exit', (code, signal) => {
    child.ended = describeExit(code, signal)
    // The build's end is judged where the build is awaited. An end during
    // the cleanup asks for a stop too, which nobody reads by then.
    if (!endsByItself)
      requestStop(`${name} ended unexpectedly (${child.ended})`)
  })
  return child
}

/** Whether the group is gone within `ms`. Not interruptible: this is the cleanup's own wait. */
async function groupGone(group: number, ms: number): Promise<boolean> {
  for (const end = performance.now() + ms; performance.now() < end;) {
    if (!exists(-group))
      return true
    await sleep(100)
  }
  return !exists(-group)
}

/** Signals a whole group; one that ended since it was last looked at is not an error. */
function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal)
  }
  catch (err) {
    if (errorCode(err) !== 'ESRCH')
      throw err
  }
}

/** Ends a child's whole group, the leader's descendants included, and says what it took. */
async function stopGroup(child: Child): Promise<void> {
  let sent = 'no signal (its group had already ended)'
  if (exists(-child.group)) {
    signalGroup(child.group, 'SIGTERM')
    sent = 'TERM'
    if (!await groupGone(child.group, GROUP_TERM_WAIT_MS)) {
      signalGroup(child.group, 'SIGKILL')
      sent = 'TERM, then KILL'
      if (!await groupGone(child.group, GROUP_KILL_WAIT_MS)) {
        groupLeftBehind = true
        throw new Error(`process group ${child.group} is still there after SIGKILL`)
      }
    }
  }
  // the exit event may come a moment after the group is gone
  for (const end = performance.now() + EXIT_EVENT_WAIT_MS; child.ended === undefined && performance.now() < end;)
    await sleep(50)
  say(`Stopped ${child.name}: sent ${sent} to process group ${child.group}; it ended with ${child.ended ?? 'no exit reported yet'}`)
}

/** Stops one child now, ahead of the cleanup, and takes it off `held`. */
async function releaseEarly(child: Child): Promise<void> {
  const index = held.findIndex(entry => entry.what === child.name)
  if (index !== -1)
    held.splice(index, 1)
  await stopGroup(child)
  // the lock still lists the group: a later refusal must not send anyone after its number
  note(`released ${child.group}`)
}

/** How the child ended. Interrupted by a stop request; fails after `ms`. */
async function ended(child: Child, ms: number): Promise<string> {
  for (const end = performance.now() + ms; child.ended === undefined;) {
    if (performance.now() >= end)
      throw new Error(`${child.name} did not end within ${ms / 1000} s`)
    await sleep(POLL_MS, undefined, { signal: stopping.signal })
  }
  return child.ended
}

// --------------------------------------------------------------------------
// Ports and requests
// --------------------------------------------------------------------------

/**
 * A port free on 127.0.0.1 right now. The temporary server is this
 * function's own: it closes it before it returns and holds nothing. If
 * another process takes the port before the child binds it, the child
 * ends and the run fails; it never mistakes that process for its own,
 * because both bind the same address.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const temporary = createServer()
    // before listen(): a failure fails this step; it never listened, so nothing to close
    temporary.on('error', reject)
    temporary.listen(0, '127.0.0.1', () => {
      const address = temporary.address()
      temporary.close(() => {
        if (typeof address === 'object' && address !== null)
          resolve(address.port)
        else
          reject(new Error('The temporary server has no port'))
      })
    })
  })
}

/** A GET of the rehearsal's own, ended by a stop request or its limit. */
async function get(url: URL | string): Promise<{ status: number, body: string }> {
  const response = await fetch(url, {
    signal: AbortSignal.any([
      stopping.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]),
  })
  return { status: response.status, body: await response.text() }
}

/**
 * Waits until `isReady` answers true. That only says a service is up on
 * the port; that it is this run's is given by the child binding the port
 * itself and by its end being watched all along (it requests a stop).
 */
async function ready(what: string, isReady: () => Promise<boolean>): Promise<void> {
  for (const end = performance.now() + READY_TIMEOUT_MS; ;) {
    stopIfRequested()
    try {
      if (await isReady())
        return
    }
    catch {
      // not up yet, or the stop request ended the request: the loop's head tells
    }
    stopIfRequested()
    if (performance.now() >= end)
      throw new Error(`${what} was not ready within ${READY_TIMEOUT_MS / 1000} s`)
    await sleep(POLL_MS, undefined, { signal: stopping.signal })
  }
}

// --------------------------------------------------------------------------
// The run
// --------------------------------------------------------------------------

/** The error of a step that must fail; any step that passes instead fails the run. */
async function failureOf(what: string, run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  }
  catch (err) {
    // the steps that must fail run the deploy's own code, which takes no
    // abort signal: a stop that came meanwhile takes effect here
    stopIfRequested()
    return messageOf(err)
  }
  throw new Error(`${what} passed, but it must fail`)
}

function expectEqual(what: string, actual: unknown, expected: unknown): void {
  if (actual !== expected)
    throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`)
}

async function run(temporary: string): Promise<void> {
  step = 'opening the local database'
  // a resource being acquired is not interrupted: it is delivered, held, and only then is the stop looked at
  const { db, client } = await openLocalDb()
  held.push({
    what: 'the local database',
    release: async () => client.close(),
  })
  stopIfRequested()

  // the posts, in a copy: the scenarios edit them
  const contentRoot = path.join(temporary, 'content')
  fs.cpSync(CONTENT_ROOT, contentRoot, { recursive: true })
  const frontmatter = (title: string, isPublished: boolean) => `---\ntitle: ${title}\ncreatedAt: 2026-01-01\nauthor: Rehearsal\nisPublished: ${isPublished}\n---\n\n`
  const draftSlug = 'rehearsal-draft'
  const newSlug = 'rehearsal-new-post'
  fs.mkdirSync(path.join(contentRoot, 'rehearsal'), { recursive: true })
  fs.writeFileSync(path.join(contentRoot, 'rehearsal', `${draftSlug}.mdx`), `${frontmatter('Rehearsal draft', false)}Draft body.\n`)
  const newFile = path.join(contentRoot, 'rehearsal', `${newSlug}.mdx`)

  const records = (): ContentRecord[] => parseAllPosts(contentRoot)
  const target = records().find(record => record.isPublished)
  if (target === undefined)
    throw new Error('The content has no published post to rehearse with')
  const targetFile = fs.globSync('*/*.mdx', { cwd: contentRoot })
    .map(file => path.join(contentRoot, file))
    .find(file => parseMdxFile(file, contentRoot).slug === target.slug)
  if (targetFile === undefined)
    throw new Error(`The file of post "${target.slug}" was not found in the copy`)
  const original = fs.readFileSync(targetFile, 'utf8')
  /** The body the sync stores for the target after `suffix` is appended to its file. */
  const edit = (suffix: string): string => {
    fs.writeFileSync(targetFile, original + suffix)
    return target.content + suffix
  }

  // The deploy's own functions take no abort signal, so each of their calls
  // runs to its end and the stop request is looked at right after it.
  step = 'running the first sync'
  const sync = async () => {
    await syncPosts(db, { contentRoot })
    stopIfRequested()
  }
  await sync()

  step = 'starting the database endpoint'
  const onEndpointError = (err: Error) => requestStop(`the database endpoint failed: ${messageOf(err)}`)
  let endpoint: Server = await serveNeonHttp(client, 0, onEndpointError)
  // released through the variable: a scenario closes the endpoint and opens a new one
  held.push({
    what: 'the database endpoint',
    release: () => {
      if (endpoint.listening) {
        endpoint.close()
        endpoint.closeAllConnections()
      }
    },
  })
  const endpointAddress = endpoint.address()
  if (typeof endpointAddress !== 'object' || endpointAddress === null)
    throw new Error('The database endpoint has no port')
  const databasePort = endpointAddress.port
  say(`Database endpoint: port ${databasePort}`)
  stopIfRequested()

  step = 'picking ports'
  const apiPort = await freePort()
  const inspectorPort = await freePort()
  const webPort = await freePort()
  // printed here: the inspector's appears nowhere else, and the "ready" lines only once a service answers
  say(`Ports: API ${apiPort}, inspector ${inspectorPort}, frontend ${webPort}`)
  stopIfRequested()
  const api = `http://127.0.0.1:${apiPort}`
  const web = new URL(`http://127.0.0.1:${webPort}`)
  // What a person opens: localhost, not 127.0.0.1. Next rewrites 127.0.0.1
  // to localhost in request.url, so the draft preview's redirect lands on
  // localhost, and a browser that began on 127.0.0.1 would not send its
  // draft cookie there.
  const browserAddress = `http://localhost:${webPort}`
  const revalidationSecret = randomBytes(24).toString('hex')
  // 16 characters at least: with a shorter one the API says nothing and turns the preview off
  const previewSecret = randomBytes(24).toString('hex')

  step = 'starting the API'
  const emptyEnvFile = path.join(temporary, 'empty.env')
  fs.writeFileSync(emptyEnvFile, '')
  start('api', apiDir, 'node_modules/.bin/wrangler', [
    'dev',
    '--port',
    String(apiPort),
    '--ip',
    '127.0.0.1',
    '--inspector-port',
    String(inspectorPort),
    '--inspector-ip',
    '127.0.0.1',
    '--var',
    `DATABASE_URL:postgresql://local@127.0.0.1:${databasePort}/local`,
    '--var',
    `PREVIEW_SECRET:${previewSecret}`,
    // an empty file, so .dev.vars and .env in that checkout are not read
    '--env-file',
    emptyEnvFile,
    '--persist-to',
    path.join(temporary, 'wrangler'),
  ], { ...process.env, CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', WRANGLER_SEND_METRICS: 'false' })
  const publishedSlugs = () => records().filter(record => record.isPublished).map(record => record.slug).toSorted()
  const apiSlugs = async (): Promise<string[]> => {
    const { status, body } = await get(`${api}/api/posts`)
    if (status !== 200)
      throw new Error(`${api}/api/posts answered ${status}`)
    const list: unknown = JSON.parse(body)
    const data = typeof list === 'object' && list !== null && 'data' in list && Array.isArray(list.data)
      ? list.data
      : []
    return data.flatMap((post: unknown) => typeof post === 'object' && post !== null && 'slug' in post && typeof post.slug === 'string'
      ? [post.slug]
      : []).toSorted()
  }
  await ready('The API', async () => (await apiSlugs()).join() === publishedSlugs().join())
  stopIfRequested()
  say(`API ready: ${api}`)

  step = 'building the frontend'
  const webEnv = {
    ...process.env,
    CONTENT_API_URL: api,
    REVALIDATION_SECRET: revalidationSecret,
    PREVIEW_SECRET: previewSecret,
    NEXT_TELEMETRY_DISABLED: '1',
  }
  // with it a build reads nothing from the API
  fs.rmSync(path.join(webDir, '.next/cache/fetch-cache'), { recursive: true, force: true })
  const buildStarted = performance.now()
  const build = start('build', webDir, 'node_modules/.bin/next', ['build'], webEnv, true)
  const buildEnd = await ended(build, BUILD_TIMEOUT_MS)
  // Released now rather than in the cleanup: once its group is empty, the
  // number may be given to another process while the stack is held.
  await releaseEarly(build)
  stopIfRequested()
  if (buildEnd !== 'exit code 0')
    throw new Error(`next build failed (${buildEnd})`)
  say(`Build finished in ${Math.round((performance.now() - buildStarted) / 1000)} s`)

  step = 'starting the frontend'
  start('web', webDir, 'node_modules/.bin/next', [
    'start',
    '-p',
    String(webPort),
    '-H',
    '127.0.0.1',
  ], webEnv)
  await ready('The frontend', async () => (await get(new URL('/contract.json', web))).status === 200)
  stopIfRequested()
  say(`Frontend ready: ${browserAddress}`)

  // ------------------------------------------------------------------
  // The scenarios. A step that must fail has to fail for the reason
  // written here; any other error fails the run.
  // ------------------------------------------------------------------
  const revalidate = async () => {
    await revalidateFrontend(web, revalidationSecret)
    stopIfRequested()
  }
  const reconcileNow = async () => {
    await reconcile(web, {
      contentRoot,
      roundDelayMs: RECONCILE_ROUND_DELAY_MS,
      log: () => {},
    })
    stopIfRequested()
  }
  const contractCheck = async () => {
    checkContent(await fetchContract(web), contentRoot)
    stopIfRequested()
  }
  const page = async (slug: string) => {
    const { status, body } = await get(new URL(`/posts/${slug}`, web))
    return {
      status,
      hashes: postBodyHashesIn(body),
    }
  }
  /** The one hash a post page that answers 200 shows. */
  const shownHash = async (slug: string): Promise<string> => {
    const { status, hashes } = await page(slug)
    expectEqual(`/posts/${slug} status`, status, 200)
    expectEqual(`/posts/${slug} hash tags`, hashes.length, 1)
    return hashes[0] ?? ''
  }
  const apiBody = async (slug: string): Promise<unknown> => {
    const { status, body } = await get(`${api}/api/post/${slug}`)
    expectEqual(`${api}/api/post/${slug} status`, status, 200)
    const post: unknown = JSON.parse(body)
    return typeof post === 'object' && post !== null && 'data' in post && typeof post.data === 'object' && post.data !== null && 'content' in post.data
      ? post.data.content
      : undefined
  }
  /** The problems a failed reconcile lists, one per line of its error. */
  const problems = (error: string) => error.split('\n').filter(line => line.startsWith('  - '))
  const scenario = async (name: string, play: () => Promise<void>) => {
    step = `running the scenario "${name}"`
    const started = performance.now()
    await play()
    stopIfRequested()
    say(`PASS ${name} (${Math.round(performance.now() - started)} ms)`)
  }

  let baselineHash = ''
  let liveHash = ''

  await scenario('contract', contractCheck)

  await scenario('baseline', async () => {
    await sync()
    await revalidate()
    await reconcileNow()
    baselineHash = await shownHash(target.slug)
    expectEqual('the baseline hash', baselineHash, postBodyHash(target.content))
    expectEqual('the draft\'s page', (await page(draftSlug)).status, 404)
  })

  await scenario('reconcile without an expiry', async () => {
    const body = edit('\nRehearsal edit 1.\n')
    await sync()
    expectEqual('the body the API reads', await apiBody(target.slug), body)
    const error = await failureOf('the reconcile', reconcileNow)
    const found = problems(error)
    if (found.length !== 1 || !found[0]?.includes(`/posts/${target.slug} still shows a previous version`) || !found[0].includes(`the page has ${baselineHash}`))
      throw new Error(`The reconcile must fail on /posts/${target.slug} still showing ${baselineHash} and on nothing else, but it said:\n${error}`)
  })

  await scenario('expiry', async () => {
    await revalidate()
    await reconcileNow()
    liveHash = await shownHash(target.slug)
    expectEqual('the hash after the expiry', liveHash, postBodyHash(`${target.content}\nRehearsal edit 1.\n`))
  })

  await scenario('new post', async () => {
    fs.writeFileSync(newFile, `${frontmatter('Rehearsal new post', true)}New body.\n`)
    await sync()
    expectEqual('the new post through the API', (await get(`${api}/api/post/${newSlug}`)).status, 200)
    expectEqual('the new post\'s page before the expiry', (await page(newSlug)).status, 404)
    await revalidate()
    await reconcileNow()
  })

  await scenario('the API cannot read the database', async () => {
    // the sync writes through the in-process database, not the endpoint
    const body = edit('\nRehearsal edit 2.\n')
    await sync()
    expectEqual('the body the API reads', await apiBody(target.slug), body)
    await new Promise<void>((resolve) => {
      endpoint.close(() => resolve())
      endpoint.closeAllConnections()
    })
    stopIfRequested()
    const error = await failureOf('the revalidation', revalidate)
    if (!error.includes('could not read the API, so it expired nothing') || !error.includes('(502)'))
      throw new Error(`The revalidation must fail with the frontend's 502, but it said:\n${error}`)
    expectEqual('the page while the API cannot read', await shownHash(target.slug), liveHash)
    // the same port: the API was started with it. Not getting it back fails the run.
    endpoint = await serveNeonHttp(client, databasePort, onEndpointError)
    stopIfRequested()
    // nothing was expired, so nothing is read again
    expectEqual('the page once the API can read again', await shownHash(target.slug), liveHash)
  })

  await scenario('a render failure the contract does not see', async () => {
    // A line range rehype-pretty-code cannot highlight: it throws while the
    // page renders, and the contract has no word for it. Kept small: the
    // range is expanded into an array before the throw, and 1-99999999 held
    // next start's event loop for seconds, long enough for its keep-alive
    // timer to reset a connection the reconcile was reusing.
    edit('\n```ts {1-999999}\nconst rehearsal = true\n```\n')
    await sync()
    await contractCheck()
    await revalidate()
    const error = await failureOf('the reconcile', reconcileNow)
    const found = problems(error)
    if (found.length !== 1 || !found[0]?.includes(`/posts/${target.slug} answered 500: the page failed to render`))
      throw new Error(`The reconcile must fail on /posts/${target.slug} failing to render (500) and on nothing else, but it said:\n${error}`)
  })

  await scenario('back to the baseline', async () => {
    edit('')
    fs.rmSync(newFile)
    await sync()
    await revalidate()
    await reconcileNow()
    expectEqual('the new post\'s page', (await page(newSlug)).status, 404)
    expectEqual('the target\'s hash', await shownHash(target.slug), baselineHash)
    expectEqual('the draft\'s page', (await page(draftSlug)).status, 404)
  })

  say('Every scenario passed')
  if (!keep)
    return

  step = 'holding the stack (--keep)'
  say('Holding the stack until interrupted (Ctrl-C):')
  say(`  database: postgresql://local@127.0.0.1:${databasePort}/local`)
  say(`  API:      ${api}`)
  say(`  frontend: ${browserAddress}`)
  say(`  REVALIDATION_SECRET: ${revalidationSecret}`)
  say(`  PREVIEW_SECRET: ${previewSecret}`)
  say(`  the draft: ${draftSlug}`)
  // A signal is how a held run ends, and it passed. Any other stop request (a child ended) fails it.
  await sleep(2 ** 31 - 1, undefined, { signal: stopping.signal }).catch(() => {})
  if (interruptedBy === undefined)
    stopIfRequested()
}

/** Releases everything held, newest first, and says how the run went. Runs once, from the `finally`. */
async function cleanUp(failure: string | undefined): Promise<number> {
  // run() returned: every scenario passed, and a stack held for --keep was ended by a signal
  const passed = failure === undefined
  // read now: the children this stops ask for a stop as they end
  const stopped = stopping.signal.aborted
    ? String(stopping.signal.reason)
    : undefined
  const reason = stopped ?? (passed
    ? 'every scenario passed'
    : `failed while ${step}: ${failure}`)
  say(`Cleaning up: ${reason}`)

  // a failed run shows what the children said; CI has no temporary files to look at
  if (!passed && interruptedBy === undefined) {
    for (const child of children) {
      say(`The last ${child.tail.length} lines of ${child.name}:`)
      for (const line of child.tail)
        console.info(`    ${line}`)
    }
  }

  let problems = 0
  for (const { what, release } of held.toReversed()) {
    try {
      await release()
    }
    catch (err) {
      // one thing that cannot be released does not keep the rest
      problems++
      say(`Could not release ${what}: ${messageOf(err)}`)
    }
  }
  return passed && problems === 0
    ? 0
    : 1
}

// --------------------------------------------------------------------------
// Start. Everything from here on is inside the one try/finally. Up to the
// first `await` it is synchronous: a signal is only handled between turns
// of the event loop, so none lands between taking the lock and holding it,
// and a synchronous failure (the disk fills while the pid is written)
// still reaches the cleanup.
// --------------------------------------------------------------------------

/** Whether the package.json at `file` lists next among its dependencies. */
function dependsOnNext(file: string): boolean {
  if (!fs.existsSync(file))
    return false
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  catch (err) {
    throw new Error(`${file} is not valid JSON: ${messageOf(err)}`)
  }
  return typeof parsed === 'object' && parsed !== null
    && 'dependencies' in parsed && typeof parsed.dependencies === 'object' && parsed.dependencies !== null
    && 'next' in parsed.dependencies
}

let failure: string | undefined
let refused = false
try {
  if (!dependsOnNext(path.join(webDir, 'package.json')))
    throw new Error(`WEB_DIR (${webDir}) is not a checkout of the frontend: no package.json that depends on next`)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  let lock: number | undefined
  try {
    // exclusive: with a lock there, whatever is in it, this run takes nothing
    lock = fs.openSync(lockPath, 'wx')
  }
  catch (err) {
    if (errorCode(err) !== 'EEXIST')
      throw err
    refused = true
    refuse()
  }

  if (lock !== undefined) {
    const lockDescriptor = lock
    // held before anything is written into it
    held.push({
      what: 'the lock',
      release: () => {
        fs.closeSync(lockDescriptor)
        if (groupLeftBehind)
          throw new Error('a process group is still there after SIGKILL, so the lock stays')
        fs.rmSync(lockPath)
      },
    })
    fs.writeSync(lockDescriptor, `pid ${process.pid}\n`)

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-'))
    held.push({
      what: 'the temporary directory',
      release: () => fs.rmSync(temporary, { recursive: true, force: true }),
    })
    note(`tmp ${temporary}`)
    say(`From now until it ${keep ? 'holds the stack (--keep)' : 'ends'}, nothing else may use the production build in ${webDir}/.next (no next start, build, screenshots or e2e there): this run replaces it.`)
    say(`pid ${process.pid}`)
    say(`Temporary directory: ${temporary}`)

    await run(temporary)
  }
}
catch (err) {
  failure = messageOf(err)
}
finally {
  process.exitCode = refused
    ? 1
    : await cleanUp(failure)
}
