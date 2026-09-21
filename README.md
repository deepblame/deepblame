<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo-dark.png">
    <img src="brand/logo-light.png" alt="DeepBlame" width="380">
  </picture>
</p>

<p align="center"><b>See what your AI agents did to your codebase, understand why, and undo just that.</b></p>

---

`git blame` tells you who committed a line. When three agents and two people work in the same repository, that is not enough. DeepBlame records which agent wrote each line, with which model and instructions, after reading which files, and lets you revert one agent's work without throwing away everyone else's.

> **Status: pre-alpha.** The foundation works today: `init` sets up the ledger and `status` reports on it. Capture hooks, `blame --why` and surgical revert are being built in the open. See the [roadmap](#roadmap).

## Quick start

Run it inside any git repository. Node 20 or newer, no install needed:

```sh
npx deepblame init
npx deepblame status
```

```
DeepBlame  ~/code/app (main)

  ledger     refs/deepblame/ledger  created 2026-09-21, 0 runs recorded
  state      .deepblame/  0 queued events
  agents     Claude Code (.claude/), OpenCode (opencode on PATH)
  recording  off (capture hooks ship in the next release)
```

## What `init` does, and what it never does

- Creates the ledger as a separate git ref, `refs/deepblame/ledger`. It is never checked out, so your branches, working tree and index stay exactly as they were.
- Creates `.deepblame/` for local state. The folder ignores itself, so your `.gitignore` is not touched and the folder can never be committed by accident.
- Detects the agent tools in the project: OpenCode, Claude Code, Codex and Cursor.
- Never needs your git identity and never signs with your key, so a signing prompt can never block an agent.
- Never sends code anywhere. Everything above is local.

Running `init` again is safe: it finds the existing ledger and repairs anything missing.

## Commands

| Command | What it does |
| --- | --- |
| `deepblame init` | Set up the ledger and local state in this repository |
| `deepblame status` | Show what is set up and what is being recorded |

Options: `-C <dir>` runs as if started in another directory, `--json` prints machine-readable output.

## Roadmap

1. **Foundation** — ledger, local state, agent detection. *Done.*
2. **Capture** — hooks for OpenCode, Claude Code, Codex and Cursor, plus a git fallback that works with any tool.
3. **`deepblame blame --why`** — line-by-line provenance that survives edits, merges and reformatting, with a confidence score.
4. **`deepblame revert --agent <id>`** — undo one agent's changes, with conflicts shown before anything is applied.
5. Team dashboard, PR checks and signed audit reports.

## Development

```sh
pnpm install
pnpm check      # typecheck, tests and build
node packages/cli/dist/deepblame.mjs status
```

The repository is a pnpm workspace: `packages/protocol` holds the event schema and the product name constants, `packages/core` the git plumbing, and `packages/cli` the command, bundled by esbuild into a single dependency-free file.

## License

[Apache-2.0](LICENSE)
