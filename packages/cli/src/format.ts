import { CLI_NAME, LEDGER_REF, PRODUCT_NAME, STATE_DIR } from '@deepblame/protocol';
import type { HarnessDetection, InitResult, StatusReport } from '@deepblame/core';

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
}

export function makeStyle(enabled: boolean): Style {
  const wrap = (open: number, close: number) => (text: string) =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return { bold: wrap(1, 22), dim: wrap(2, 22), green: wrap(32, 39) };
}

const NOT_RECORDING = 'capture hooks ship in the next release';

export function formatInit(result: InitResult, s: Style): string {
  const fresh = result.ledger.created || result.stateDir.created;
  const title = fresh ? `${PRODUCT_NAME} is set up in ${result.repo.root}` : `${PRODUCT_NAME} was already set up in ${result.repo.root}`;
  const ledgerNote = `${result.ledger.created ? 'created' : 'found'}, genesis ${short(result.ledger.head)}`;
  const stateNote = result.stateDir.created ? 'created; it ignores itself, your .gitignore is untouched' : 'present';
  return lines(
    s.bold(title),
    '',
    `  ${s.green('✓')} ledger   ${LEDGER_REF}  ${s.dim(ledgerNote)}`,
    `  ${s.green('✓')} state    ${STATE_DIR}/  ${s.dim(stateNote)}`,
    `  ${s.dim('·')} agents   ${agents(result.harnesses)}`,
    '',
    `Nothing is recorded yet: ${NOT_RECORDING}.`,
    `Run ${s.bold(`${CLI_NAME} status`)} to check on it any time.`,
  );
}

export function formatStatus(report: StatusReport, s: Style): string {
  const where = report.repo.branch ? `${report.repo.root} (${report.repo.branch})` : report.repo.root;
  if (!report.initialized) {
    const why =
      report.ledger.head === null
        ? 'This repository has no ledger yet.'
        : 'The ledger exists, but this worktree has no state directory yet.';
    return lines(`${PRODUCT_NAME} is not set up here: ${where}`, why, `Run ${s.bold(`${CLI_NAME} init`)} to start.`);
  }
  const { ledger, stateDir } = report;
  const created = ledger.createdAt ? `created ${ledger.createdAt.slice(0, 10)}, ` : '';
  return lines(
    `${s.bold(PRODUCT_NAME)}  ${s.dim(where)}`,
    '',
    `  ledger     ${LEDGER_REF}  ${s.dim(`${created}${plural(ledger.runs, 'run')} recorded`)}`,
    `  state      ${STATE_DIR}/  ${s.dim(`${plural(stateDir.queued, 'queued event')}`)}`,
    `  agents     ${agents(report.harnesses)}`,
    `  recording  ${report.recording ? s.green('on') : `off ${s.dim(`(${NOT_RECORDING})`)}`}`,
  );
}

function agents(list: readonly HarnessDetection[]): string {
  const found = list.filter((h) => h.found);
  if (found.length === 0) return 'none detected yet';
  return found.map((h) => `${h.label} (${h.signals.join(', ')})`).join(', ');
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function short(oid: string): string {
  return oid.slice(0, 7);
}

function lines(...rows: string[]): string {
  return `${rows.join('\n')}\n`;
}
