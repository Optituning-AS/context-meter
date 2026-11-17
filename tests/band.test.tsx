import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'context-meter',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const row = (name: string, tokens: number, kind: 'used' | 'free' | 'buffer') => ({
  name,
  tokens,
  color: 'inactive',
  isDeferred: false,
  kind,
})

// What the engine answers `$.session.usage({ breakdown })` with: 211.3k of 400k.
const USAGE = {
  startedAt: 0,
  rateLimits: [],
  context: {
    tokens: 211_300,
    window: 1_000_000,
    percent: 21,
    breakdown: {
      categories: [
        row('System prompt', 12_100, 'used'),
        row('MCP tools', 19_400, 'used'),
        row('System tools', 17_400, 'used'),
        row('Skills', 18_600, 'used'),
        row('Messages', 143_800, 'used'),
        row('Free space', 155_700, 'free'),
        row('Autocompact buffer', 33_000, 'buffer'),
      ],
      totalTokens: 211_300,
      maxTokens: 400_000,
      rawMaxTokens: 400_000,
      autocompactSource: 'settings',
      percentage: 53,
      gridRows: [],
      model: 'test',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      autoCompactThreshold: 367_000,
      isAutoCompactEnabled: true,
      apiUsage: null,
    },
  },
} as const

test('the band shows percent and tokens on every surface', async ($, on) => {
  // Each hook here stands for the engine beneath the mod.
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'context-meter' } }))
  on('session.id', () => ({ value: 'session-a' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /% used/ }))?.text).toBe('53% used')
    expect((await ui.find({ type: 'Text', text: /400k/ }))?.text).toBe('211.3k / 400k')
    await ui.unmount()
  }
})

test('the terminal draws the bar as a line that fits the columns', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'context-meter' } }))
  on('session.id', () => ({ value: 'session-a' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const bar = await ui.find({ type: 'Text', text: /━/ })

  // 80 columns, less "53% used", "211.3k / 400k", the close mark and three gaps.
  expect(bar?.text.length).toBe(80 - '53% used'.length - '211.3k / 400k'.length - 4)
  await ui.unmount()
})

test('the close button hides the band for the session it was drawn in', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'context-meter' } }))
  on('session.id', () => ({ value: 'session-a' }))
  // The engine draws nothing of its own in the band.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>empty</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /% used/ }))?.text).toBe('53% used')

  await ui.press({ key: 'close:session-a' })

  expect(await ui.find({ type: 'Text', text: /% used/ })).toBe(undefined)
  await ui.unmount()
})
