import { capture } from './capture';

/**
 * A second, deliberately tiny entry point. Agents call this on every tool
 * call, and a process that loads the whole CLI pays for parsing code it will
 * never run; this bundle holds the capture path and nothing else.
 */

// Node 22 and newer can cache this file's compiled bytecode between runs.
// Nothing here depends on it, and older runtimes simply do not have it.
try {
  const module = require('node:module') as { enableCompileCache?: () => void };
  module.enableCompileCache?.();
} catch {
  // A cold start every time is slower, not broken.
}

process.exitCode = capture(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  entry: process.argv[1],
});
