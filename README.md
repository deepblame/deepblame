<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo-dark.png">
    <img src="brand/logo-light.png" alt="DeepBlame" width="380">
  </picture>
</p>

<p align="center"><b>See what your AI agents did to your codebase, understand why, and undo just that.</b></p>

---

`git blame` tells you who committed a line. When three agents and two people work in the same repository, that is not enough. DeepBlame records which agent wrote each line, with which model and instructions, after reading which files, and lets you revert one agent's work without throwing away everyone else's.

> **Status: pre-alpha.** Recording works today for **Claude Code**: every prompt, tool call and file edit is captured and sealed into the ledger, and `deepblame log` and `deepblame show` read it back. OpenCode, Codex and Cursor adapters, `blame --why` and surgical revert are being built in the open. See the [roadmap](#roadmap).

## Quick start

Run it inside any git repository. Node 20 or newer, no install needed:

```sh
npx deepblame init
```

```
DeepBlame is set up in ~/code/app

  ✓ ledger   refs/deepblame/ledger  created, genesis a591f4c
  ✓ state    .deepblame/  created; it ignores itself, your .gitignore is untouched
  ✓ capture  .claude/settings.json  Claude Code reports every edit
  · agents   Claude Code (.claude/, claude on PATH)

Recording is on. Run deepblame log after your next agent turn.
```

Let your agent work, then look at what it did:

```sh
npx deepblame log
```

```
DeepBlame  ~/code/app

  43ac7f2  4 minutes ago  claude-code  add the retry to the upload path  3 files  11 tool calls
  9b1e5d0  2 hours ago    claude-code  fix the flaky checkout test       1 file    4 tool calls

2 runs shown. deepblame show <run> for the detail.
```

```sh
npx deepblame show 43ac7f2
```

```
run 43ac7f2a-4564-43fa-8dfc-8c805b6a4429

  agent    claude-code
  started  2026-09-26T15:37:10.781Z
  ended    2026-09-26T15:41:02.113Z  3m 51s
  intent   add the retry to the upload path
  where    main @ 6e4130d
  tools    11  Read ×5, Edit ×3, Bash ×3

  wrote
    src/upload.ts   2 hunks, cc798ff → 66d48fc
    src/retry.ts    1 hunk, new → 1a4b7c2
```

Every run also carries what it cost, read from the agent's own session log:

```sh
npx deepblame cost --days 7
```

```
DeepBlame spend  ~/code/app

  period     last 7 days  38 runs
  tokens     4.2M in · 210.4k out · 18.9M cached
  total      $84.15

  by model
    claude-opus-4-5-20260114   31 runs   $79.40
    claude-haiku-4-5-20251001   7 runs    $4.75
```

Rates for models we do not know yet are left blank rather than guessed; add your own under `pricing` in `.deepblame/config.json` and the numbers appear.

## What `init` does, and what it never does

- Creates the ledger as a separate git ref, `refs/deepblame/ledger`. It is never checked out, so your branches, working tree and index stay exactly as they were.
- Creates `.deepblame/` for local state. The folder ignores itself, so your `.gitignore` is not touched and the folder can never be committed by accident.
- Detects the agent tools in the project (OpenCode, Claude Code, Codex, Cursor) and, for Claude Code, adds capture hooks to `.claude/settings.json`. Use `--no-hooks` to skip that, `--local` to keep the hooks out of git, and `deepblame hooks uninstall` to take them back out.
- Never needs your git identity and never signs with your key, so a signing prompt can never block an agent.
- Never sends code anywhere. Everything above is local.

Running `init` again is safe: it finds the existing ledger and repairs anything missing.

## How recording works

1. A hook calls `deepblame-capture` on every prompt, tool call and edit. It is a 10 KB bundle that appends one line to `.deepblame/queue.ndjson` and exits: no git process, no schema library, no network.
2. When the agent stops, the sealer turns that turn into one run record, validates it, and commits it to the ledger ref with git plumbing.
3. Nothing about your code leaves the machine. A run holds paths, git object ids, line ranges and hashes of prompts and tool arguments; the prompt itself is only recorded if you turn it on in `.deepblame/config.json`.

## Commands

| Command | What it does |
| --- | --- |
| `deepblame init` | Set up the ledger, local state and capture hooks |
| `deepblame status` | Show what is set up and what is being recorded |
| `deepblame log` | List recorded agent runs, newest first |
| `deepblame show <run>` | Show one run in full |
| `deepblame cost` | What the agents spent, by model and by agent |
| `deepblame seal` | Fold captured events into the ledger now |
| `deepblame hooks <action>` | `install`, `uninstall` or `status` for capture hooks |

Options: `-C <dir>` runs as if started in another directory, `--limit <n>` bounds `log`, `--json` prints machine-readable output, `--no-seal` lists only what is already in the ledger.

## Roadmap

1. **Foundation** — ledger, local state, agent detection. *Done.*
2. **Capture** — Claude Code adapter, queue, sealer, model and cost accounting. *Done.* OpenCode, Codex and Cursor adapters plus a git fallback that works with any tool: next.
3. **`deepblame blame --why`** — line-by-line provenance that survives edits, merges and reformatting, with a confidence score.
4. **`deepblame revert --agent <id>`** — undo one agent's changes, with conflicts shown before anything is applied.
5. Team dashboard, PR checks and signed audit reports.

## Development

```sh
pnpm install
pnpm check      # typecheck, tests and build
pnpm smoke      # packs the CLI and records a turn in a throwaway repository
```

The repository is a pnpm workspace: `packages/protocol` holds the event schema and the product name constants, `packages/core` the git plumbing, capture and sealer, and `packages/cli` the commands, bundled by esbuild into two dependency-free files — the CLI and the capture hot path.

## License

[Apache-2.0](LICENSE)
