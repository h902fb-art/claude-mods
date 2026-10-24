export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Measure = {
  tokens: number | null
  window: number
  percent: number | null
  limits: Limit[]
}
export type Agent = { id: string; type: string; description: string; status: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-panel': {
      measure: Shaped<Measure | null>
      skills: Shaped<Record<string, number>>
      agents: Shaped<Agent[]>
    }
  }
}
