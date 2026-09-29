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

## Your whole team, one record

```sh
npx deepblame push        # send your runs to the team
npx deepblame pull        # take in everyone else's
```

The ledger is a git ref, so sharing it is what git already does well. Joining two ledgers cannot conflict by construction: a run's path is its own id and never changes, and stored file contents are keyed by their hash. The contents travel too, so after a `pull` you can blame *and* revert a colleague's agent from your own machine.

## Who wrote this pull request

```sh
npx deepblame report --base origin/main
```

```
50% of this change was written by agents  14 of 28 lines

  claude-code   11 lines   2 runs
  cursor         3 lines   1 run
```

Only the lines the change touches are counted, so nothing that was reviewed weeks ago is counted again. `--markdown` gives the comment version; the repository has a drop-in GitHub Action that posts it on every pull request.

## It speaks the standard

[Agent Trace](https://agent-trace.dev) is the interchange format Cursor published with Anthropic, Cognition, Cloudflare, Vercel and Google behind it. DeepBlame writes it and reads it, so your attribution is not trapped in one tool.

```sh
npx deepblame trace export
npx deepblame trace import ./traces
```

Imported attribution is kept apart from what we watched: marked **reported**, blamed with the reporting tool named, and never reverted — a trace carries no before-image, so there is nothing to put back.

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
| `deepblame report` | How much of a branch or pull request an agent wrote |
| `deepblame trace export` | Write the ledger as Agent Trace records other tools read |
| `deepblame trace import` | Take in attribution another tool recorded |
| `deepblame push` | Send this machine's runs to the team's remote |
| `deepblame pull` | Take in the team's runs and fold them into yours |
| `deepblame doctor` | Check recording is working, and say what to fix |
| `deepblame gc` | Age old file contents out of the ledger |
| `deepblame seal` | Fold captured events into the ledger now |
| `deepblame hooks <action>` | Install, uninstall or check the capture hooks |

## What `init` does, and what it never does

- Creates the ledger as a separate git ref, `refs/deepblame/ledger`. It is never checked out, so your branches, working tree and index stay exactly as they were.
- Creates `.deepblame/` for local state. The folder ignores itself, so your `.gitignore` is not touched.
- Copies the small capture program into `.deepblame/bin/` and points the hooks at it by full path, so recording does not depend on anything staying on `PATH`.
- Detects the agents in the project and wires up the ones it can. Use `--no-hooks` to skip that.
- Never needs your git identity and never signs with your key.
- Never sends anything anywhere.

Not recording? `deepblame doctor` says why, and what to do about it.

There is also a VS Code extension over the same ledger — the agent and the prompt beside the line, and undo from the hover. It is in the repository, not on the Marketplace yet.

**Status: pre-alpha, and already useful.** Recording, blame, cost, revert, team sharing, pull request reports and Agent Trace interop all work today.

[Source and full documentation](https://github.com/deepblame/deepblame) · [deepblame.com](https://deepblame.com) · Apache-2.0
