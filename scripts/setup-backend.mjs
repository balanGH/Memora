// Cross-platform backend setup: create the venv and install requirements.
// Invoked via `npm run backend:install`. Avoids shell path/quoting pitfalls
// (notably cmd.exe treating '/' as an option char) by resolving paths in Node.
import { spawnSync } from 'node:child_process'
import { platform } from 'node:os'
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

// `--ai`: install real face recognition with the onnxruntime build that
// matches this machine's GPU (detected by backend/app/ai/device.py).
if (process.argv.includes('--ai')) {
  const probe = spawnSync(
    venvPython,
    ['-c', 'import json; from app.ai.device import detect_gpus, recommended_package as r; ' +
      'g = detect_gpus(); print(json.dumps({"gpus": [x.name for x in g], "pkg": r(g)}))'],
    { cwd: backend, encoding: 'utf8' }
  )
  let detected = { gpus: [], pkg: null }
  try {
    detected = JSON.parse(probe.stdout.trim().split('\n').pop())
  } catch {
    console.warn('GPU probe failed; falling back to the CPU build of onnxruntime.')
  }
  const ort = detected.pkg ?? 'onnxruntime'
  console.log(`\nGPUs found: ${detected.gpus.join(', ') || 'none'}`)
  console.log(`Using onnxruntime build: ${ort}`)
  // The onnxruntime builds conflict with each other; keep exactly one.
  const builds = ['onnxruntime', 'onnxruntime-gpu', 'onnxruntime-directml']
  spawnSync(venvPython, ['-m', 'pip', 'uninstall', '-y', ...builds.filter((b) => b !== ort)], {
    stdio: 'inherit'
  })
  run(venvPython, ['-m', 'pip', 'install', 'insightface', 'opencv-python', ort])
  if (ort === 'onnxruntime-gpu' && platform() === 'win32') {
    console.log(
      'Note: CUDA needs the NVIDIA CUDA 12 + cuDNN 9 runtime. If it is missing, Memora\n' +
        'falls back to CPU (Settings shows this). onnxruntime-directml works without it.'
    )
  }
}
console.log('\n✔ Backend environment ready.')
