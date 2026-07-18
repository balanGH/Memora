// Cross-platform backend setup: create the venv and install requirements.
// Invoked via `npm run backend:install`. Avoids shell path/quoting pitfalls
// (notably cmd.exe treating '/' as an option char) by resolving paths in Node.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const backend = join(root, 'backend')
const venv = join(backend, '.venv')
const isWin = process.platform === 'win32'
const venvPython = isWin
  ? join(venv, 'Scripts', 'python.exe')
  : join(venv, 'bin', 'python')

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`)
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: root })
  if (res.error) throw res.error
  if (res.status !== 0) process.exit(res.status ?? 1)
}

// Find a system Python to bootstrap the venv.
function findPython() {
  for (const candidate of isWin ? ['py', 'python'] : ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
    if (probe.status === 0) return candidate
  }
  console.error(
    'Could not find Python on PATH. Install Python 3.10+ and try again.'
  )
  process.exit(1)
}

if (!existsSync(venvPython)) {
  run(findPython(), ['-m', 'venv', venv])
}
run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'])
run(venvPython, ['-m', 'pip', 'install', '-r', join(backend, 'requirements.txt')])
console.log('\n✔ Backend environment ready.')
