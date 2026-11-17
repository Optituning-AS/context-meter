import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Reading, Segment } from '../types'

const reading = atom({ plugin: 'context-meter', key: 'reading' } as const, null, {
  shape: 'reading-3',
})

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    // Clears the line the status-line version of this mod pinned.
    $.ui.status(undefined)
    await refresh($)

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

    if (e.props.hasSurvey || now === null) {
      return next(e)
    }

    // Desktop: a thin rounded SVG bar. Other surfaces have no Svg element.
    if (e.surface === 'desktop') {
      const { Box, Svg, Text } = $.ui.resolve(e)
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
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>{now.percent}% used</Text>
        <Text dimColor>
          {k(now.used)} / {k(now.max)}
        </Text>
      </Box>
    )
  })
}
