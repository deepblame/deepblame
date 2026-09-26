export {};

const env = process.env;
const argv = process.argv.slice(2);

/**
 * `capture` is loaded on its own: it runs inside every agent tool call, so it
 * must not pay for the schema library the rest of the CLI uses.
 */
if (argv[0] === 'capture') {
  const { capture } = await import('./capture');
  process.exitCode = capture(argv.slice(1), { cwd: process.cwd(), env, entry: process.argv[1] });
} else {
  const { main } = await import('./main');
  const color =
    env.FORCE_COLOR !== undefined
      ? env.FORCE_COLOR !== '0'
      : Boolean(process.stdout.isTTY) && env.NO_COLOR === undefined && env.TERM !== 'dumb';
  process.exitCode = main(argv, {
    cwd: process.cwd(),
    env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    color,
    entry: process.argv[1],
  });
}
