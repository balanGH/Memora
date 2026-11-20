// Run the backend pytest suite with the backend venv's interpreter.
// Tests use throwaway temp folders only; they never touch ~/.memora.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const backend = join(resolve(import.meta.dirname, '..'), 'backend')
const py = [join(backend, '.venv', 'Scripts', 'python.exe'), join(backend, '.venv', 'bin', 'python')]
  .find((p) => existsSync(p))
if (!py) {
  console.error('Backend venv not found. Run `npm run backend:install` first.')
  process.exit(1)
}
const res = spawnSync(py, ['-m', 'pytest', ...process.argv.slice(2)], { cwd: backend, stdio: 'inherit' })
process.exit(res.status ?? 1)
