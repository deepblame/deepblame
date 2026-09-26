import { capture } from './capture';

/**
 * A second, deliberately tiny entry point. Agents call this on every tool
 * call, and a process that loads the whole CLI pays for parsing code it will
 * never run; this bundle holds the capture path and nothing else.
 */
process.exitCode = capture(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  entry: process.argv[1],
});
