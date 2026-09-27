# DeepBlame

**The system of record for AI-written code.** Which agent wrote this line. Why. What it cost. And how to take one agent's work back out without losing anyone else's.

```sh
npx deepblame init
```

Node 20 or newer, any git repository, nothing to sign up for. Everything below runs on your machine; no code is sent anywhere.

## Which agent wrote this line

```sh
npx deepblame blame src/upload.ts
```

```
src/upload.ts  10 lines, 50% traced, 50% written by agents

  1-4          you, or a tool nobody recorded
  5-9          claude-code  feb92f2  add a retry  90%  changed elsewhere since, this line came through
  10           you, or a tool nobody recorded
```

The percentage is not decoration. A line is claimed only when it can be followed from the state the run left to the file as it stands now; anything else is reported as unknown rather than guessed. It survives edits elsewhere in the file, follows the file through renames, and keeps the line at a lower confidence when a formatter reindents everything.

## Undo one agent's work, keep everyone else's

```sh
npx deepblame revert --agent claude-code
```

An agent adds a retry loop to `upload.js`. You rename the export in the same file. Revert takes the retry loop out and leaves your rename alone. A plain three-way merge cannot do that — two changes on adjacent lines conflict — because DeepBlame has something git does not: a record of which lines belong to the agent.

Nothing is written without `--apply`. Conflicts are shown first, and a file the agent created but you have edited since is never deleted for you.

## What the agents spent

```sh
npx deepblame cost --days 7
```

Tokens and money, per turn, per model, per agent, read from the agent's own session log. Where the agent reports its own price, that figure is used instead of ours. A model with no known rate is left blank rather than guessed at.

## Which tools are covered

| Tool | How | What you get |
| --- | --- | --- |
| Claude Code | its own hooks, installed by `init` | every prompt, tool call and edit, with model and cost |
| Cursor | its own hooks, installed by `init` | every prompt, read and edit, with the exact strings it replaced |
| OpenCode | a plugin, installed by `init` | the same, with the tokens and price OpenCode itself reports |
| Codex | `hooks install --agent codex` | one run per turn, with the files it changed |
| Anything else | `hooks install --agent git` | one run per commit, with the lines it changed |

Any other tool can report with one JSON object per call on stdin — no SDK, no dependency. See the repository for the format.

## Commands

| Command | What it does |
| --- | --- |
| `deepblame init` | Set up the ledger, local state and capture hooks |
| `deepblame status` | Show what is set up and what is being recorded |
| `deepblame log` | List recorded agent runs, newest first |
| `deepblame show <run>` | Show one run in full: prompt, tools, files, cost |
| `deepblame blame <file>` | Which agent wrote each line, and how sure we are |
| `deepblame cost` | What the agents spent, by model and by agent |
| `deepblame revert` | Undo one agent's work and nobody else's |
| `deepblame doctor` | Check recording is working, and say what to fix |
| `deepblame gc` | Age old file contents out of the ledger |
| `deepblame seal` | Fold captured events into the ledger now |
| `deepblame hooks <action>` | Install, uninstall or check the capture hooks |

## What `init` does, and what it never does

- Creates the ledger as a separate git ref, `refs/deepblame/ledger`. It is never checked out, so your branches, working tree and index stay exactly as they were.
- Creates `.deepblame/` for local state. The folder ignores itself, so your `.gitignore` is not touched.
- Detects the agents in the project and wires up the ones it can. Use `--no-hooks` to skip that.
- Never needs your git identity and never signs with your key.
- Never sends anything anywhere.

Not recording? `deepblame doctor` says why, and what to do about it.

**Status: pre-alpha, and already useful.** Recording, blame, cost and revert all work today.

[Source and full documentation](https://github.com/deepblame/deepblame) · [deepblame.com](https://deepblame.com) · Apache-2.0
