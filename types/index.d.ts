export type Segment = { name: string; tokens: number; color: string }

export type Reading = {
  used: number
  max: number
  percent: number
  segments: Segment[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { reading: Shaped<Reading | null> }
  }
}
