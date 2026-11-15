# claude-orchestra

A Claude Code mod (plugin `orchestra`, marketplace `orchestra-mods`). It adds
a routing section to every session's system prompt and tools that consult
Codex and Gemini. The README explains what it does and why.

This repo is **public**. The owner's account-wide install runs from it, so a
change here changes every session.

## Rules

- **Nothing personal, ever.** No names of people, places, employers, clients
  or machines, no emails, no home-folder paths, no project names from the
  owner's other work, in code, tests, docs, examples or commit messages.
  Anything about the person comes from the machine at run time (an
  environment variable or a file under `~/.orchestra/`), never from the
  source. The author name in `plugin.json` and `LICENSE` is the one exception.
- **Examples are invented.** Test notes, sample prompts and file names use
  neutral content (`src/app.py`, "Prefers short answers").
- **Commits use the GitHub noreply address.** It is set in this clone's local
  git config. Check `git config user.email` before the first commit in a new
  clone.
- **Turn the hook on in every clone:** `git config core.hooksPath .githooks`.
  The pre-commit hook refuses a commit that holds a word from
  `~/.orchestra/private-words.txt`. If it fires, remove the word; do not
  bypass it with `--no-verify`.
- Never commit `.orchestra/` (the mod's own memory and tracker).

## When the owner corrects the orchestra

A correction to how the orchestra behaves, given in any session on any
project, is a change to this repo, not a note in memory:

1. Find where the behaviour comes from. How work is routed, who heads, what
   the reply says: the `routing()` text in `hooks/register.tsx`. What a
   player is told: `brief()`. A tool's inputs or wording: the schemas and
   `$.tool.register` calls. CLI flags: `consult()` and `draw()`.
2. Write the correction as a general rule, in the words of the prompt around
   it. Leave out the project and the incident that prompted it.
3. Add or change a test in `tests/orchestra.test.ts` when the change can be
   tested (the routing text is checked with `toContain`).
4. `claude plugin test` must pass.
5. Raise `version` in `.claude-plugin/plugin.json` (patch for wording, minor
   for behaviour). The installed copy is only replaced when the version
   changes.
6. Branch, conventional commit, PR, merge, push.
7. `claude plugin marketplace update orchestra-mods`, then
   `claude plugin update orchestra@orchestra-mods`. New sessions use it.

## Layout

```
.claude-plugin/plugin.json       name, version
.claude-plugin/marketplace.json  makes the repo its own marketplace
hooks/register.tsx               the whole mod
hooks/node-scripts.ts            `node -e` helpers (the hooks runtime has no Node)
types/index.d.ts                 shared types and the plugin's state
tests/orchestra.test.ts          tests against a faked machine, no credits spent
.githooks/pre-commit             the private-word check
```

## Commands

- Test: `claude plugin test` (in the repo root)
- Validate the manifests: `claude plugin validate .`
