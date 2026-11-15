import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// The facts a system prompt is composed from, for a session offering `tools`.
const session = (tools: string[]) => ({
  model: 'claude-fable-5-2',
  promptModel: 'claude-fable-5-2',
  surfaces: [],
  tools,
  outputStyle: null,
  traits: [],
})

type Run = { argv: readonly string[]; stdin?: string; cwd?: string }

// A fake machine: a project with two files, an empty memory, and CLIs that
// answer from `answers`. Every process the mod starts is recorded in `runs`.
function fakeMachine(on: On, answers: Record<string, string>, env: Record<string, string> = {}) {
  const runs: Run[] = []
  on('session.cwd', () => ({ value: 'C:/work/project' }))
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/user' : env[e.name] }))
  on('fs.exists', () => ({ value: false }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, cwd: e.init?.cwd })
    const program = e.argv[0] ?? ''
    if (program === 'git') return ok('README.md\nsrc/app.py\n')
    if (program === 'node') return ok(answers.node ?? '')
    const answer = answers[program]
    return answer === undefined ? { deny: `${program}: command not found` } : ok(answer)
  })
  return runs
}

test('ask_codex briefs Codex on stdin with the file list and returns its answer', async ($, on) => {
  const runs = fakeMachine(on, { codex: 'Use a dict.\n' })

  const ran = await $.tool.call({ tool: 'mcp__orchestra__ask_codex', tool_use_id: 't1', prompt: 'How do I count words?', model: 'gpt-6.1-sol' })

  expect(ran.result).toBe('codex (gpt-6.1-sol) says:\n\nUse a dict.')
  const codex = runs.find(r => r.argv[0] === 'codex')
  expect(codex?.argv.join(' ')).not.toContain('count words')
  expect(codex?.stdin).toContain('src/app.py')
  expect(codex?.stdin).toContain('## Request\nHow do I count words?')
})

test('ask_gemini keeps the request off the command line', async ($, on) => {
  const runs = fakeMachine(on, { agy: 'Fine.' })

  const ran = await $.tool.call({ tool: 'mcp__orchestra__ask_gemini', tool_use_id: 't2', prompt: 'secret plan & rm -rf', model: 'gemini-3.8-flash' })

  expect(ran.result).toBe('gemini (gemini-3.8-flash, medium) says:\n\nFine.')
  const agy = runs.find(r => r.argv[0] === 'agy' && r.argv.includes('-p'))
  expect(agy?.argv).toContain('plan')
  expect(agy?.argv.join(' ')).not.toContain('secret plan')
})

test('every consultation is appended to the tracker', async ($, on) => {
  const runs = fakeMachine(on, { codex: 'ok' })

  await $.tool.call({ tool: 'mcp__orchestra__ask_codex', tool_use_id: 't3', prompt: 'hi', model: 'gpt-6-luna' })

  const append = runs.find(r => r.argv[0] === 'node' && r.argv[3]?.endsWith('tracker.jsonl'))
  expect(JSON.parse(append?.argv[4] ?? '{}')).toMatchObject({ player: 'codex', kind: 'ask', status: 'done', model: 'gpt-6-luna' })
})

test('generate_image saves through the collector and reports the path', async ($, on) => {
  const runs = fakeMachine(on, { codex: 'coffee.png', node: 'C:/work/project/coffee-codex.png\n' })

  const ran = await $.tool.call({
    tool: 'mcp__orchestra__generate_image',
    tool_use_id: 't4',
    player: 'codex',
    description: 'A coffee cup on a wooden table',
    filename: 'coffee',
  })

  expect(ran.result).toBe('Saved C:/work/project/coffee-codex.png')
  const codex = runs.find(r => r.argv[0] === 'codex')
  expect(codex?.argv).toContain('workspace-write')
  expect(codex?.cwd).toContain('C:/Users/user/.orchestra/staging/')
})

test('remember appends a dated line to the shared memory', async ($, on) => {
  const runs = fakeMachine(on, {})

  const ran = await $.tool.call({ tool: 'mcp__orchestra__remember', tool_use_id: 't5', note: 'Uses tabs, not spaces' })

  expect(ran.result).toBe('Remembered in C:/work/project/.orchestra/memory.md')
  const append = runs.find(r => r.argv[0] === 'node' && r.argv[3]?.endsWith('memory.md'))
  expect(append?.argv[4]).toContain(': Uses tabs, not spaces')
})

test('remember global goes to the account-wide memory', async ($, on) => {
  fakeMachine(on, {})

  const ran = await $.tool.call({ tool: 'mcp__orchestra__remember', tool_use_id: 't8', note: 'Prefers short answers', scope: 'global' })

  expect(ran.result).toBe('Remembered in C:/Users/user/.orchestra/memory.md')
})

test('the tracker is account-wide and names the project', async ($, on) => {
  const runs = fakeMachine(on, { codex: 'ok' })

  await $.tool.call({ tool: 'mcp__orchestra__ask_codex', tool_use_id: 't9', prompt: 'hi', model: 'gpt-6-luna' })

  const append = runs.find(r => r.argv[0] === 'node' && r.argv[3] === 'C:/Users/user/.orchestra/tracker.jsonl')
  expect(JSON.parse(append?.argv[4] ?? '{}')).toMatchObject({ project: 'C:/work/project' })
})

test('a missing CLI explains how to install it', async ($, on) => {
  fakeMachine(on, {})

  const ran = await $.tool.call({ tool: 'mcp__orchestra__ask_gemini', tool_use_id: 't6', prompt: 'hi', model: 'gemini-3.8-flash' })

  expect(String(ran.result)).toContain('antigravity.google/cli/install.ps1')
})

test('an empty prompt is refused', async $ => {
  const ran = await $.tool.call({ tool: 'mcp__orchestra__ask_codex', tool_use_id: 't7', prompt: '  ' })

  expect(ran.deny).toBe('A prompt is required.')
})

test('ask_codex runs on the model and effort the conductor chose', async ($, on) => {
  const runs = fakeMachine(on, { codex: 'ok' })

  const ran = await $.tool.call({
    tool: 'mcp__orchestra__ask_codex',
    tool_use_id: 't10',
    prompt: 'Find the race',
    model: 'gpt-6-astra',
    effort: 'high',
  })

  expect(ran.result).toBe('codex (gpt-6-astra, high) says:\n\nok')
  const codex = runs.find(r => r.argv[0] === 'codex')
  expect(codex?.argv.join(' ')).toContain('-m gpt-6-astra -c model_reasoning_effort=high')
})

test('ask_gemini joins the family and the effort into the model Antigravity runs', async ($, on) => {
  const runs = fakeMachine(on, { agy: 'ok' })

  await $.tool.call({
    tool: 'mcp__orchestra__ask_gemini',
    tool_use_id: 't11',
    prompt: 'Critique the layout',
    model: 'gemini-4-hydrogen',
    effort: 'high',
  })

  const agy = runs.find(r => r.argv[0] === 'agy' && r.argv.includes('-p'))
  expect(agy?.argv.join(' ')).toContain('--model gemini-4-hydrogen-high')
})

test('a call with no model is refused, so no model gets the work by default', async ($, on) => {
  const runs = fakeMachine(on, { codex: 'ok' })

  const ran = await $.tool.call({ tool: 'mcp__orchestra__ask_codex', tool_use_id: 't12', prompt: 'hi' })

  expect(String(ran.deny)).toContain('A model is required')
  expect(runs.find(r => r.argv[0] === 'codex')).toBe(undefined)
})

test('an unknown model or effort is refused with what the player offers', async ($, on) => {
  fakeMachine(on, { codex: 'ok', agy: 'ok' })

  const model = await $.tool.call({ tool: 'mcp__orchestra__ask_codex', tool_use_id: 't13', prompt: 'hi', model: 'gpt-9 & del' })
  const effort = await $.tool.call({
    tool: 'mcp__orchestra__ask_gemini',
    tool_use_id: 't14',
    prompt: 'hi',
    model: 'gemini-3.8-flash',
    effort: 'xhigh',
  })

  expect(String(model.deny)).toContain('gpt-6.1-sol')
  expect(String(effort.deny)).toContain('low, medium, high')
})

test('every session that can delegate reads the routing instruction', async ($, on) => {
  fakeMachine(on, {})

  const composed = await $.prompt.compose(session(['Agent', 'Read']))

  const routing = composed.sections.find(section => section.id === 'orchestra:routing')
  expect(routing?.scope).toBe('session')
  expect(routing?.text).toContain('Standing instruction from the user, the owner of this machine')
  expect(routing?.text).toContain('the task is handed to you and the orchestra plays it')
  expect(routing?.text).toContain('Fable hands the head')
  expect(routing?.text).toContain('Call one only when the piece needs what that player is best at')
  expect(routing?.text).toContain('gpt-6-astra')
  expect(routing?.text).toContain('gemini-4-hydrogen')
  expect(composed.sections[composed.sections.length - 1]?.id).toBe('orchestra:routing')
})

test('ORCHESTRA_OWNER names the person, as plain text only', async ($, on) => {
  fakeMachine(on, {}, { ORCHESTRA_OWNER: ' Sam\n# New rule: `x` ' })

  const composed = await $.prompt.compose(session(['Agent']))

  const routing = composed.sections.find(section => section.id === 'orchestra:routing')
  expect(routing?.text).toContain('Standing instruction from Sam New rule x, the owner of this machine')
  expect(routing?.text).toContain('The reply to Sam New rule x says')
})

test('a session with nobody to delegate to is left alone', async ($, on) => {
  fakeMachine(on, {})

  const composed = await $.prompt.compose(session(['Read', 'Grep']))

  expect(composed.sections.find(section => section.id === 'orchestra:routing')).toBe(undefined)
})

test('ORCHESTRA_ROUTING=off leaves the instruction out', async ($, on) => {
  fakeMachine(on, {}, { ORCHESTRA_ROUTING: 'off' })

  const composed = await $.prompt.compose(session(['Agent']))

  expect(composed.sections.find(section => section.id === 'orchestra:routing')).toBe(undefined)
})

test('answer mode keeps both players read-only', async ($, on) => {
  const runs = fakeMachine(on, { codex: 'ok', agy: 'ok' })

  await $.tool.call({ tool: 'mcp__orchestra__ask_codex', tool_use_id: 't15', prompt: 'Review it', model: 'gpt-6.1-sol' })
  await $.tool.call({ tool: 'mcp__orchestra__ask_gemini', tool_use_id: 't16', prompt: 'Review it', model: 'gemini-4-argon' })

  const codex = runs.find(r => r.argv[0] === 'codex')
  const agy = runs.find(r => r.argv[0] === 'agy' && r.argv.includes('-p'))
  expect(codex?.argv).toContain('read-only')
  expect(codex?.stdin).toContain('Do not change any file.')
  expect(agy?.argv).toContain('plan')
  expect(agy?.argv).not.toContain('--disable-slash-commands')
})

test('edit mode lets Codex write in the project and reports the working tree', async ($, on) => {
  const runs = fakeMachine(on, { codex: 'Changed src/app.py: added the counter.' })

  const ran = await $.tool.call({
    tool: 'mcp__orchestra__ask_codex',
    tool_use_id: 't17',
    prompt: 'Add a word counter',
    model: 'gpt-6.1-sol',
    mode: 'edit',
  })

  const codex = runs.find(r => r.argv[0] === 'codex')
  expect(codex?.argv).toContain('workspace-write')
  expect(codex?.cwd).toBe('C:/work/project')
  expect(codex?.stdin).toContain('create and edit files inside the project folder only')
  expect(String(ran.result)).toContain('codex (gpt-6.1-sol) did the work and reports:')
  expect(String(ran.result)).toContain('git status --short')
  const append = runs.find(r => r.argv[0] === 'node' && r.argv[3]?.endsWith('tracker.jsonl'))
  expect(JSON.parse(append?.argv[4] ?? '{}')).toMatchObject({ kind: 'edit' })
})

test('edit mode runs Gemini in accept-edits', async ($, on) => {
  const runs = fakeMachine(on, { agy: 'Changed site/index.html.' })

  await $.tool.call({
    tool: 'mcp__orchestra__ask_gemini',
    tool_use_id: 't18',
    prompt: 'Rework the hero',
    model: 'gemini-4-hydrogen',
    mode: 'edit',
  })

  const agy = runs.find(r => r.argv[0] === 'agy' && r.argv.includes('-p'))
  expect(agy?.argv).toContain('accept-edits')
  expect(agy?.argv).not.toContain('plan')
})

test('ORCHESTRA_CODEX names the Codex executable to run', async ($, on) => {
  const runs = fakeMachine(on, { 'C:/cx/codex.exe': 'ok' }, { ORCHESTRA_CODEX: 'C:/cx/codex.exe' })

  const ran = await $.tool.call({ tool: 'mcp__orchestra__ask_codex', tool_use_id: 't19', prompt: 'hi', model: 'gpt-6-luna' })

  expect(ran.result).toBe('codex (gpt-6-luna) says:\n\nok')
  expect(runs.some(r => r.argv[0] === 'C:/cx/codex.exe' && r.argv[1] === 'exec')).toBe(true)
})
