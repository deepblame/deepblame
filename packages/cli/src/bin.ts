import { main } from './main';

const env = process.env;
const color =
  env.FORCE_COLOR !== undefined
    ? env.FORCE_COLOR !== '0'
    : Boolean(process.stdout.isTTY) && env.NO_COLOR === undefined && env.TERM !== 'dumb';

process.exitCode = main(process.argv.slice(2), {
  cwd: process.cwd(),
  env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  color,
});
