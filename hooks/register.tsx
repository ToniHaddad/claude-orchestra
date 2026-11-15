import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Catalog, Model, Performance, Player } from '../types'
import { APPEND, CODEX_MODELS, COLLECT, MKDIR } from './node-scripts'

// The orchestra: Claude conducts, in every session. A section of the system
// prompt (ROUTING, below) tells the session's model to route each piece of
// work to the right player and model, and to review what comes back. Codex and
// Gemini are consulted through their own CLIs (Gemini through Antigravity's
// `agy`, which replaced the Gemini CLI for personal accounts), each call naming
// the model and the effort it runs on. In `answer` mode a player runs read-only;
// in `edit` mode it does the work itself, writing inside the project folder
// (Codex's workspace-write sandbox, Antigravity's accept-edits mode). For images
// each writes only into its own staging folder.
//
// The mod is installed for the whole account, so what it keeps lives in two places:
//   ~/.orchestra/memory.md         account-wide notes every player is briefed with
//   ~/.orchestra/tracker.jsonl     one line per consultation or image, every project
//   ~/.orchestra/models.json       the models each player offers, refreshed daily
//   ~/.orchestra/staging/          per-request working folders (safe to delete)
//   <project>/.orchestra/memory.md notes about one project, briefed there only

const PANE = 'orchestra'
const ROUTING = 'orchestra:routing'

// What the players offered when this was written: used until the first refresh
// has written ~/.orchestra/models.json, and for a player whose refresh fails.
const FALLBACK: Catalog = {
  fetchedAt: 0,
  codex: [
    { id: 'gpt-6-luna', label: 'GPT-6-Luna', hint: 'Fast and affordable model for easier tasks.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', hint: 'Balanced model for straightforward work.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', hint: 'Latest workhorse model for coding and everyday work.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', hint: 'Frontier intelligence for the most demanding work.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ],
  gemini: [
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', hint: 'Fast and cheap: quick checks, summaries, bulk reading.', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-4-argon', label: 'Gemini 4 Argon', hint: 'Long-horizon work and very large reads at lower token use.', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', hint: 'Strongest reasoning in the Gemini line: analysis, design critique, agentic work.', efforts: ['low', 'medium', 'high', 'xhigh'] },
  ],
}

const performances = atom({ plugin: 'orchestra', key: 'performances' } as const, [])
const catalog = atom({ plugin: 'orchestra', key: 'catalog' } as const, FALLBACK)

const TIMEOUT_MS = 5 * 60 * 1000
const LONG_TIMEOUT_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MEMORY_CHARS = 4000
const FILES_SHOWN = 300

// The model a slash command runs on when the person names none: the first of
// these the catalogue holds.
const USUAL: Record<Player, string[]> = {
  codex: ['gpt-6.1-sol', 'gpt-6-sol'],
  gemini: ['gemini-4-hydrogen', 'gemini-4-argon'],
}

// Antigravity lists names only, so what each Gemini family is for is kept here.
const GEMINI_HINTS: [RegExp, string][] = [
  [/flash/, 'Fast and cheap: quick checks, summaries, bulk reading.'],
  [/hydrogen/, 'Strongest reasoning in the Gemini line: analysis, design critique, agentic work.'],
  [/argon/, 'Long-horizon work and very large reads at lower token use.'],
]

const INSTALL: Record<Player, string> = {
  codex: 'npm install -g @openai/codex, then run `codex` once to sign in',
  gemini:
    'in PowerShell run `irm https://antigravity.google/cli/install.ps1 | iex`, then run `agy` once in a terminal to sign in',
}

function askSchema(models: Model[], isEffortInId: boolean) {
  return {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'A self-contained request. The player cannot see this conversation; it is briefed with the shared memory and the project file list, so include the goal, the relevant file paths and any constraints.',
      },
      model: {
        type: 'string',
        description: `The model that fits this request: the cheapest one that will do it well, not the strongest by habit. One of:\n${modelLines(models)}`,
      },
      effort: {
        type: 'string',
        description: isEffortInId
          ? 'Reasoning effort, one the chosen model lists; medium when absent.'
          : "Reasoning effort, one the chosen model lists; the model's own default when absent.",
      },
      mode: {
        type: 'string',
        enum: ['answer', 'edit'],
        description:
          'answer (default): read-only, it replies and changes nothing. edit: it does the work itself, creating and changing files inside the project folder; read what it changed before you rely on it.',
      },
      cwd: {
        type: 'string',
        description: 'Project folder the player works in; defaults to the session directory.',
      },
    },
    required: ['prompt', 'model'],
  }
}

const IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    player: { type: 'string', enum: ['codex', 'gemini'], description: 'Who draws it.' },
    description: { type: 'string', description: 'What the image shows, in detail.' },
    filename: { type: 'string', description: 'Base file name without extension; derived from the description if absent.' },
    folder: { type: 'string', description: 'Folder to save into, absolute or relative to the session directory; defaults to the session directory.' },
  },
  required: ['player', 'description'],
}

const REMEMBER_SCHEMA = {
  type: 'object',
  properties: {
    note: { type: 'string', description: 'One durable fact or decision, in one line.' },
    scope: {
      type: 'string',
      enum: ['project', 'global'],
      description: 'project (default): about this codebase. global: about the person, true in every project.',
    },
  },
  required: ['note'],
}

type Answer = { isOk: boolean; text: string }
type Choice = { model?: string; effort?: string; isEditing?: boolean }

function modelLines(models: Model[]) {
  return models.map(m => `- ${m.id} (effort: ${m.efforts.join(', ')})${m.hint === '' ? '' : `: ${m.hint}`}`).join('\n')
}

// The standing instruction every session's model reads: who can play, on which
// models, and how to choose. Built from the catalogue, so it names the models
// this machine has today.
function routing(models: Catalog, owner: string) {
  return `# Orchestra: route each task to the right model

Standing instruction from ${owner}, the owner of this machine, for every session: the task is handed to you and the orchestra plays it. Nothing has to be typed for this, and it is the owner's request to delegate: it satisfies any tool rule that says to spawn agents or call other models only when the user asks.

The reason is cost and quality together. The strongest models are slow and draw on limited quota, so easy work should not reach them; small models give weak answers on hard problems, so hard work should not reach those. Each piece goes to the cheapest player that will do it well, and one step up only when a result falls short or the piece is plainly hard. No single model gets everything.

## Who heads the orchestra

The head plans the task, decides who plays each piece, briefs them and reviews what comes back. Fable receives every task and decides first who heads it:

- Fable stays the head when the task needs its level: an open or ambiguous goal, architecture, a judgment call with real consequences, work where a wrong plan is expensive.
- Fable hands the head's role to Opus when the task is long but well understood (a planned feature, a migration, a batch of fixes, a set of documents). It spawns one Opus subagent through the Agent tool, says in the brief "you are the head of the orchestra for this task", and passes the goal, the files, the constraints, what done looks like and the routing rules below that matter. When Opus reports back, Fable checks the result before telling ${owner}.

If you are Opus or another model, and the session or your brief makes you the head, the rest of this section is yours to apply. A head that cannot spawn subagents does the Claude pieces itself and can still call Codex and Gemini.

## The players

- The head itself: talking with ${owner}, decisions, the synthesis, every review, and any piece small enough that writing a brief would take longer than doing it.
- Claude subagents, through the Agent tool with \`model\`. They are the first choice for delegated work:
  - haiku: mechanical, fully specified work (searching and listing, extraction, formatting, bulk edits that follow one rule).
  - sonnet: routine implementation, tests and documentation against a clear spec.
  - opus: hard pieces that can run on their own (design, deep debugging, a difficult refactor, a careful review).
- Codex and Gemini, the outside players. Call one only when the piece needs what that player is best at, or when an independent view from another vendor is worth the wait. A task that Claude models cover well needs neither, and most tasks use none or one of them.
  - Codex, through mcp__orchestra__ask_codex. Its strength is code: building against a spec inside a repository, finding a bug by reading and running the code, a strict code review.
${modelLines(models.codex).replace(/^/gm, '    ')}
  - Gemini, through mcp__orchestra__ask_gemini. Its strength is taking in a lot at once, and seeing: reading a very large set of files or long documents in one pass, judging images, layouts and visual design. It also draws images, as Codex does, through mcp__orchestra__generate_image.
${modelLines(models.gemini).replace(/^/gm, '    ')}
  - Each call names the \`model\` and \`effort\` that fit the piece, and a \`mode\`: \`answer\` (it reads and replies, and changes nothing) or \`edit\` (it does the work itself, writing files inside the project folder). Use \`edit\` when the piece is theirs to build. Only one writer works on a set of files at a time, and after an \`edit\` call you read what changed before you rely on it.

## Briefs, review and the report

Every brief must stand alone: the goal, the files, the constraints and what a finished answer looks like, because the player sees none of this conversation. The head reviews every result before using it or reporting it; if it falls short, it sends the piece back with the correction or moves up one step. The reply to ${owner} says in one line who did what (for example "Routing: Haiku listed the call sites, Sonnet wrote the fix, Codex Sol at high reviewed it").

Work with no real choice to make (a quick question, a one-line edit, a lookup) you answer yourself, with no routing line. If you are a subagent that was not made the head, or a consulted player, this section is not for you: do the work you were given.`
}

// Who the standing instruction speaks for: the name in the machine's own
// ORCHESTRA_OWNER, so the source names nobody. Letters, digits and plain
// punctuation only, since it is written into the system prompt.
async function ownerName($: EngineInterface) {
  const name = ((await $.env.get('ORCHESTRA_OWNER')) ?? '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40)
  return name === '' ? 'the user' : name
}

// Checks a requested model and effort against what the player offers.
function choose(player: Player, models: Model[], model?: string, effort?: string): Choice | { deny: string } {
  if (model === undefined) {
    const usual = USUAL[player].map(id => models.find(m => m.id === id)).find(m => m !== undefined) ?? (player === 'gemini' ? models[0] : undefined)
    if (usual === undefined) return {}
    return { model: usual.id, effort: player === 'gemini' ? mediumOf(usual) : undefined }
  }
  const found = models.find(m => m.id === model)
  if (found === undefined) return { deny: `${player} has no model "${model}". Choose one of:\n${modelLines(models)}` }
  if (effort !== undefined && !found.efforts.includes(effort)) {
    return { deny: `${found.id} has no effort "${effort}". Choose one of: ${found.efforts.join(', ')}.` }
  }
  return { model: found.id, effort: effort ?? (player === 'gemini' ? mediumOf(found) : undefined) }
}

function mediumOf(model: Model) {
  return model.efforts.includes('medium') ? 'medium' : model.efforts[0]
}

function isSlow(effort?: string) {
  return effort === 'xhigh' || effort === 'max' || effort === 'ultra'
}

// `agy models` prints one `id<TAB>name` per line, the effort as the id's last
// part; the Gemini ones are grouped into families.
function geminiModels(listing: string) {
  const families: Model[] = []
  for (const line of listing.split('\n')) {
    const [id = '', name = ''] = line.trim().split('\t')
    const match = /^(gemini-[a-z0-9.-]+)-(low|medium|high|xhigh|max)$/.exec(id)
    if (match === null) continue
    const [, family = '', effort = ''] = match
    const known = families.find(m => m.id === family)
    if (known !== undefined) {
      known.efforts.push(effort)
      continue
    }
    families.push({
      id: family,
      label: name.replace(/\s*\([^)]*\)\s*$/, ''),
      hint: GEMINI_HINTS.find(([pattern]) => pattern.test(family))?.[1] ?? '',
      efforts: [effort],
    })
  }
  const order = ['low', 'medium', 'high', 'xhigh', 'max']
  for (const family of families) family.efforts.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return families
}

function isModels(value: unknown): value is Model[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(m => typeof m?.id === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(m.id) && Array.isArray(m.efforts) && m.efforts.every((x: unknown) => typeof x === 'string' && /^[a-z]+$/.test(x)) && typeof m.hint === 'string')
  )
}

function slug(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, '') || 'image'
  )
}

function isAbsolute(path: string) {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(path)
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

async function root($: EngineInterface, cwd?: string) {
  const base = await $.session.cwd()
  if (cwd === undefined || cwd === '') return base
  return isAbsolute(cwd) ? cwd : `${base}/${cwd}`
}

// The account-wide folder, ~/.orchestra.
async function home($: EngineInterface) {
  const dir = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (dir === undefined || dir === '') throw new Error('no home folder (USERPROFILE / HOME unset)')
  return `${dir}/.orchestra`
}

async function memoryFile($: EngineInterface, scope: 'project' | 'global') {
  return scope === 'global' ? `${await home($)}/memory.md` : `${await root($)}/.orchestra/memory.md`
}

async function node($: EngineInterface, script: string, args: string[], timeoutMs = 30_000) {
  return $.process.run(['node', '-e', script, ...args], { timeoutMs })
}

async function readText($: EngineInterface, path: string) {
  try {
    if (!(await $.fs.exists(path))) return ''
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

async function remember($: EngineInterface, note: string, scope: 'project' | 'global' = 'project') {
  const file = await memoryFile($, scope)
  const isNew = (await readText($, file)) === ''
  const head = isNew
    ? `# Orchestra memory (${scope})\n\nShared notes every player is briefed with. Edit freely.\n\n`
    : ''
  await node($, APPEND, [file, `${head}- ${today()}: ${note.replace(/\s+/g, ' ').trim()}\n`])
  return file
}

async function track($: EngineInterface, one: Performance) {
  const file = `${await home($)}/tracker.jsonl`
  const line = { ...one, at: new Date(one.startedAt).toISOString(), project: await root($) }
  await node($, APPEND, [file, JSON.stringify(line) + '\n'])
}

async function projectFiles($: EngineInterface, cwd: string) {
  try {
    const run = await $.process.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd,
      timeoutMs: 15_000,
    })
    if (run.exitCode !== 0) return ''
    const files = run.stdout.split('\n').map(line => line.trim()).filter(f => f !== '' && !f.startsWith('.orchestra/'))
    const shown = files.slice(0, FILES_SHOWN)
    return `## Project files (${files.length} total${files.length > shown.length ? `, first ${shown.length}` : ''})\n${shown.join('\n')}`
  } catch {
    return ''
  }
}

// What every player reads before the request: who it plays with, the shared
// memory, and the map of the project it may read from.
async function brief($: EngineInterface, prompt: string, cwd: string, isEditing: boolean) {
  const global = (await readText($, await memoryFile($, 'global'))).slice(-MEMORY_CHARS)
  const project = (await readText($, await memoryFile($, 'project'))).slice(-MEMORY_CHARS)
  return [
    isEditing
      ? 'You are one player in an orchestra conducted by Claude, with Codex and Gemini. Do the work the request at the end describes: create and edit files inside the project folder only, and leave everything outside it alone. Do not commit, push, install software, or delete files the request does not name. When you are done, list each file you changed and what you did in it.'
      : 'You are one player in an orchestra conducted by Claude, with Codex and Gemini. Answer the request at the end; be concrete and concise. Do not change any file.',
    `Project folder: ${cwd} (read any file in it you need).`,
    global === '' ? '' : `## Shared memory: about the owner (~/.orchestra/memory.md)\n${global}`,
    project === '' ? '' : `## Shared memory: this project (.orchestra/memory.md)\n${project}`,
    await projectFiles($, cwd),
    `## Request\n${prompt}`,
  ]
    .filter(part => part !== '')
    .join('\n\n')
}

async function runCodex($: EngineInterface, argv: string[], init: { cwd: string; stdin: string; timeoutMs: number }) {
  // ORCHESTRA_CODEX names the Codex executable to run in place of the one on
  // PATH (on Windows, one installed under a short folder: Codex's sandbox helper
  // cannot start from a path longer than 260 characters).
  const own = await $.env.get('ORCHESTRA_CODEX')
  if (own !== undefined && own !== '') return await $.process.run([own, ...argv.slice(1)], init)
  try {
    return await $.process.run(argv, init)
  } catch {
    // Not found directly: through the Windows shell, which resolves npm's .cmd
    // shims. argv holds fixed flags only (the text is on stdin), so it is safe.
    return await $.process.run(['cmd.exe', '/d', '/s', '/c', ...argv], init)
  }
}

async function runAgy($: EngineInterface, args: string[], init: { cwd: string; timeoutMs: number }) {
  try {
    return await $.process.run(['agy', ...args], init)
  } catch {
    // Freshly installed: the installer's PATH change reaches new shells only.
    const local = await $.env.get('LOCALAPPDATA')
    if (local === undefined) throw new Error('agy not found on PATH')
    return await $.process.run([`${local}\\agy\\bin\\agy.exe`, ...args], init)
  }
}

// Reads ~/.orchestra/models.json into the session. The session keeps what it
// read, so the system prompt and the tool descriptions stay the same from its
// first turn to its last; a refresh shows in the next session.
async function loadCatalog($: EngineInterface) {
  let saved: Catalog = FALLBACK
  try {
    const parsed = JSON.parse(await readText($, `${await home($)}/models.json`)) as Partial<Catalog>
    saved = {
      fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
      codex: isModels(parsed.codex) ? parsed.codex : FALLBACK.codex,
      gemini: isModels(parsed.gemini) ? parsed.gemini : FALLBACK.gemini,
    }
  } catch {
    // no file yet, or a torn one: the fallback stands
  }
  await update($, catalog, () => saved)
  return saved
}

// Asks both CLIs what they offer and writes ~/.orchestra/models.json. A player
// that does not answer keeps the models it had.
async function refreshCatalog($: EngineInterface, had: Catalog) {
  let codex = had.codex
  let gemini = had.gemini
  try {
    const run = await node($, CODEX_MODELS, [], 15_000)
    const listed: unknown = JSON.parse(run.stdout)
    if (run.exitCode === 0 && isModels(listed)) codex = listed
  } catch {
    // Codex not installed or its cache unreadable
  }
  try {
    const run = await runAgy($, ['models'], { cwd: await root($), timeoutMs: 60_000 })
    const listed = geminiModels(run.stdout)
    if (run.exitCode === 0 && isModels(listed)) gemini = listed
  } catch {
    // Antigravity not installed or offline
  }
  const dir = await home($)
  await node($, MKDIR, [dir])
  await $.fs.write(`${dir}/models.json`, JSON.stringify({ fetchedAt: Date.now(), codex, gemini }, null, 2) + '\n')
}

// A fresh working folder under ~/.orchestra/staging, named by the mod alone.
async function staging($: EngineInterface, id: string) {
  const dir = `${await home($)}/staging/${id}`
  await node($, MKDIR, [dir])
  return dir
}

// What the working tree looks like after a player edited, for the head to review.
async function changed($: EngineInterface, cwd: string) {
  try {
    const run = await $.process.run(['git', 'status', '--short'], { cwd, timeoutMs: 15_000 })
    if (run.exitCode !== 0) return 'The project is not a git repository, so there is no list of changed files: read the files named above.'
    const lines = run.stdout.split('\n').filter(line => line.trim() !== '')
    if (lines.length === 0) return 'git status shows no changed files.'
    return `Working tree now (git status --short, ${lines.length} entries):\n${lines.slice(0, 60).join('\n')}`
  } catch {
    return ''
  }
}

// Runs one request past a player and records it in the pane and the tracker.
async function consult(
  $: EngineInterface,
  id: string,
  player: Player,
  prompt: string,
  cwd?: string,
  choice: Choice = {},
): Promise<Answer> {
  const project = await root($, cwd)
  const { model, effort, isEditing = false } = choice
  const timeoutMs = isEditing || isSlow(effort) ? LONG_TIMEOUT_MS : TIMEOUT_MS
  const one: Performance = {
    id,
    player,
    kind: isEditing ? 'edit' : 'ask',
    prompt,
    status: 'playing',
    startedAt: Date.now(),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  }
  await update($, performances, list => [...list, one].slice(-50))

  let answer: Answer
  try {
    const text = await brief($, prompt, project, isEditing)
    let run
    if (player === 'codex') {
      // Model and effort come from the catalogue (plain ids), never from the request's text.
      const argv = [
        'codex',
        'exec',
        '--sandbox',
        isEditing ? 'workspace-write' : 'read-only',
        '--skip-git-repo-check',
        ...(model === undefined ? [] : ['-m', model]),
        ...(effort === undefined ? [] : ['-c', `model_reasoning_effort=${effort}`]),
        '-',
      ]
      run = await runCodex($, argv, { cwd: project, stdin: text, timeoutMs })
    } else {
      // The brief goes in a file, so no text of the request is ever on a
      // command line. Plan mode keeps agy from editing, and only holds while
      // slash commands are left on (the fixed ask below starts with no slash).
      const dir = await staging($, id)
      await $.fs.write(`${dir}/request.md`, text)
      const ask = `Read the file ${dir}/request.md and answer the request in it. Reply with the answer only.`
      const args = [
        ...(model === undefined ? [] : ['--model', effort === undefined ? model : `${model}-${effort}`]),
        '--mode',
        isEditing ? 'accept-edits' : 'plan',
        '--add-dir',
        dir,
        ...(isEditing ? ['--disable-slash-commands'] : []),
        '-p',
        ask,
      ]
      run = await runAgy($, args, { cwd: project, timeoutMs })
    }
    const out = run.stdout.trim()
    const after = isEditing && run.exitCode === 0 && out !== '' ? await changed($, project) : ''
    answer =
      run.exitCode === 0 && out !== ''
        ? { isOk: true, text: after === '' ? out : `${out}\n\n${after}` }
        : {
            isOk: false,
            text: `${player} failed (exit ${run.exitCode}). If it is not installed: ${INSTALL[player]}.\n\n${run.stderr.trim().slice(-2000)}`,
          }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    answer = { isOk: false, text: `${player} could not be started: ${why}\nTo install it: ${INSTALL[player]}.` }
  }

  const done: Performance = {
    ...one,
    status: answer.isOk ? 'done' : 'failed',
    ms: Date.now() - one.startedAt,
    note: answer.isOk ? undefined : answer.text.split('\n')[0]?.slice(0, 120),
  }
  await update($, performances, list => list.map(p => (p.id === id ? done : p)))
  await track($, done)
  return answer
}

// Has a player draw an image and copies it into the folder asked for.
async function draw(
  $: EngineInterface,
  id: string,
  player: Player,
  description: string,
  filename?: string,
  folder?: string,
): Promise<Answer> {
  const one: Performance = { id, player, kind: 'image', prompt: description, status: 'playing', startedAt: Date.now() }
  await update($, performances, list => [...list, one].slice(-50))
  const name = slug(filename ?? description)

  let answer: Answer
  try {
    const dir = await staging($, id)
    const ask = `Generate one image with your image generation tool and save it in the current directory as ${name}.png. Reply with the file name only.\n\nThe image: ${description}`
    let run
    if (player === 'codex') {
      const argv = ['codex', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-']
      run = await runCodex($, argv, { cwd: dir, stdin: ask, timeoutMs: TIMEOUT_MS })
    } else {
      await $.fs.write(`${dir}/request.md`, ask)
      const args = ['--mode', 'accept-edits', '--disable-slash-commands', '-p', 'Read request.md in the current directory and do what it asks.']
      run = await runAgy($, args, { cwd: dir, timeoutMs: TIMEOUT_MS })
    }
    if (run.exitCode !== 0) {
      answer = { isOk: false, text: `${player} failed (exit ${run.exitCode}).\n\n${run.stderr.trim().slice(-2000)}` }
    } else {
      const dest = `${await root($, folder)}/${name}-${player}`
      const copy = await node($, COLLECT, [player, String(one.startedAt), dir, dest], TIMEOUT_MS)
      answer =
        copy.exitCode === 0
          ? { isOk: true, text: copy.stdout.trim() }
          : { isOk: false, text: `${player} ran but no image was found: ${copy.stderr.trim()}` }
    }
  } catch (error) {
    answer = { isOk: false, text: `${player} could not draw: ${error instanceof Error ? error.message : String(error)}` }
  }

  const done: Performance = {
    ...one,
    status: answer.isOk ? 'done' : 'failed',
    ms: Date.now() - one.startedAt,
    ...(answer.isOk ? { output: answer.text } : { note: answer.text.split('\n')[0]?.slice(0, 120) }),
  }
  await update($, performances, list => list.map(p => (p.id === id ? done : p)))
  await track($, done)
  return answer
}

function who(player: Player, choice: Choice) {
  const on = [choice.model, choice.effort].filter(part => part !== undefined).join(', ')
  return on === '' ? player : `${player} (${on})`
}

// A slash command's "[model] [effort] question": the leading words are taken
// as the model and effort only when the catalogue holds them.
async function direct($: EngineInterface, player: Player, args: string) {
  const models = (await read($, catalog))[player]
  const words = args.trim().split(/\s+/)
  const named = models.find(m => m.id === words[0])
  if (named !== undefined) words.shift()
  const effort = named !== undefined && named.efforts.includes(words[0] ?? '') ? words.shift() : undefined
  const choice = choose(player, models, named?.id, effort)
  return { question: words.join(' '), choice: 'deny' in choice ? {} : choice }
}

async function play($: EngineInterface, e: { tool_use_id: string; [argument: string]: unknown }, player: Player) {
  const prompt = String(e.prompt ?? '').trim()
  if (prompt === '') return { deny: 'A prompt is required.' }
  const cwd = typeof e.cwd === 'string' ? e.cwd : undefined
  const model = typeof e.model === 'string' ? e.model.trim() : ''
  if (model === '') return { deny: 'A model is required: choose the one that fits this request.' }
  const effort = typeof e.effort === 'string' && e.effort.trim() !== '' ? e.effort.trim() : undefined
  if (e.mode !== undefined && e.mode !== 'answer' && e.mode !== 'edit') return { deny: 'mode is answer or edit.' }
  const picked = choose(player, (await read($, catalog))[player], model, effort)
  if ('deny' in picked) return { deny: picked.deny }
  const choice: Choice = { ...picked, isEditing: e.mode === 'edit' }
  const answer = await consult($, e.tool_use_id, player, prompt, cwd, choice)
  if (!answer.isOk) return { result: answer.text }
  return { result: `${who(player, choice)} ${choice.isEditing ? 'did the work and reports' : 'says'}:\n\n${answer.text}` }
}

async function paint($: EngineInterface, e: { tool_use_id: string; [argument: string]: unknown }) {
  const player = e.player === 'codex' || e.player === 'gemini' ? e.player : undefined
  const description = String(e.description ?? '').trim()
  if (player === undefined || description === '') return { deny: 'player (codex|gemini) and description are required.' }
  const filename = typeof e.filename === 'string' && e.filename !== '' ? e.filename : undefined
  const folder = typeof e.folder === 'string' && e.folder !== '' ? e.folder : undefined
  const answer = await draw($, e.tool_use_id, player, description, filename, folder)
  return { result: answer.isOk ? `Saved ${answer.text}` : answer.text }
}

async function seedFromTracker($: EngineInterface) {
  if ((await read($, performances)).length > 0) return
  const lines = (await readText($, `${await home($)}/tracker.jsonl`)).trim().split('\n').slice(-50)
  const past: Performance[] = []
  for (const line of lines) {
    try {
      past.push(JSON.parse(line) as Performance)
    } catch {
      // a torn last line from an interrupted write: skip it
    }
  }
  if (past.length > 0) await update($, performances, () => past)
}

async function trackerTable($: EngineInterface) {
  const lines = (await readText($, `${await home($)}/tracker.jsonl`)).trim().split('\n').filter(Boolean)
  if (lines.length === 0) return 'The tracker is empty.'
  const rows = lines.slice(-15).map(line => {
    try {
      const p = JSON.parse(line) as Performance & { at: string; project?: string }
      const what = (p.output ?? p.note ?? p.prompt).replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 60)
      const project = (p.project ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
      return `| ${p.at.slice(0, 16).replace('T', ' ')} | ${project} | ${p.player} | ${[p.model, p.effort].filter(Boolean).join(' ')} | ${p.kind} | ${p.status} | ${Math.round((p.ms ?? 0) / 1000)}s | ${what} |`
    } catch {
      return ''
    }
  })
  return [
    `Last ${rows.length} of ${lines.length} (full log: ~/.orchestra/tracker.jsonl)`,
    '',
    '| When | Project | Player | Model | Kind | Status | Time | What |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.filter(Boolean),
  ].join('\n')
}

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const models = await loadCatalog($)
    if (Date.now() - models.fetchedAt > DAY_MS) void refreshCatalog($, models).catch(() => undefined)
    await $.tool.register({
      name: 'ask_codex',
      description:
        "Consult OpenAI Codex (local `codex` CLI, read-only sandbox) on the model and effort you choose for this request: a review, a second opinion, a diagnosis or an alternative implementation. It is briefed with the shared memory and the project file list and can read the project's files. In answer mode it only replies; in edit mode it does the work in the project folder and reports what it changed.",
      inputSchema: askSchema(models.codex, false),
      isDeferred: false,
    })
    await $.tool.register({
      name: 'ask_gemini',
      description:
        "Consult Google Gemini (local Antigravity `agy` CLI, plan mode) on the model and effort you choose for this request: a second opinion, a review, a design critique, or a long-context read of many files. It is briefed with the shared memory and the project file list and can read the project's files. In answer mode it only replies; in edit mode it does the work in the project folder and reports what it changed.",
      inputSchema: askSchema(models.gemini, true),
      isDeferred: false,
    })
    await $.tool.register({
      name: 'generate_image',
      description:
        'Have Codex (GPT image generation) or Gemini (Antigravity image generation) draw an image and save it into a folder (default: the session directory). Returns the saved path. Takes one to four minutes.',
      inputSchema: IMAGE_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'remember',
      description:
        "Add one durable fact or decision to the orchestra's shared memory, which every player is briefed with on every call: scope project (<project>/.orchestra/memory.md) for decisions and conventions of this codebase, global (~/.orchestra/memory.md) for facts about the owner true everywhere. Not for chatter.",
      inputSchema: REMEMBER_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'orchestra',
      description: 'Put a task to both Codex and Gemini: compare their answers, synthesize',
      argumentHint: '<task>',
    })
    await $.command.register({ name: 'orchestra-pane', description: 'Show what Codex and Gemini are playing' })
    await $.command.register({
      name: 'codex',
      description: 'Ask Codex directly (briefed with memory and file list)',
      argumentHint: '[model] [effort] <question>',
    })
    await $.command.register({
      name: 'gemini',
      description: 'Ask Gemini directly (briefed with memory and file list)',
      argumentHint: '[model] [effort] <question>',
    })
    await $.command.register({
      name: 'image',
      description: 'Draw an image into this folder',
      argumentHint: '[codex|gemini|both] <description>',
    })
    await $.command.register({
      name: 'remember',
      description: "Add a note to the orchestra's shared memory",
      argumentHint: '[global] <note>',
    })
    await $.command.register({ name: 'orchestra-memory', description: "Show the orchestra's shared memory" })
    await $.command.register({ name: 'tracker', description: 'Show the last consultations and images' })
    await $.command.register({
      name: 'orchestra-models',
      description: 'Show the models each player offers; "refresh" asks the CLIs again',
      argumentHint: '[refresh]',
    })
    await seedFromTracker($)
    return next(e)
  })

  // The standing instruction, in every session that can delegate. Set
  // ORCHESTRA_ROUTING=off in the environment to leave it out, and
  // ORCHESTRA_OWNER to the name it should use for the person.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const canDelegate = e.tools.includes('Agent') || e.tools.some(tool => tool.startsWith('mcp__orchestra__ask_'))
    if (!canDelegate || (await $.env.get('ORCHESTRA_ROUTING')) === 'off') return composed
    return {
      sections: [
        ...composed.sections.filter(section => section.id !== ROUTING),
        { id: ROUTING, text: routing(await read($, catalog), await ownerName($)), scope: 'session' as const },
      ],
    }
  })

  on('tool.call', { tool: 'mcp__orchestra__ask_codex' }, ($, e) => play($, e, 'codex'))
    .catch(() => ({ result: 'codex did not answer in time or the orchestra mod failed; carry on without it.' }))
  on('tool.call', { tool: 'mcp__orchestra__ask_gemini' }, ($, e) => play($, e, 'gemini'))
    .catch(() => ({ result: 'gemini did not answer in time or the orchestra mod failed; carry on without it.' }))
  on('tool.call', { tool: 'mcp__orchestra__generate_image' }, ($, e) => paint($, e))
    .catch(() => ({ result: 'The image request failed inside the orchestra mod.' }))
  on('tool.call', { tool: 'mcp__orchestra__remember' }, async ($, e) => {
    const note = String(e.note ?? '').trim()
    if (note === '') return { deny: 'A note is required.' }
    return { result: `Remembered in ${await remember($, note, e.scope === 'global' ? 'global' : 'project')}` }
  }).catch(() => ({ result: 'The note could not be saved.' }))

  on('command.run', { command: 'orchestra' }, async ($, e) => {
    const task = e.args.trim()
    if (task === '') return { text: 'Usage: /orchestra <task>' }
    void $.ui.open({ id: PANE, title: 'Orchestra' })
    void $.prompt.submit({
      text: [
        'Put this task to both Codex and Gemini and compare them with your own answer.',
        `Task: ${task}`,
        '',
        '1. Read .orchestra/memory.md if it exists, then enough of the codebase to brief the players well.',
        '2. Call mcp__orchestra__ask_codex and mcp__orchestra__ask_gemini in parallel, each on the model and effort this task deserves, each with a self-contained prompt (they cannot see this chat; they do get the shared memory and file list).',
        '3. Compare their answers with your own: where they agree, where they differ, and who is right and why.',
        '4. Give one synthesized recommendation. Make edits, or hand them to a player in edit mode, only if the task asks for them.',
        '5. If a durable decision came out of this, save it with mcp__orchestra__remember.',
      ].join('\n'),
    })
    return { text: `Conducting: ${task}` }
  })

  on('command.run', { command: 'orchestra-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Orchestra' })
    return { text: 'Orchestra pane opened.' }
  })

  on('command.run', { command: 'codex' }, async ($, e) => {
    const { question, choice } = await direct($, 'codex', e.args)
    if (question === '') return { text: 'Usage: /codex [model] [effort] <question>' }
    const answer = await consult($, newId('codex'), 'codex', question, undefined, choice)
    return { text: answer.isOk ? `**${who('codex', choice)}:**\n\n${answer.text}` : answer.text }
  })

  on('command.run', { command: 'gemini' }, async ($, e) => {
    const { question, choice } = await direct($, 'gemini', e.args)
    if (question === '') return { text: 'Usage: /gemini [model] [effort] <question>' }
    const answer = await consult($, newId('gemini'), 'gemini', question, undefined, choice)
    return { text: answer.isOk ? `**${who('gemini', choice)}:**\n\n${answer.text}` : answer.text }
  })

  on('command.run', { command: 'image' }, async ($, e) => {
    const [first = '', ...rest] = e.args.trim().split(/\s+/)
    const choice = ['codex', 'gemini', 'both'].includes(first.toLowerCase()) ? first.toLowerCase() : 'both'
    const description = (choice === first.toLowerCase() ? rest.join(' ') : e.args).trim()
    if (description === '') return { text: 'Usage: /image [codex|gemini|both] <description>' }
    void $.ui.open({ id: PANE, title: 'Orchestra' })
    const players: Player[] = choice === 'both' ? ['codex', 'gemini'] : [choice as Player]
    const results = await Promise.all(players.map(p => draw($, newId(p), p, description)))
    return {
      text: results
        .map((r, i) => `${players[i]}: ${r.isOk ? `saved ${r.text}` : r.text}`)
        .join('\n'),
    }
  })

  on('command.run', { command: 'remember' }, async ($, e) => {
    const isGlobal = /^global\s/i.test(e.args.trim())
    const note = (isGlobal ? e.args.trim().replace(/^global\s+/i, '') : e.args).trim()
    if (note === '') return { text: 'Usage: /remember [global] <note>' }
    return { text: `Remembered in ${await remember($, note, isGlobal ? 'global' : 'project')}` }
  })

  on('command.run', { command: 'orchestra-memory' }, async $ => {
    const global = await readText($, await memoryFile($, 'global'))
    const project = await readText($, await memoryFile($, 'project'))
    if (global === '' && project === '') {
      return { text: 'The shared memory is empty. Add to it with /remember <note> or /remember global <note>.' }
    }
    return {
      text: [
        `**Account-wide** (${await memoryFile($, 'global')})\n\n${global || '(empty)'}`,
        `**This project** (${await memoryFile($, 'project')})\n\n${project || '(empty)'}`,
      ].join('\n\n'),
    }
  })

  on('command.run', { command: 'tracker' }, async $ => ({ text: await trackerTable($) }))

  on('command.run', { command: 'orchestra-models' }, async ($, e) => {
    const models = await read($, catalog)
    if (e.args.trim().toLowerCase() === 'refresh') {
      await refreshCatalog($, models)
      return { text: 'Asked Codex and Antigravity again and saved ~/.orchestra/models.json. New sessions use it.' }
    }
    const when = models.fetchedAt === 0 ? 'built-in list' : `read ${new Date(models.fetchedAt).toISOString().slice(0, 10)}`
    return {
      text: `**Codex**\n\n${modelLines(models.codex)}\n\n**Gemini**\n\n${modelLines(models.gemini)}\n\n(${when}; /orchestra-models refresh asks the CLIs again)`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, performances)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)
    const width = Math.max(20, (e.props.bodyColumns ?? 60) - 26)

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>The orchestra is tuning. Calls to Codex and Gemini show here.</Text>}
        {list.slice(-room).map(one => (
          <Text key={one.id} dimColor={one.status === 'done'} color={one.status === 'failed' ? 'red' : undefined}>
            {one.status === 'playing' ? '♪ ' : one.status === 'done' ? '✓ ' : '✗ '}
            {one.kind === 'image' ? '🖼 ' : one.kind === 'edit' ? '✎ ' : '  '}
            {one.player.padEnd(7)}
            {one.ms !== undefined ? `${Math.round(one.ms / 1000)}s `.padStart(6) : '  ... '}
            {one.model === undefined ? '' : `[${[one.model, one.effort].filter(Boolean).join(' ')}] `}
            {(one.output ?? one.note ?? one.prompt).replace(/\s+/g, ' ').slice(0, width)}
          </Text>
        ))}
      </Box>
    )
  })
}
