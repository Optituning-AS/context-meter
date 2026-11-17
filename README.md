# context-meter

A Claude Code mod that shows how full your context window is, in a thin band above the prompt.

It shows three things on one line:

- The percent of the context window used.
- A bar with one pill per category (messages, MCP tools, system tools, system prompt and so on). The last pill is the auto-compact buffer.
- Used tokens out of the window size, for example `211.3k / 400k`.

The band updates after every turn. It reads the same figures as the built-in Context panel.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install context-meter --marketplace Optituning-AS/context-meter
```

Answer `y` to add the marketplace, then pick the user scope with Enter.

From a shell:

```
claude plugin install context-meter --marketplace Optituning-AS/context-meter
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Optituning-AS/context-meter`, then Add plugin.

## Hiding the band

Click the `×` at the right end of the band to hide it. This hides it in that session only. Other sessions keep theirs, and new sessions start with it showing.

To bring it back, run `/context-meter` in that session. The same command also hides it.

## Updating

From a shell:

```
claude plugin marketplace update context-meter
claude plugin update context-meter@context-meter
```

Then restart Claude Code, or run `/reload-plugins` in an open session.

## Notes

- The desktop app draws the bar as rounded pills. The terminal draws it as a coloured line.
- If you set an auto-compact window for your model, the band measures against that window.

## License

MIT. See [LICENSE](LICENSE).
