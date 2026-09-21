# DeepBlame

See what your AI agents did to your codebase, understand why, and undo just that.

`git blame` tells you who committed a line. DeepBlame records which agent wrote each line, with which model and instructions, and lets you revert one agent's work without losing everyone else's.

**Status: pre-alpha.** `init` and `status` work today. Capture hooks, `blame --why` and surgical revert are next.

```sh
npx deepblame init      # set up the ledger in this repository
npx deepblame status    # show what is set up and what is recorded
```

`init` writes the ledger to a separate git ref (`refs/deepblame/ledger`) and keeps local state in `.deepblame/`, a folder that ignores itself. Your branches, working tree, index and `.gitignore` are never touched, no git identity or signing key is needed, and no code leaves your machine.

Requires Node 20+ and git. Licensed under Apache-2.0.
