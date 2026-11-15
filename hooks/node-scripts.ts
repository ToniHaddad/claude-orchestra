// Small Node programs the mod runs as `node -e <script> <args...>`. A hooks
// module has no Node and $.fs writes text only, so folders and binary copies
// go through these. Every path is its own argv entry: no shell ever sees them.

// mkdir <dir>
export const MKDIR = `require('fs').mkdirSync(process.argv[1], { recursive: true })`

// append <file> <text>: creates the folder and the file as needed. One
// appendFileSync per line, so parallel players never lose each other's lines.
export const APPEND = `
const fs = require('fs'), path = require('path')
fs.mkdirSync(path.dirname(process.argv[1]), { recursive: true })
fs.appendFileSync(process.argv[1], process.argv[2])
`

// collect <player> <sinceMs> <stagingDir> <destNoExt>
// Finds the newest image a player made since <sinceMs> (in the staging dir it
// ran in, then the CLI's own image store), copies it to <destNoExt>.<ext>
// without overwriting, and prints the path. Antigravity finishes its image in
// a background agent after the run exits, so it is polled for up to 4 minutes.
export const COLLECT = `
const fs = require('fs'), path = require('path'), os = require('os')
const [player, sinceArg, staging, destNoExt] = process.argv.slice(1)
const since = Number(sinceArg) - 2000
const IMAGE = /\\.(png|jpe?g|webp)$/i
const store = player === 'codex'
  ? path.join(os.homedir(), '.codex', 'generated_images')
  : path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain')
function walk(dir, depth, out) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (depth > 0 && !e.name.startsWith('.')) walk(full, depth - 1, out) }
    else if (IMAGE.test(e.name)) {
      const t = fs.statSync(full).mtimeMs
      if (t > since) out.push({ full, t })
    }
  }
}
function newest() {
  for (const [dir, depth] of [[staging, 1], [store, 2]]) {
    const found = []
    walk(dir, depth, found)
    if (found.length) return found.sort((a, b) => b.t - a.t)[0].full
  }
}
const deadline = Date.now() + (player === 'gemini' ? 240000 : 10000)
let src = newest()
while (!src && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)
  src = newest()
}
if (!src) { console.error('no new image found in ' + staging + ' or ' + store); process.exit(2) }
fs.mkdirSync(path.dirname(destNoExt), { recursive: true })
const ext = path.extname(src).toLowerCase()
let dest = destNoExt + ext, n = 2
while (fs.existsSync(dest)) dest = destNoExt + '-' + n++ + ext
fs.copyFileSync(src, dest)
console.log(dest)
`

// codex-models: prints the models Codex lists for this account, read from the
// catalogue the Codex CLI caches, as [{ id, label, hint, efforts }].
export const CODEX_MODELS = `
const fs = require('fs'), path = require('path'), os = require('os')
const file = path.join(os.homedir(), '.codex', 'models_cache.json')
const models = JSON.parse(fs.readFileSync(file, 'utf8')).models || []
console.log(JSON.stringify(models.filter(m => m.visibility === 'list').map(m => ({
  id: String(m.slug),
  label: String(m.display_name || m.slug),
  hint: String(m.description || ''),
  efforts: (m.supported_reasoning_levels || []).map(l => String(l.effort)),
}))))
`
