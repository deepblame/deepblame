/**
 * The product name lives here and nowhere else. Every path, git ref and
 * user-facing label derives from these constants, so a rename before launch
 * is a one-line change.
 */
export const PRODUCT_NAME = 'DeepBlame';
export const CLI_NAME = 'deepblame';

/** Separate git ref holding the append-only ledger. Never checked out. */
export const LEDGER_REF = `refs/${CLI_NAME}/ledger`;

/** Per-worktree state directory. Ignores itself; fully rebuildable from the ledger. */
export const STATE_DIR = `.${CLI_NAME}`;

/**
 * Identity used for machine-written ledger commits, so recording never
 * depends on the user's git config and never borrows their signing key.
 */
export const LEDGER_IDENTITY = {
  name: PRODUCT_NAME,
  email: `ledger@${CLI_NAME}.dev`,
} as const;
