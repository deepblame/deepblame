# DeepBlame for VS Code

Shows which AI agent wrote each line of the file you have open, what it was
asked for, and what that turn cost — and lets you undo one agent's work without
touching anyone else's.

It reads the same ledger the `deepblame` CLI writes, so anything your agents
have already recorded shows up the moment you install this. Nothing is sent
anywhere; the answer comes from a git ref in your own repository.

## What you see

- **A green mark** down the left edge of every line an agent wrote, and the same
  mark in the scrollbar so you can see the shape of it in a long file.
- **A grey note at the end of the line your cursor is on**: the agent's name and
  the prompt behind that line — the thing `git blame` cannot tell you.
- **On hover**: the model, the prompt, how long ago, the tool calls, the dollars,
  and how sure the answer is, with the reason. Plus two links: *Undo this run*
  and *Everything it did*.
- **In the status bar**: how much of this file an agent wrote.

Lines nobody can prove are left unmarked. A line whose spacing a formatter has
changed is marked `~` and reported at 70%, not claimed outright. This is the
one rule the whole tool rests on: never claim a line it cannot prove.

## Requirements

A repository where DeepBlame is set up:

```
npx deepblame init
```

That installs the hooks for whichever agents you have. From then on every turn
is recorded, and this extension has something to show.

## Commands

| Command | What it does |
| --- | --- |
| `DeepBlame: Show or hide who wrote each line` | Toggles the marks. Also the status bar item. |
| `DeepBlame: Explain this line` | The whole story for the line the cursor is on, with an Undo button. |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `deepblame.enabled` | `true` | Annotate lines an agent wrote. |

## Undoing a run

The hover's *Undo this run* link shows you the plan before anything is written:
every file it would touch, how many lines go back, and which files changed too
much since to be put back on their own. Those are left alone rather than merged
badly. Nothing is written until you confirm.

## Installing from a .vsix

Until this is on the Marketplace:

1. Download `deepblame-vscode-0.3.1.vsix`.
2. In VS Code: `Extensions` → `...` → `Install from VSIX...`, or
   `code --install-extension deepblame-vscode-0.3.1.vsix`.
3. Reload.

## A note on what has been tested

The part that decides what every mark and message says, and the part that wires
it to the editor, are both covered by tests that run the extension against a
real repository and a real ledger — 53 of them. What those cannot check is
appearance: whether the green reads well in your theme, where the hover box
lands, how the note sits at the end of a long line. If something looks wrong,
that is the kind of thing to report.

## Licence

Apache-2.0, same as the rest of DeepBlame.
