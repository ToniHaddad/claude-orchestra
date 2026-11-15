# claude-orchestra

A Claude Code mod that makes Claude the conductor in every session. The task
goes to the session's model; it decides who does each piece (itself, a Claude
subagent on Haiku, Sonnet or Opus, **OpenAI Codex** through `codex exec`, or
**Google Gemini** through Antigravity's `agy -p`), on which model and effort,
and reviews what comes back. Either outside player can also draw images into
the project.

## The problem

The strongest models are slow and draw on limited quota, and small models
give weak answers on hard problems. Sending everything to one model wastes
one or the other. Choosing by hand for every piece of work does not last a
day. This mod puts the choice in the system prompt, so it is made for every
task, and gives the session the tools to reach two other vendors' models.

## Always on

Nothing has to be typed. A `prompt.compose` hook adds one section,
`orchestra:routing`, to the system prompt of every session that can delegate.
It lists the players and the models this machine has today and gives the rule:
the cheapest model that will do the piece well, one step up only when a result
falls short, never everything to one model, and a one-line "Routing: ..." note
in the reply.

Fable receives every task and decides who heads it: itself when the task
needs its level, or one Opus subagent it names head for long, well-understood
work. Claude subagents are the first choice for delegated pieces. Codex and
Gemini are called only when a piece needs what they are best at (Codex: code;
Gemini: very large reads and anything visual) or when an independent view is
worth the wait.

Each call to Codex or Gemini takes a `mode`: `answer` (read-only) or `edit`
(the player does the work itself, writing inside the project folder: Codex's
`workspace-write` sandbox, Antigravity's `accept-edits`). An `edit` result
ends with `git status --short` so the head can review what changed.

`ask_codex` and `ask_gemini` refuse a call that names no model, so no model
gets the work by default. The models come from `~/.orchestra/models.json`,
which the mod rebuilds once a day from Codex's own catalogue and
`agy models`; a session keeps the list it started with.

## What it adds

| Command | What it does |
|---|---|
| `/orchestra <task>` | Put one task to both players in parallel, compare, synthesize |
| `/codex [model] [effort] <q>`, `/gemini [model] [effort] <q>` | Ask one player directly |
| `/orchestra-models [refresh]` | Show the models each player offers, or ask the CLIs again |
| `/image [codex\|gemini\|both] <description>` | Draw an image into the current folder |
| `/remember [global] <note>` | Add to the shared memory |
| `/orchestra-memory` | Show the account-wide and project memory |
| `/tracker` | Last 15 consultations and images, across all projects |
| `/orchestra-pane` | Live pane: who is playing, done, failed |

The model gets the same as tools: `ask_codex`, `ask_gemini`,
`generate_image`, `remember`.

Every player is briefed with the shared memory and the project's file list
(`git ls-files`) and can read the project's files. In `answer` mode both run
read-only (Codex `--sandbox read-only`, Antigravity `--mode plan`); in `edit`
mode they write inside the project folder. For images each runs in its own
staging folder, and the mod copies the finished file into the project.

## Setup

The mod needs Node.js on `PATH` (it writes its memory, tracker and staging
folders through `node`). Install and sign in to the two CLIs (either can be
left out; the mod says so when a missing one is called):

```
npm install -g @openai/codex                            # then run `codex` once to sign in
irm https://antigravity.google/cli/install.ps1 | iex    # then run `agy` once to sign in
```

Then add the mod:

```
claude plugin marketplace add ToniHaddad/claude-orchestra
claude plugin install orchestra@orchestra-mods --scope user
```

### Settings

All are environment variables, read on the machine the session runs on.

| Variable | What it does |
|---|---|
| `ORCHESTRA_OWNER` | The name the routing instruction uses for you. Unset: "the user". |
| `ORCHESTRA_ROUTING=off` | Leaves the standing instruction out. The tools and commands stay. |
| `ORCHESTRA_CODEX` | Full path of the Codex executable to run in place of the one on `PATH`. |

## Where it keeps things

```
~/.orchestra/memory.md          about the owner, briefed in every project
~/.orchestra/tracker.jsonl      one line per call, with its model and effort
~/.orchestra/models.json        the models each player offers, rebuilt daily
~/.orchestra/staging/           per-request working folders (safe to delete)
<project>/.orchestra/memory.md  decisions about one project
```

All of it stays on your machine. The mod sends nothing anywhere itself: a
request leaves the machine only through the Codex and Antigravity CLIs you
signed in to, and it carries the brief (your request, the shared memory and
the project's file list).

## Architecture

```
hooks/register.tsx      the mod: routing section, tools, commands, pane
hooks/node-scripts.ts   small `node -e` programs for folders, appends, image copies
types/index.d.ts        Player, Model, Catalog, Performance
tests/                  the mod run against a faked machine
```

- **No shell injection.** Codex gets its prompt on stdin, so its argv is
  fixed flags and safe to pass through `cmd.exe` (npm installs `.cmd` shims
  on Windows). Antigravity takes a prompt argument, so the request is written
  to a file and `agy` is only told the file's path; it runs as a native
  binary, never through a shell.
- **Binary files without Node in the hooks.** The hooks runtime has no Node
  and `$.fs` writes text only, so folders, appends and image copies go
  through tiny `node -e` scripts (`hooks/node-scripts.ts`), every path its
  own argv entry.
- **Antigravity finishes images after it exits.** Its background agent saves
  into `~/.gemini/antigravity-cli/brain/<conversation>/`, so the collector
  polls there for up to 4 minutes.
- **Tests fake the machine** by answering `process.run`, `fs.*`, `env.get`
  and `session.cwd` in the test kit: no credits spent. Run them with
  `claude plugin test`.
- **Codex on Windows needs a short install path.** Its sandbox helper cannot
  start from a path longer than 260 characters, and a global npm install
  under winget's Node folder is 274. Then every shell command Codex tries
  fails, in read-only mode too. Install a second copy under a short folder
  and name its executable in `ORCHESTRA_CODEX`:
  `npm install -g @openai/codex --prefix %LOCALAPPDATA%\codex-cli`, then
  `...\codex-cli\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`.
- **Antigravity's plan mode needs slash commands on.** With
  `--disable-slash-commands`, `--mode plan` has no effect and `agy` can edit,
  so answer mode leaves the flag out.

## Working on it

```
git clone https://github.com/ToniHaddad/claude-orchestra
cd claude-orchestra
git config core.hooksPath .githooks
claude plugin test
```

The pre-commit hook refuses a commit that holds a word from your own private
list (`~/.orchestra/private-words.txt`, one regex per line, never committed).
It keeps personal details out of a public repo.

To run a local clone as the installed mod, add the folder as the
marketplace in place of the GitHub one: `claude plugin marketplace add .`

## What I learned

Google shut off the Gemini CLI for personal accounts on 2026-06-18
(`IneligibleTierError: UNSUPPORTED_CLIENT`) and pointed users to
Antigravity. Any tool built on a single vendor's CLI can break overnight, so
each player sits behind one function (`runCodex`, `runAgy`) and swapping a
backend is a small edit.

## What I'd improve

- Two image requests to the same player at once can pick up each other's
  file; tag requests so the collector matches by name.
- Stream partial output into the pane instead of waiting for exit.
- A vote round where each player critiques the others' answers.
- The setup lines are for Windows, where it was built and tested. The mod
  falls back to `HOME` and plain `PATH` lookups elsewhere, but macOS and
  Linux are untested.

## Licence

MIT. See [LICENSE](LICENSE).
