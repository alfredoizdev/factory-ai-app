// `npm run dev` and `npm run dev:neon`: starts everything the app needs in one terminal, and stops it all together.
//   local (default): the local test database, Inngest, and the app on that database.
//   neon:            Inngest, and the app on Neon and R2.
// An Inngest that is already running (port 8288) is left alone and used as it is.
import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'

const mode = process.argv[2] === 'neon' ? 'neon' : 'local'
const APP = 'http://127.0.0.1:4100'
const INNGEST_PORT = 8288

const listening = port =>
  new Promise(resolve => {
    const s = connect({ host: '127.0.0.1', port })
    s.once('connect', () => (s.destroy(), resolve(true)))
    s.once('error', () => resolve(false))
  })

if (await listening(4100)) {
  console.log(`AI Factory is already running: open ${APP}\nTo restart it, stop the other one first (Ctrl+C in its terminal).`)
  process.exit(0)
}

if (mode === 'local') {
  const db = spawnSync('npm', ['run', 'db:local'], { stdio: 'inherit' })
  if (db.status !== 0) {
    console.error('\nThe local test database did not start. Is Docker Desktop open?')
    process.exit(1)
  }
}

const children = []
let stopping = false

/** Stops every child (and what it started), then this script. */
function stopAll(code = 0) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  setTimeout(() => process.exit(code), 500)
}

/** Starts a command in its own process group, printing its lines with a name in front. */
function start(name, color, cmd, args, env = {}) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const tag = `\x1b[${color}m[${name}]\x1b[0m `
  for (const stream of [child.stdout, child.stderr]) {
    let rest = ''
    stream.on('data', chunk => {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) process.stdout.write(tag + line + '\n')
    })
  }
  child.on('exit', code => {
    if (!stopping) console.log(`${tag}stopped${code ? ` (code ${code})` : ''}. Stopping the rest.`)
    stopAll(code ?? 0)
  })
  children.push(child)
}

if (await listening(INNGEST_PORT)) console.log('Inngest is already running: using it.')
else start('inngest', 35, 'npx', ['--yes', 'inngest-cli', 'dev', '--host', '127.0.0.1', '-u', `${APP}/api/inngest`])

start('app', 36, 'node_modules/.bin/next', ['dev', '-H', '127.0.0.1', '-p', '4100'], {
  INNGEST_DEV: `http://127.0.0.1:${INNGEST_PORT}`,
  ...(mode === 'local' ? { FACTORY_DB: 'local' } : {}),
})

console.log(`\nAI Factory on ${mode === 'local' ? 'the local test database' : 'Neon (your real tasks)'}: ${APP}\nPress Ctrl+C to stop everything.\n`)

process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))
