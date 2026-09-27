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

/**
 * Files inside the state directory. Named here because the capture hot path
 * reads them without loading the rest of the protocol.
 */
export const QUEUE_FILE = 'queue.ndjson';
export const CONFIG_FILE = 'config.json';
export const IGNORE_FILE = '.gitignore';
export const SEAL_LOCK_FILE = 'seal.lock';
export const SEAL_INDEX_FILE = 'seal.index';
/**
 * A cache of what is in the ledger, so reading it does not mean parsing every
 * record. Append-only, safe to delete, rebuilt from the ledger when missing.
 */
export const RUN_INDEX_FILE = 'runs.index.ndjson';
export const RUN_INDEX_VERSION = 1;
/**
 * Where the capture path parks file contents until the sealer moves them into
 * git's object store. Without the content there is no way to prove a line is
 * still the line an agent wrote, and no way to put it back.
 */
export const BLOBS_DIR = 'blobs';
/**
 * A copy of the capture program, kept inside the repository so the hooks an
 * agent runs never depend on a name being on PATH. `npx deepblame init` puts
 * the CLI on PATH only for as long as that one command runs, so a hook written
 * to call it by name works while `init` checks it and is gone by the time an
 * agent fires it — silently, because capture never prints and always exits 0.
 */
export const BIN_DIR = 'bin';
export const CAPTURE_FILE = 'capture.cjs';
/** What version the copy came from, so a stale one can be spotted. */
export const CAPTURE_STAMP = 'capture.json';
