# Changelog

What changed, in the words of someone deciding whether to upgrade. The release
notes on GitHub are taken from this file, so this is the one place it is
written down.

## 0.4.4

- `doctor` now calls out a hook that points at a relative path. Nothing decides
  what directory an agent fires its hooks from, so such a hook records whenever
  the agent starts at the top of the repository and silently records nothing
  when it does not — and checking it from the repository root, which is where
  anyone runs `doctor`, finds the file and calls it healthy. Found in our own
  repository, where a hook written on the first day had recorded nothing in
  eight days while `doctor` reported everything fine.

## 0.4.3

- Every release now appears on GitHub with notes and, attached to it, the VS
  Code extension as a `.vsix` you can install, plus the npm tarball. Notes come
  from this file.

## 0.4.2

- The package page said "the system of record for AI-written code", which is a
  sentence about a category rather than about your repository. It now says what
  the tool does for the person reading it.
- `homepage` points at deepblame.com, and the keywords include the words people
  actually search for: attribution, agent-trace, revert.

## 0.4.1

- Filled in the copyright holder, which the Apache template had left as
  `{name of copyright owner}` since the first commit.
- Added `NOTICE`, and made it travel with the npm package and the extension.
  Under Apache-2.0 it is the one thing anyone redistributing this has to carry.
  It also states that Claude Code, Cursor, Codex, OpenCode and Agent Trace
  belong to their owners and are named only to describe what this records.

## 0.4.0

**Speaks [Agent Trace](https://agent-trace.dev)**, the interchange format Cursor
published with Anthropic, Cognition, Cloudflare, Vercel and Google behind it.

- `deepblame trace export` writes the ledger as Agent Trace records, one per
  run, each range carrying a hash of the text it covers.
- `deepblame trace import` takes in attribution another tool recorded. It is
  kept apart from what we watched: marked `reported`, blamed at 80% with the
  reporting tool named, and never reverted, because a trace carries no
  before-image.
- A claim is only taken in when git can still show the state it was made
  against — the revision it names, or a content hash matching your file today.
  The second path carries a trace across clones with no shared history.
  Anything else is counted, reported and left out rather than guessed at.

## 0.3.1

**Recording was silently broken for anyone who installed with `npx`.** This is
the release to be on.

- `npx deepblame init` put the CLI on PATH only for the length of that one
  command, so the hook it wrote named something that was gone by the time an
  agent fired it. Capture never prints and always exits 0, so nothing was
  recorded and nothing said so. The hooks now call a copy of the capture
  program kept inside the repository, by full path.
- Sealing in the background had never worked: capture asked itself to seal, and
  capture is not the sealer. Turns waited in the queue until some later command
  sealed them. The CLI is now copied in beside the capture program and started
  as the sealer.
- `deepblame doctor` checks that the installed hook command still resolves, so
  this whole family of failures is loud instead of silent, and exits 1 for CI.
- Windows: the command parser split on spaces, so it called every healthy hook
  on Windows broken, node living in `C:\Program Files` being the reason.

## 0.3.0

- `deepblame push` and `deepblame pull` share the ledger with your team. Joining
  two ledgers cannot conflict by construction, and the stored file contents
  travel too, so blame and revert work on a colleague's agent from your machine.
- `deepblame report --base <ref>` says how much of a change an agent wrote,
  counting only the lines that change touches. `--markdown` for a comment, and
  `examples/pull-request-comment.yml` is a drop-in Action.
- A VS Code extension in `packages/vscode`: the agent and the prompt beside the
  line, and undo from the hover after it shows you the plan.
- A subagent finishing is no longer treated as the turn finishing. Every turn
  that ran a Task was being recorded as two runs, and blame split one piece of
  work between them.

## 0.2.0

- Cursor adapter, built from its published hook API.
- `deepblame doctor` accounts for the tool's own silence.
- `deepblame gc` ages old file contents out of the ledger.

## 0.1.0

First release. Recording for Claude Code, OpenCode and Codex, a git fallback
that covers everything else, `blame`, `cost` and surgical `revert`.
