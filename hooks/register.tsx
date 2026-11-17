import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Reading, Segment } from '../types'

const reading = atom({ plugin: 'context-meter', key: 'reading' } as const, null, {
  shape: 'reading-3',
})
// True once the person closed the band in this session.
const isHidden = atom({ plugin: 'context-meter', key: 'isHidden' } as const, false)

// The Context panel's four coloured rows keep their colours; the rest are grey.
// Greys are translucent so they read on a light or a dark theme.
const NAMED_COLORS: Record<string, string> = {
  Messages: '#5b8def',
  'MCP tools': '#d97a3e',
  'System tools': '#4fa88b',
  'System prompt': '#d4a72c',
}
const PLAIN_COLOR = '#5b8def'
const USED_GREY = 'rgba(128,128,128,0.75)'
const BUFFER_GREY = 'rgba(128,128,128,0.45)'
const FREE_GREY = 'rgba(128,128,128,0.2)'

// 262100 -> "262.1k", 400000 -> "400k"
const k = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    const millions = Math.round(tokens / 100_000) / 10

    return `${millions}M`
  }

  const value = Math.round(tokens / 100) / 10

  return `${Number.isInteger(value) ? value : value.toFixed(1)}k`
}

// The bar is drawn in an 800-unit-wide box and stretched to the room it gets.
// 800 is close to its usual width in pixels, so the round ends stay round.
const BAR_WIDTH = 800
const BAR_HEIGHT = 8
const BAR_GAP = 5
// The smallest share a segment is drawn at: wide enough to read as a pill.
const MIN_SHARE = 2

type Bar = Segment & { share: number }

// Whole percents that add up to 100, at least MIN_SHARE each.
const toBars = (segments: Segment[]): Bar[] => {
  const drawn = segments.filter(segment => segment.tokens > 0)
  const total = drawn.reduce((sum, segment) => sum + segment.tokens, 0) || 1
  const bars = drawn.map(segment => ({
    ...segment,
    share: Math.max(MIN_SHARE, Math.round((segment.tokens / total) * 100)),
  }))

  // The widest one takes the rounding error.
  const over = bars.reduce((sum, bar) => sum + bar.share, 0) - 100
  const widest = bars.reduce<Bar | undefined>(
    (best, bar) => (best === undefined || bar.share > best.share ? bar : best),
    undefined,
  )

  if (widest !== undefined) {
    widest.share = Math.max(MIN_SHARE, widest.share - over)
  }

  return bars
}

const svgBar = (bars: Bar[]): string => {
  const unit = BAR_WIDTH / 100
  const radius = BAR_HEIGHT / 2
  let x = 0

  // Each segment is a pill of its own: a rect with fully rounded ends.
  const pills = bars.map((bar, index) => {
    const isLast = index === bars.length - 1
    const width = Math.max(BAR_HEIGHT, bar.share * unit - (isLast ? 0 : BAR_GAP))
    const pill = `<rect x="${x}" y="0" width="${width}" height="${BAR_HEIGHT}" rx="${radius}" ry="${radius}" fill="${bar.color}"/>`
    x += bar.share * unit

    return pill
  })

  // Wider than any band, so the surface scales it down to the room there is.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${BAR_HEIGHT}" viewBox="0 0 ${BAR_WIDTH} ${BAR_HEIGHT}" preserveAspectRatio="none">`,
    pills.join(''),
    '</svg>',
  ].join('')
}

// The terminal's bar: one heavy line character per cell, never under 20 cells
// (room for every category to get one).
const TEXT_BAR_GLYPH = '\u2501'
const TEXT_BAR_MIN = 20
const CLOSE_GLYPH = '\u00d7'

// A terminal has no see-through colours, so the greys are solid there.
const TEXT_COLORS: Record<string, string> = {
  [USED_GREY]: '#8a8a8a',
  [BUFFER_GREY]: '#5c5c5c',
  [FREE_GREY]: '#3a3a3a',
}

type Run = { color: string; cells: number }

// Shares turned into whole cells that add up to `width`, at least 1 each.
const toRuns = (bars: Bar[], width: number): Run[] => {
  const runs = bars.map(bar => ({
    color: TEXT_COLORS[bar.color] ?? bar.color,
    cells: Math.max(1, Math.round((bar.share / 100) * width)),
  }))

  // The widest one takes the rounding error.
  const over = runs.reduce((sum, run) => sum + run.cells, 0) - width
  const widest = runs.reduce<Run | undefined>(
    (best, run) => (best === undefined || run.cells > best.cells ? run : best),
    undefined,
  )

  if (widest !== undefined) {
    widest.cells = Math.max(1, widest.cells - over)
  }

  return runs
}

const toReading = (context: SessionContextUsage): Reading | null => {
  const breakdown = context.breakdown

  // No breakdown: one plain segment from the status line's figures, if any.
  if (breakdown === undefined) {
    if (context.tokens === undefined) {
      return null
    }

    return {
      used: context.tokens,
      max: context.window,
      percent: context.percent ?? Math.round((context.tokens / context.window) * 100),
      segments: [
        { name: 'Used', tokens: context.tokens, color: PLAIN_COLOR },
        { name: 'Free space', tokens: Math.max(0, context.window - context.tokens), color: FREE_GREY },
      ],
    }
  }

  // Largest first, as the Context panel lists them.
  const used = breakdown.categories
    .filter(row => row.kind === 'used' && row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  const buffer = breakdown.categories.filter(row => row.kind === 'buffer' && row.tokens > 0)
  const free = breakdown.categories.filter(row => row.kind === 'free' && row.tokens > 0)

  const segments: Segment[] = [
    ...used.map(row => ({
      name: row.name,
      tokens: row.tokens,
      color: NAMED_COLORS[row.name] ?? USED_GREY,
    })),
    // Free comes before the buffer: the gap you see is what is left before
    // auto-compact, and the buffer is the reserve at the far end.
    ...free.map(row => ({ name: row.name, tokens: row.tokens, color: FREE_GREY })),
    ...buffer.map(row => ({ name: row.name, tokens: row.tokens, color: BUFFER_GREY })),
  ]

  return {
    used: breakdown.totalTokens,
    max: breakdown.rawMaxTokens,
    percent: breakdown.percentage,
    segments,
  }
}

const refresh = async ($: EngineInterface): Promise<void> => {
  // A failed reading keeps the old band; it must never break a turn.
  try {
    // "summary" estimates locally; "full" would send a request per tool.
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const next = toReading(context)

    // Right after a compaction there is no reading yet: keep the last one.
    if (next !== null) {
      await update($, reading, () => next)
    }
  } catch {
    return
  }
}

const COMMAND = 'context-meter'
const CLOSE_KEY = 'close:'

// The Button needs a closure; the work is done by the `ui.press` hook.
const noop = (): void => {}

export const register: Register = on => {
  // The close button's key names the session it was drawn for, so a press
  // can only ever hide the band of that session.
  on('ui.press', async ($, e, next) => {
    const isOurs = e.plugin === $.plugin.name && e.element === CLOSE_KEY + (await $.session.id())

    if (isOurs) {
      await update($, isHidden, () => true)
      $.ui.toast(`Context meter hidden for this session. /${COMMAND} brings it back.`)
    }

    return next(e)
  })

  // /context-meter shows the band again, or hides it.
  on('command.run', { command: COMMAND }, async $ => {
    const hidden = await update($, isHidden, value => !value)

    return { text: hidden ? 'Context meter hidden for this session.' : 'Context meter shown.' }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    // Clears the line the status-line version of this mod pinned.
    $.ui.status(undefined)
    await refresh($)

    // Last, and never fatal: the band must not depend on the command.
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Show or hide the context meter band in this session',
      })
    } catch {
      return started
    }

    return started
  })

  // Fires after each turn, when the fill moved.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await refresh($)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, reading)

    if (e.props.hasSurvey || now === null || (await read($, isHidden))) {
      return next(e)
    }

    const closeKey = CLOSE_KEY + (await $.session.id())

    // Desktop: a thin rounded SVG bar. Other surfaces have no Svg element.
    if (e.surface === 'desktop') {
      const { Box, Button, Svg, Text } = $.ui.resolve(e)
      const bars = toBars(now.segments)

      return (
        <Box flexDirection="row" alignItems="center" gap="md" paddingX="xs" width="100%">
          <Box flexShrink={0}>
            <Text size="caption" weight="medium" tabular>
              {now.percent}% used
            </Text>
          </Box>

          {/* Asks for the whole row and shrinks to what the fixed parts leave. */}
          <Box width="100%" flexGrow={1} flexShrink={1} minWidth={0}>
            <Svg
              source={svgBar(bars)}
              alt={`${now.percent}% of the context window used`}
              height={BAR_HEIGHT}
            />
          </Box>

          <Box flexShrink={0}>
            <Text size="caption" dimColor tabular>
              {k(now.used)} / {k(now.max)}
            </Text>
          </Box>

          <Box flexShrink={0}>
            <Button key={closeKey} plain dimColor label={CLOSE_GLYPH} onPress={noop} />
          </Box>
        </Box>
      )
    }

    // Everywhere else (the terminal): the same line, the bar made of
    // coloured line characters sized to the columns there are.
    const { Box, Button, Text } = $.ui.resolve(e)
    const left = `${now.percent}% used`
    const right = `${k(now.used)} / ${k(now.max)}`
    // Two gaps around the bar, and a gap and one cell for the close mark.
    const room = e.props.bodyColumns - left.length - right.length - 4
    const runs = toRuns(toBars(now.segments), Math.max(TEXT_BAR_MIN, room))

    return (
      <Box flexDirection="row" gap={1}>
        <Text>{left}</Text>
        <Text>
          {runs.map(run => (
            <Text color={run.color}>{TEXT_BAR_GLYPH.repeat(run.cells)}</Text>
          ))}
        </Text>
        <Text dimColor>{right}</Text>
        <Button key={closeKey} plain dimColor label={CLOSE_GLYPH} onPress={noop} />
      </Box>
    )
  })
}
