export type Player = 'codex' | 'gemini'

// One model a player can run on. For Gemini the id is the family
// (`gemini-4-hydrogen`) and the CLI's model is `<id>-<effort>`.
export type Model = {
  id: string
  label: string
  hint: string
  efforts: string[]
}

// What each player offers on this machine, as ~/.orchestra/models.json keeps it.
export type Catalog = {
  fetchedAt: number
  codex: Model[]
  gemini: Model[]
}

// One consultation or image request, as the pane draws it and the tracker
// (.orchestra/tracker.jsonl) keeps it.
export type Performance = {
  id: string
  player: Player
  kind: 'ask' | 'edit' | 'image'
  prompt: string
  status: 'playing' | 'done' | 'failed'
  startedAt: number
  model?: string
  effort?: string
  ms?: number
  note?: string
  output?: string
}

declare module 'claude-code' {
  interface PluginState {
    orchestra: { performances: Performance[]; catalog: Catalog }
  }
}
