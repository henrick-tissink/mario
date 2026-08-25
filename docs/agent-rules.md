# Agent rules

Hooks cover the mechanical half — presence, file touches, turn completion. They can't cover
judgment: whether something you noticed is worth recording, or whether you should look before you
start. That's this block.

Paste it into your repo's `CLAUDE.md`, or into your personal `~/.claude/CLAUDE.md` to get it
everywhere. The same text goes in `AGENTS.md` if you also run Codex.

---

```markdown
## Mario

The team shares a coordination feed. Use it via the `mario_*` MCP tools, or the `mario` CLI.

- **Before starting substantive work in an area you haven't touched this session**, call
  `mario_check` with the files you're about to change. If someone else is already in there, say so
  and ask how to proceed — don't silently work around it or start editing anyway.
- **When you notice a real defect or pain point that's out of scope**, record it with
  `mario_emit(kind: "finding")`. One line. State what's wrong and where, not what you'd do about it.
- **When you finish a distinct piece of work**, `mario_emit(kind: "done")` with one line.
- **Before picking up new work**, `mario_findings` is a good source of known problems.

Do not record: routine progress, things you already fixed this session, style opinions, speculation,
or anything you haven't actually observed. A findings list nobody trusts is worse than no list. If
you're unsure whether something is worth recording, it probably isn't.
```

---

## Why the negative rules are longer than the positive ones

The failure mode for this system is not too few findings, it's too many. An agent that reports every
lint gripe and hypothetical race turns the findings list into noise, and once it's noise nobody opens
it again — including the agents. Duplicate reports are collapsed automatically (same project +
similar wording bumps a counter rather than adding a row), so the residual risk is *plausible but
unobserved* findings, which dedupe can't catch. Hence the last paragraph.

## On collisions

`mario_check` is advisory. It never blocks an edit and it never should — a coordination tool that
stalls work gets removed, and then it protects nothing. The right response to a warning is usually to
mention it to the human, not to stop.

## On honesty toward the agent

Emission is silent toward humans by design, but never toward the agent. If a repo is out of scope,
`mario_emit` says `not recorded — <reason>` rather than reporting a success with a blank project.
An agent that is told its finding was recorded when it was discarded has no way to notice.
