<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo-dark.png">
    <img src="brand/logo-light.png" alt="DeepBlame" width="380">
  </picture>
</p>

<p align="center"><b>See what your AI agents did to your codebase, understand why, and undo just that.</b></p>

---

`git blame` tells you who committed a line. When three agents and two people work in the same repository, that is no longer the question. The question is which agent wrote this line, what it was asked to do, what it read before it did, what it cost — and how to take that one agent's work back out without losing everyone else's.

DeepBlame records every agent turn into a ledger that lives beside your code, and answers those questions from it.

- **Which agent wrote this line** — `deepblame blame`, with a confidence you can check, that holds up when the file changes around it.
- **Why it wrote it** — the prompt behind the turn, the files it read first, the tools it ran, the model that answered.
- **What it cost** — tokens and money, per turn, per model, per agent.
- **Undo just that** — surgical revert of one agent's work, without touching the rest.

**It works with the tools you already use.** Claude Code, Cursor and OpenCode are recorded tool call by tool call; Codex turn by turn through its own notifier; everything else — Copilot, Windsurf, a cloud agent that opens a pull request — at commit level, and anything at all can report to us with [one JSON line](#wiring-up-a-tool-we-have-not-heard-of). One ledger for all of them, because a team runs more than one agent and no vendor's own history covers the others.

**Nothing leaves your machine.** The ledger is a separate git ref: your branches, working tree and index are never touched, no code is sent anywhere, and prompts are stored as hashes unless you ask otherwise.

> **Status: pre-alpha, and already useful.** Everything above works today. See the [roadmap](#roadmap) for what is next.

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

And the question the tool exists for — who wrote this line:

```sh
npx deepblame blame src/upload.ts
```

```
src/upload.ts  10 lines, 50% traced, 50% written by agents

  1-4          you, or a tool nobody recorded
  5-9          claude-code  feb92f2  add a retry when the upload fails  90%  changed elsewhere since, this line came through
  10           you, or a tool nobody recorded
```

The percentage is not decoration. A line is claimed only when the state the run left is still in the ledger and the line can be followed from there to the file as it stands now; anything else is reported as unknown rather than guessed. `--why 7` prints the whole run behind one line.

It holds up in the situations that usually break this kind of tool:

| What happened to the file | What blame does |
| --- | --- |
| Nothing since the run | 100%, exact |
| Edited elsewhere | 90%, the line came through |
| Renamed — `git mv`, staged or committed | followed, and it says what the file used to be called |
| A formatter reindented everything | 70%, "only the spacing has changed since" |
| Somebody rewrote the line | not claimed at all |
| Merged from another branch | the agent keeps the line; a merge commit writes nothing, so it records nothing |
| The ledger lost the content | reported as unverifiable, never guessed |

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

Rates for models we do not know yet are left blank rather than guessed; add your own under `pricing` in `.deepblame/config.json` and the numbers appear. When the agent reports its own price — OpenCode does — that figure is used instead of ours.

## Undoing one agent's work

The reason the ledger keeps file contents. Reverting an agent is not checking the file out as it was: that would throw away everything written since. DeepBlame knows exactly which lines the run changed, so it takes those back out and leaves the rest standing.

```sh
npx deepblame revert --agent claude-code
```

```
Undoing 1 run by claude-code  ~/code/app

  ✓ src/upload.ts  3 lines        comes out cleanly
  · src/index.ts   12 lines       changed again after the agent, so both cannot hold

Nothing has been written yet.
Add --apply to undo 1 file.
1 file cannot be undone cleanly. --apply --conflicts writes them with the usual <<<<<<< markers.
```

Nothing is written without `--apply`. A file the agent created but you have edited since is never deleted for you. A file whose recorded content the ledger no longer holds is reported, not guessed at. And `--run <id>` undoes one turn instead of everything an agent did.

A worked example, which is the whole point:

```
before     an agent adds a retry loop to upload.js
then       you rename the export in the same file
revert     the retry loop is gone, your rename is still there
```

A plain three-way merge cannot do that — two changes on adjacent lines conflict. DeepBlame has something git does not: a record of which lines belong to the agent.

## One ledger for the team

Until you share it, the record of who wrote what lives on the machine that watched it happen, which answers the question for you and nobody else. The ledger is a git ref, so sharing it is the thing git is already good at:

```sh
npx deepblame push        # send your runs to the team
npx deepblame pull        # take in everyone else's
```

```
Sent the ledger to origin.
  12 runs, 3 came in from the team first.
```

Joining two ledgers cannot conflict, and that is by design rather than by luck: a run record's path is its own uuid and the record never changes once written, and a stored file's content is keyed by its own hash. Two machines therefore never write different things to the same path. If one ever does, DeepBlame keeps what is local and tells you, rather than quietly picking a side.

The file contents travel too, which is what makes this more than a report: after a `pull`, `blame` and `revert` both work on your colleague's runs from your own machine.

## Who wrote this pull request

```sh
npx deepblame report --base origin/main
```

```
50% of this change was written by agents  14 of 28 lines

  claude-code   11 lines   2 runs
  cursor         3 lines   1 run

  src/upload.ts   9 of 14 lines
  src/index.ts    5 of 14 lines
```

Only the lines the change actually touches are counted; blaming whole files would report work that was reviewed weeks ago. `--markdown` gives the version for a comment, and `examples/pull-request-comment.yml` is a drop-in GitHub Action that posts it on every pull request and replaces its own previous comment rather than piling up.

## In your editor

`packages/vscode` is a VS Code extension over the same ledger: a mark down the left edge of every line an agent wrote, the agent and the prompt at the end of the line your cursor is on, and on hover the model, the cost, how sure the answer is and a link that undoes that run after showing you the plan. Build it with `pnpm --filter deepblame-vscode build`; see its own README for installing the `.vsix`.

## What `init` does, and what it never does

- Creates the ledger as a separate git ref, `refs/deepblame/ledger`. It is never checked out, so your branches, working tree and index stay exactly as they were.
- Creates `.deepblame/` for local state. The folder ignores itself, so your `.gitignore` is not touched and the folder can never be committed by accident.
- Detects the agent tools in the project (OpenCode, Claude Code, Codex, Cursor) and, for Claude Code, adds capture hooks to `.claude/settings.json`. Use `--no-hooks` to skip that, `--local` to keep the hooks out of git, and `deepblame hooks uninstall` to take them back out.
- Never needs your git identity and never signs with your key, so a signing prompt can never block an agent.
- Never sends code anywhere. Everything above is local.

Running `init` again is safe: it finds the existing ledger and repairs anything missing.

## Which tools are covered

| Tool | How | What you get |
| --- | --- | --- |
| **Claude Code** | its own hooks, installed by `init` | every prompt, tool call and edit, with model and cost |
| **Cursor** | its own hooks, installed by `init` | every prompt, read and edit, with the exact strings it replaced |
| **OpenCode** | a plugin, installed by `init` | every prompt, tool call and edit, with the tokens and price OpenCode itself reports |
| **Codex** | `hooks install --agent codex`, then one line in your Codex config | one run per turn, with the files it changed |
| **Anything else** — Copilot, Windsurf, a cloud agent | `hooks install --agent git` | one run per commit, with the lines it changed |

The fallbacks are coarser on purpose, and they say so: a commit knows the person who made it, never the tool that typed it. When a hooked agent and a commit both touch a line, the agent we actually watched keeps the credit.

### Wiring up a tool we have not heard of

There will always be one. So there is a documented way in, and it is one JSON object per call on stdin — no SDK, no dependency, nothing to keep in step with our releases:

```sh
echo '{"kind":"prompt","agent":"opencode","session":"s1","cwd":"'$PWD'","text":"add the retry"}' | deepblame-capture
echo '{"kind":"write-pre","agent":"opencode","session":"s1","path":"src/upload.ts"}'            | deepblame-capture
# ... your agent edits the file ...
echo '{"kind":"write","agent":"opencode","session":"s1","path":"src/upload.ts","tool":"edit","old":"…","new":"…"}' | deepblame-capture
echo '{"kind":"usage","agent":"opencode","session":"s1","model":"gpt-5","input":900,"output":120,"usd":0.02}'      | deepblame-capture
echo '{"kind":"end","agent":"opencode","session":"s1"}'                                        | deepblame-capture
```

`kind` is one of `session`, `prompt`, `read`, `write-pre`, `write`, `tool`, `usage`, `end`. `write-pre` before the edit and `write` after it are what make line-level blame and surgical revert possible; everything else is optional. Anything unrecognised is ignored rather than rejected. Our own OpenCode plugin is forty lines on top of this, and it is written into your project where you can read it.

## When it is not recording

The first question anybody asks, and usually the answer is dull: the agent has not run since the hooks went in, or the agent you use is not the one that got hooked up. So the tool accounts for its own silence.

```sh
npx deepblame doctor
```

```
DeepBlame check  ~/code/app

  ✓ repository   main @ bc05abd
  ✓ ledger       38 runs, last one 4 minutes ago
  ✓ state        .deepblame/ present
  ✓ recording    Claude Code
  ! agents       Cursor is used here but not hooked up
                 → deepblame hooks install --agent cursor
  ! queue        6 events waiting, untouched for 8 hours
                 → the turn never ended; deepblame seal folds them in anyway

2 things to look at, listed above.
```

Every check ends in something to do. It exits non-zero only when something is actually broken, so it is safe in CI.

## Keeping the ledger from growing

The ledger stores the contents of every file an agent touched, because that is the only way to prove a line is still the line an agent wrote, and the only way to put it back. It is also the only part that grows without limit.

```sh
npx deepblame gc --days 90
```

Contents older than the cutoff are released; every run record is kept. After it, `blame` still names the agent on those older lines but reports them as unverifiable rather than guessing, and `revert` no longer reaches that far back.

One thing it has to say out loud: releasing a blob for real means the ledger's commit chain is replaced by a single commit, because an append-only history keeps every old tree — and every blob in it — reachable forever. The run records all survive. The seal-by-seal history of the ledger itself does not. Nothing is written without `--apply`.

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
| `deepblame blame <file>` | Which agent wrote each line, with a confidence you can check |
| `deepblame cost` | What the agents spent, by model and by agent |
| `deepblame revert` | Undo one agent's work and nobody else's |
| `deepblame report` | How much of a branch or pull request an agent wrote |
| `deepblame push` | Send this machine's runs to the team's remote |
| `deepblame pull` | Take in the team's runs and fold them into yours |
| `deepblame doctor` | Check that recording is actually working, and say what to fix |
| `deepblame gc` | Age old file contents out of the ledger |
| `deepblame seal` | Fold captured events into the ledger now |
| `deepblame hooks <action>` | `install`, `uninstall` or `status` for capture hooks |

Options: `-C <dir>` runs as if started in another directory, `--limit <n>` bounds `log`, `--days <n>` bounds `cost`, `--why <line>` explains one line in `blame`, `--run <id>` / `--agent <name>` / `--hours <n>` choose what `revert` undoes, `--apply` makes `revert` write, `--base <ref>` / `--head <ref>` set what `report` compares and `--markdown` formats it for a comment, `--remote <name>` picks where `push` and `pull` go, `--json` prints machine-readable output, `--no-seal` lists only what is already in the ledger.

## Roadmap

1. **Foundation** — ledger, local state, agent detection. *Done.*
2. **Capture** — full adapters for Claude Code, Cursor and OpenCode, a turn-level one for Codex, a git fallback that covers everything else, and a documented JSON format any other tool can use. Model and cost accounting, from the agent's own figures where it has them. *Done.*
3. **`deepblame blame`** — line-by-line provenance with a confidence score you can check. *Done.* It survives edits elsewhere in the file, follows a file through renames, keeps the line when a formatter reindents the whole file (at a lower confidence, and it says so), and keeps the right owner when several agents and a person touch one file.
4. **`deepblame revert`** — undo one agent's work and nobody else's, three-way against the lines the ledger says were theirs, with conflicts shown before anything is written. *Done.*
5. **Housekeeping** — `doctor` accounts for the tool's own silence, `gc` keeps the ledger from growing forever. *Done.*
6. **A team ledger** — `push` and `pull` join two ledgers without a possible conflict, file contents included, so blame and revert work on a colleague's runs. `report` says how much of a branch an agent wrote, and a drop-in Action comments it on every pull request. *Done.*
7. **In the editor** — a VS Code extension over the same ledger, in `packages/vscode`. *Done, though how it looks has only been judged by the people who have installed it.*
8. **Next**: real users. The biggest gap is no longer a feature — it is that nobody outside this repository has run it yet. After that, signed audit reports and a hosted panel for teams that want the record off their laptops.

## Development

```sh
pnpm install
pnpm check      # typecheck, tests and build
pnpm smoke      # packs the CLI and records a turn in a throwaway repository
```

The repository is a pnpm workspace: `packages/protocol` holds the event schema and the product name constants, `packages/core` the git plumbing, capture, sealer, blame, revert, sharing and reporting, `packages/cli` the commands, bundled by esbuild into two dependency-free files — the CLI, and the capture hot path as CommonJS because node's ESM loader costs about 20ms of somebody else's turn — and `packages/vscode` the editor extension, which bundles core rather than shelling out to the CLI.

The extension cannot be started from a terminal, so it is tested the other way round: `packages/vscode/test/fake-editor.ts` stands in for the editor and records what it was told to draw, and the tests drive the real extension against a real repository and a real ledger. That covers the wiring; it does not cover appearance.

Reading the ledger goes through a cache in `.deepblame/`, so `blame` on one file does not parse a thousand run records. It is only a cache: delete it and the next command rebuilds it from the ledger, which stays the only source of truth.

## License

[Apache-2.0](LICENSE)
