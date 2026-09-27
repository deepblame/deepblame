import { CLI_NAME, LEDGER_REF, PRODUCT_NAME, STATE_DIR } from '@deepblame/protocol';
import type {
  CostReport,
  HarnessDetection,
  HooksReport,
  InitResult,
  LedgerRun,
  LogReport,
  SealResult,
  StatusReport,
} from '@deepblame/core';

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

const NO_AGENT = 'no agent is reporting yet';
const INTENT_WIDTH = 42;

export function formatInit(result: InitResult, s: Style): string {
  const fresh = result.ledger.created || result.stateDir.created;
  const title = `${PRODUCT_NAME} ${fresh ? 'is set up in' : 'was already set up in'} ${result.repo.root}`;
  const ledgerNote = `${result.ledger.created ? 'created' : 'found'}, genesis ${short(result.ledger.head)}`;
  const stateNote = result.stateDir.created
    ? 'created; it ignores itself, your .gitignore is untouched'
    : 'present';
  const installed = result.hooks.filter((hook) => hook.installed);
  const captureRow =
    installed.length > 0
      ? `  ${s.green('✓')} capture  ${relativeTo(result.repo.root, installed.map((hook) => hook.file))}  ${s.dim('Claude Code reports every edit')}`
      : `  ${s.dim('·')} capture  ${s.dim(`none yet; run ${CLI_NAME} hooks install once your agent is set up`)}`;

  return lines(
    s.bold(title),
    '',
    `  ${s.green('✓')} ledger   ${LEDGER_REF}  ${s.dim(ledgerNote)}`,
    `  ${s.green('✓')} state    ${STATE_DIR}/  ${s.dim(stateNote)}`,
    captureRow,
    `  ${s.dim('·')} agents   ${agents(result.harnesses)}`,
    '',
    installed.length > 0
      ? `Recording is ${s.green('on')}. Run ${s.bold(`${CLI_NAME} log`)} after your next agent turn.`
      : `Nothing is recorded yet: ${NO_AGENT}.`,
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
  const files = report.hooks.filter((hook) => hook.installed).map((hook) => hook.file);
  return lines(
    `${s.bold(PRODUCT_NAME)}  ${s.dim(where)}`,
    '',
    `  ledger     ${LEDGER_REF}  ${s.dim(`${created}${plural(ledger.runs, 'run')} recorded`)}`,
    `  state      ${STATE_DIR}/  ${s.dim(plural(stateDir.queued, 'event') + ' waiting')}`,
    `  agents     ${agents(report.harnesses)}`,
    `  recording  ${
      report.recording ? `${s.green('on')}  ${s.dim(relativeTo(report.repo.root, files))}` : `off ${s.dim(`(${NO_AGENT})`)}`
    }`,
  );
}

export function formatLog(report: LogReport, s: Style): string {
  if (!report.initialized) {
    return lines(`${PRODUCT_NAME} is not set up here: ${report.repo.root}`, `Run ${s.bold(`${CLI_NAME} init`)} to start.`);
  }
  if (report.runs.length === 0) {
    return lines(
      'No agent runs recorded yet.',
      report.queued > 0
        ? `${plural(report.queued, 'event')} captured; they land in the ledger when the turn ends.`
        : `Let an agent work in this repository, then run ${s.bold(`${CLI_NAME} log`)} again.`,
    );
  }
  const now = Date.now();
  const rows = report.runs.map((entry) => ({
    id: shortRun(entry),
    when: since(entry.run.ended_at ?? entry.run.started_at, now),
    agent: entry.run.harness.name,
    intent: clip(entry.run.task.intent ?? '', INTENT_WIDTH),
    touched: `${plural(entry.run.files_written.length, 'file')}`,
    tools: `${entry.run.tool_calls.length} tools`,
    spend: money(entry.run.cost?.usd),
  }));
  const width = (key: 'when' | 'agent' | 'intent' | 'touched' | 'tools') =>
    Math.max(...rows.map((row) => row[key].length));
  const body = rows.map(
    (row) =>
      `  ${s.bold(row.id)}  ${s.dim(pad(row.when, width('when')))}  ${pad(row.agent, width('agent'))}  ${pad(
        row.intent,
        width('intent'),
      )}  ${s.dim(`${pad(row.touched, width('touched'))}  ${pad(row.tools, width('tools'))}`)}  ${pad(row.spend, 8)}`,
  );
  return lines(
    `${s.bold(PRODUCT_NAME)}  ${s.dim(report.repo.root)}`,
    '',
    ...body,
    '',
    s.dim(
      `${plural(report.runs.length, 'run')} shown${report.queued > 0 ? `, ${plural(report.queued, 'event')} still open` : ''}. ` +
        `${CLI_NAME} show <run> for the detail.`,
    ),
  );
}

export function formatShow(entry: LedgerRun, s: Style): string {
  const { run } = entry;
  const where = run.env.branch === null ? 'detached HEAD' : run.env.branch;
  const head = run.env.head_commit === null ? 'no commit' : short(run.env.head_commit);
  const tools = tally(run.tool_calls.map((call) => call.name));
  const rows = [
    `${s.bold(`run ${run.run_id}`)}`,
    '',
    `  agent    ${run.harness.name}${run.harness.version === null ? '' : ` ${run.harness.version}`}`,
    `  started  ${run.started_at}`,
    `  ended    ${run.ended_at ?? 'still open'}${run.ended_at === null ? '' : `  ${s.dim(duration(run.started_at, run.ended_at))}`}`,
    `  intent   ${run.task.intent ?? s.dim('not recorded')}`,
    `  where    ${where} @ ${head}`,
    `  tools    ${run.tool_calls.length === 0 ? s.dim('none') : `${run.tool_calls.length}  ${s.dim(tools)}`}`,
    `  model    ${run.model === null ? s.dim('not recorded') : `${run.model.name}  ${s.dim(run.model.provider)}`}`,
  ];
  if (run.cost !== undefined) {
    const { cost } = run;
    const cached = (cost.cache_write_tokens ?? 0) + (cost.cache_read_tokens ?? 0);
    const tokens = `${tokenCount(cost.input_tokens)} in, ${tokenCount(cost.output_tokens)} out${
      cached > 0 ? `, ${tokenCount(cached)} cached` : ''
    }`;
    const note = cost.usd === null ? s.dim('  (no rate for this model)') : cost.source === 'harness' ? s.dim('  (agent-reported)') : '';
    rows.push(`  spent    ${money(cost.usd)}  ${s.dim(tokens)}${note}`);
  }
  if (run.files_written.length > 0) {
    rows.push('', `  ${s.bold('wrote')}`);
    for (const file of run.files_written) {
      const change = `${file.pre_blob_sha === null ? 'new' : short(file.pre_blob_sha)} → ${
        file.post_blob_sha === null ? 'deleted' : short(file.post_blob_sha)
      }`;
      rows.push(`    ${file.path}  ${s.dim(`${plural(file.hunks.length, 'hunk')}, ${change}`)}`);
    }
  }
  if (run.files_read.length > 0) {
    rows.push('', `  ${s.bold('read')}`);
    for (const file of run.files_read) rows.push(`    ${file.path}`);
  }
  return lines(...rows);
}

export function formatSeal(result: SealResult, s: Style): string {
  if (result.busy) return lines(s.dim('Another seal is already running; nothing to do.'));
  if (result.sealed === 0) {
    return lines(
      result.pending > 0
        ? `Nothing to seal yet: ${plural(result.pending, 'event')} belong to a turn that has not ended.`
        : 'Nothing to seal: no events are waiting.',
    );
  }
  const rejected = result.rejected.length > 0 ? ` ${plural(result.rejected.length, 'turn')} rejected.` : '';
  return lines(
    `Sealed ${plural(result.sealed, 'run')} into ${LEDGER_REF} ${s.dim(`(${short(result.head)})`)}.${rejected}`,
  );
}

export function formatCost(report: CostReport, s: Style): string {
  if (!report.initialized) {
    return lines(`${PRODUCT_NAME} is not set up here: ${report.repo.root}`, `Run ${s.bold(`${CLI_NAME} init`)} to start.`);
  }
  if (report.runs === 0) {
    return lines('No runs in this period, so nothing was spent.');
  }
  const { totals } = report;
  const period = report.days === null ? 'all time' : `last ${plural(report.days, 'day')}`;
  const cached = totals.cache_write_tokens + totals.cache_read_tokens;
  const rows = [
    `${s.bold(`${PRODUCT_NAME} spend`)}  ${s.dim(report.repo.root)}`,
    '',
    `  period     ${period}  ${s.dim(`${plural(report.runs, 'run')}${report.unmeasured > 0 ? `, ${report.unmeasured} without usage` : ''}`)}`,
    `  tokens     ${tokenCount(totals.input_tokens)} in · ${tokenCount(totals.output_tokens)} out${
      cached > 0 ? ` · ${tokenCount(cached)} cached` : ''
    }`,
    `  total      ${s.bold(money(totals.usd))}`,
  ];
  if (report.byModel.length > 0) {
    rows.push('', `  ${s.bold('by model')}`);
    const width = Math.max(...report.byModel.map((bucket) => bucket.key.length));
    for (const bucket of report.byModel) {
      rows.push(
        `    ${pad(bucket.key, width)}  ${s.dim(pad(plural(bucket.runs, 'run'), 8))}  ${pad(money(bucket.usd), 9)}${
          bucket.unpriced > 0 ? s.dim(`  ${bucket.unpriced} unpriced`) : ''
        }`,
      );
    }
  }
  if (report.byAgent.length > 1) {
    rows.push('', `  ${s.bold('by agent')}`);
    const width = Math.max(...report.byAgent.map((bucket) => bucket.key.length));
    for (const bucket of report.byAgent) {
      rows.push(`    ${pad(bucket.key, width)}  ${s.dim(pad(plural(bucket.runs, 'run'), 8))}  ${pad(money(bucket.usd), 9)}`);
    }
  }
  if (totals.unpriced > 0) {
    rows.push(
      '',
      s.dim(
        `${plural(totals.unpriced, 'run')} could not be priced: no rate is known for that model. Add one under "pricing" in ${STATE_DIR}/config.json.`,
      ),
    );
  }
  return lines(...rows);
}

export function formatHooks(report: HooksReport, s: Style): string {
  const installed = report.files.filter((file) => file.installed);
  if (report.action === 'install') {
    const change = report.changes[0];
    const file = change === undefined ? '' : relativeTo(report.repo.root, [change.file]);
    return lines(
      change?.changed === true
        ? `${s.green('✓')} Capture hooks installed in ${s.bold(file)}.`
        : `Capture hooks were already in ${s.bold(file)}.`,
      s.dim(`  ${change?.command ?? ''}`),
      '',
      `Claude Code now reports every prompt, tool call and edit to ${PRODUCT_NAME}.`,
    );
  }
  if (report.action === 'uninstall') {
    const changed = report.changes.filter((change) => change.changed);
    return lines(
      changed.length > 0
        ? `Capture hooks removed from ${relativeTo(report.repo.root, changed.map((change) => change.file))}.`
        : 'No capture hooks were installed.',
      s.dim('Everything already in the ledger stays there.'),
    );
  }
  return lines(
    `  capture  ${installed.length > 0 ? s.green('on') : 'off'}  ${s.dim(
      installed.length > 0 ? relativeTo(report.repo.root, installed.map((file) => file.file)) : `run ${CLI_NAME} hooks install`,
    )}`,
    `  agents   ${agents(report.harnesses)}`,
  );
}

function agents(list: readonly HarnessDetection[]): string {
  const found = list.filter((harness) => harness.found);
  if (found.length === 0) return 'none detected yet';
  return found.map((harness) => `${harness.label} (${harness.signals.join(', ')})`).join(', ');
}

function tally(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ');
}

function since(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.round(hours / 24), 'day')} ago`;
}

function duration(from: string, to: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Shortened like git does, from the run's own id rather than the blob's. */
function shortRun(entry: LedgerRun): string {
  return entry.run.run_id.replace(/-/g, '').slice(0, 7);
}

/** Shows paths the way the project talks about them, with forward slashes on every OS. */
function relativeTo(root: string, files: readonly string[]): string {
  const base = slashes(root).replace(/\/+$/, '');
  return files
    .map((file) => {
      const path = slashes(file);
      return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
    })
    .join(', ');
}

function slashes(path: string): string {
  return path.split('\\').join('/');
}

/** A dash rather than a zero when the model's rate is unknown. */
function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—';
  if (usd === 0) return '$0';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function tokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function clip(text: string, width: number): string {
  if (text === '') return '';
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function short(oid: string | null): string {
  return oid === null ? 'none' : oid.slice(0, 7);
}

function lines(...rows: string[]): string {
  return `${rows.join('\n')}\n`;
}
