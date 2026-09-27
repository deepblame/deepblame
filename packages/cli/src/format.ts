import { CLI_NAME, LEDGER_REF, PRODUCT_NAME, STATE_DIR } from '@deepblame/protocol';
import { OPENCODE_PLUGIN } from '@deepblame/core';
import type {
  BlameReport,
  BlameSpan,
  CostReport,
  HarnessDetection,
  HooksReport,
  InitResult,
  LedgerRun,
  Check,
  DoctorReport,
  GcReport,
  LogReport,
  PrReport,
  RevertReport,
  ShareReport,
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
    tools: plural(entry.run.tool_calls.length, 'tool'),
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

export function formatBlame(report: BlameReport, s: Style): string {
  if (!report.initialized) {
    return lines(`${PRODUCT_NAME} is not set up here: ${report.repo.root}`, `Run ${s.bold(`${CLI_NAME} init`)} to start.`);
  }
  const result = report.result;
  if (result === null) return lines('Nothing to blame.');
  if (result.runs === 0) {
    return lines(
      `${s.bold(report.path)}  ${s.dim(`${plural(result.lines, 'line')}`)}`,
      '',
      'No recorded agent has written in this file.',
      s.dim('Either it is all yours, or it was written before recording was on.'),
    );
  }

  const traced = `${Math.round(result.tracedShare * 100)}% traced`;
  const byAgents = result.agentShare > 0 ? `, ${Math.round(result.agentShare * 100)}% written by agents` : '';
  const rows = [`${s.bold(report.path)}  ${s.dim(`${plural(result.lines, 'line')}, ${traced}${byAgents}`)}`, ''];
  for (const span of result.spans) {
    const range = span.from === span.to ? `${span.from}` : `${span.from}-${span.to}`;
    if (span.run === null) {
      rows.push(`  ${s.dim(pad(range, 11))}  ${s.dim('you, or a tool nobody recorded')}`);
      continue;
    }
    const intent = span.run.task.intent ?? '(no prompt recorded)';
    rows.push(
      `  ${pad(range, 11)}  ${who(span.run)}  ${s.bold(shortId(span.run.run_id))}  ${clip(intent, INTENT_WIDTH)}  ${s.dim(
        confidence(span.confidence, span.reason),
      )}`,
    );
  }
  if (result.renamedFrom.length > 0) {
    rows.push('', s.dim(`Followed through a rename: this file used to be ${result.renamedFrom.join(', then ')}.`));
  }
  if (result.unverifiable > 0) {
    rows.push(
      '',
      s.dim(
        `${plural(result.unverifiable, 'run')} wrote this file but the ledger no longer holds what they left, so their lines are not claimed.`,
      ),
    );
  }
  rows.push('', s.dim(`${CLI_NAME} blame ${report.path} --why <line>  to see the whole run behind one line.`));
  return lines(...rows);
}

export function formatBlameLine(report: BlameReport, line: number, s: Style): string {
  const span = report.line;
  if (span === null || span.run === null) {
    return lines(
      `${s.bold(`line ${line} of ${report.path}`)}`,
      '',
      '  No recorded agent wrote this line.',
      s.dim('  It is yours, it predates recording, or a later edit replaced what an agent left.'),
    );
  }
  const { run } = span;
  const rows = [
    `${s.bold(`line ${line} of ${report.path}`)}`,
    '',
    `  written by  ${who(run)}${run.model === null ? '' : `  ${s.dim(run.model.name)}`}`,
    `  run         ${shortId(run.run_id)}  ${s.dim(run.started_at)}`,
    `  intent      ${run.task.intent ?? s.dim('not recorded')}`,
    `  confidence  ${confidence(span.confidence, span.reason)}`,
  ];
  if (run.cost !== undefined) rows.push(`  the turn     ${money(run.cost.usd)}, ${run.tool_calls.length} tool calls`);
  rows.push('', s.dim(`${CLI_NAME} show ${shortId(run.run_id)}  for everything that run did.`));
  return lines(...rows);
}

/** A commit knows the person who made it; an agent run knows the tool. */
function who(run: NonNullable<BlameSpan['run']>): string {
  return run.harness.name === 'git' && run.actor.type === 'human' ? `git (${run.actor.id})` : run.harness.name;
}

/** Says the number and what it means: a score with no explanation is noise. */
function confidence(value: number, reason: string): string {
  const percent = `${Math.round(value * 100)}%`;
  if (reason === 'exact') return `${percent}  the file is exactly as the run left it`;
  if (reason === 'survived') return `${percent}  changed elsewhere since, this line came through`;
  if (reason === 'reformatted') return `${percent}  only the spacing has changed since, so probably still theirs`;
  return percent;
}

function shortId(runId: string): string {
  return runId.replace(/-/g, '').slice(0, 7);
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

const REVERT_NOTE: Record<string, string> = {
  clean: 'comes out cleanly',
  conflicted: 'changed again after the agent, so both cannot hold',
  unchanged: 'nothing of that run is left in this file',
  unverifiable: 'the ledger no longer holds what this needs',
  binary: 'not text, and changed since, so there is nothing to merge',
};

export function formatRevert(report: RevertReport, s: Style): string {
  if (!report.initialized) {
    return lines(`${PRODUCT_NAME} is not set up here: ${report.repo.root}`, `Run ${s.bold(`${CLI_NAME} init`)} to start.`);
  }
  const plan = report.plan;
  if (plan === null) return lines('Nothing to undo.');
  if (plan.runs.length === 0) return lines(...noRuns(report, s));

  const doing = plan.files.filter((file) => file.status === 'clean');
  const stuck = plan.files.filter((file) => file.status === 'conflicted');
  const inert = plan.files.filter((file) => file.status !== 'clean' && file.status !== 'conflicted');
  const rows: string[] = [];

  const verb = !plan.applied ? 'Undoing' : plan.written.length > 0 ? 'Undid' : 'Nothing undone from';
  const heading = `${verb} ${plural(plan.runs.length, 'run')} by ${selectionOf(report)}`;
  rows.push(`${s.bold(heading)}  ${s.dim(report.repo.root)}`, '');

  if (plan.files.length === 0) {
    rows.push('  Those runs wrote nothing that is still here to undo.');
    return lines(...rows);
  }

  const shown = plan.files.map((file) => ({
    done: plan.applied ? plan.written.includes(file.path) : file.status === 'clean',
    path: file.recordedAs === null ? file.path : `${file.path} (was ${file.recordedAs})`,
    what:
      file.write?.kind === 'delete'
        ? 'the whole file'
        : file.changed > 0
          ? plural(file.changed, 'line')
          : '',
    note:
      file.write?.kind !== 'delete'
        ? (REVERT_NOTE[file.status] ?? file.status)
        : file.status === 'conflicted'
          ? 'the agent created it, but you have changed it since'
          : 'the agent created it, so it goes',
  }));
  const pathWidth = Math.max(...shown.map((row) => row.path.length));
  const whatWidth = Math.max(...shown.map((row) => row.what.length));
  for (const row of shown) {
    rows.push(
      `  ${row.done ? s.green('✓') : s.dim('·')} ${pad(row.path, pathWidth)}  ${pad(row.what, whatWidth)}  ${s.dim(row.note)}`,
    );
  }
  rows.push('');

  if (plan.applied) {
    rows.push(
      plan.written.length > 0
        ? `${plural(plan.written.length, 'file')} rewritten. ${s.dim('Your other changes are untouched; check with git diff.')}`
        : 'Nothing was written.',
    );
    if (plan.skipped.length > 0) {
      rows.push(
        s.dim(
          `${plural(plan.skipped.length, 'file')} left alone: ${plan.skipped.join(', ')}. ` +
            'Add --conflicts to write the conflicted ones with merge markers and resolve them yourself.',
        ),
      );
    }
    return lines(...rows);
  }

  rows.push(s.bold('Nothing has been written yet.'));
  if (doing.length > 0) rows.push(`Add ${s.bold('--apply')} to undo ${plural(doing.length, 'file')}.`);
  if (stuck.length > 0) {
    rows.push(
      s.dim(
        `${plural(stuck.length, 'file')} cannot be undone cleanly. ${s.bold('--apply --conflicts')} writes them with the usual ` +
          `<<<<<<< markers so you can resolve them; a file the agent created but you have since edited is never deleted for you.`,
      ),
    );
  }
  if (inert.length > 0) rows.push(s.dim(`${plural(inert.length, 'file')} needs nothing done.`));
  if (plan.dirty) {
    rows.push('', s.dim('Your worktree has uncommitted changes. Commit or stash them first and this is one git checkout away from undone.'));
  }
  return lines(...rows);
}

function noRuns(report: RevertReport, s: Style): string[] {
  const { runs, agent, hours } = report.selection;
  if (runs.length === 0 && agent === null && hours === null) {
    return [
      `${CLI_NAME} revert needs to know what to undo.`,
      '',
      `  ${s.bold(`${CLI_NAME} revert --run 43ac7f2`)}         one run`,
      `  ${s.bold(`${CLI_NAME} revert --agent claude-code`)}   everything that agent did`,
      `  ${s.bold(`${CLI_NAME} revert --agent claude-code --hours 2`)}  and only recently`,
    ];
  }
  return [
    `No recorded run matches ${selectionOf(report)}.`,
    s.dim(`Run ${CLI_NAME} log to see what is recorded.`),
  ];
}

function selectionOf(report: RevertReport): string {
  const { runs, agent, hours } = report.selection;
  const parts: string[] = [];
  if (runs.length > 0) parts.push(runs.join(', '));
  if (agent !== null) parts.push(agent);
  if (parts.length === 0) parts.push('every agent');
  if (hours !== null) parts.push(`in the last ${plural(hours, 'hour')}`);
  return parts.join(' ');
}

export function formatDoctor(report: DoctorReport, s: Style): string {
  const width = Math.max(...report.checks.map((check) => check.name.length));
  const rows = [`${s.bold(`${PRODUCT_NAME} check`)}  ${s.dim(report.repo.root)}`, ''];

  for (const check of report.checks) {
    rows.push(`  ${sign(check, s)} ${pad(check.name, width)}   ${check.detail}`);
    if (check.fix === null) continue;
    for (const line of check.fix.split('\n')) {
      rows.push(`  ${' '.repeat(width + 4)} ${s.dim(`→ ${line}`)}`);
    }
  }

  rows.push('');
  rows.push(
    report.problems === 0
      ? `${s.green('Everything checks out.')} Recording is on and the ledger is intact.`
      : `${plural(report.problems, 'thing')} to look at, listed above.`,
  );
  return lines(...rows);
}

function sign(check: Check, s: Style): string {
  if (check.status === 'ok') return s.green('✓');
  return check.status === 'fail' ? '✗' : '!';
}

export function formatGc(report: GcReport, s: Style): string {
  if (!report.initialized) {
    return lines(`${PRODUCT_NAME} is not set up here: ${report.repo.root}`, `Run ${s.bold(`${CLI_NAME} init`)} to start.`);
  }
  const { plan } = report;
  const cutoff = plan.before.slice(0, 10);

  if (plan.runs === 0) {
    return lines(
      `Nothing to drop: every run is newer than ${cutoff}.`,
      s.dim(plan.kept === 1 ? '1 run keeps its stored contents.' : `All ${plan.kept} runs keep their stored contents.`),
    );
  }
  if (plan.blobs === 0) {
    return lines(
      `Nothing to drop: the ${plural(plan.runs, 'run')} older than ${cutoff} share their contents with newer ones.`,
    );
  }

  const rows = [
    `${s.bold(`${plan.applied ? 'Released' : 'Would release'} the stored contents of ${plural(plan.runs, 'run')}`)}  ${s.dim(`older than ${cutoff}`)}`,
    '',
    `  contents   ${plural(plan.blobs, 'file state')}, ${bytes(plan.bytes)}`,
    `  records    ${s.green('kept')}  ${s.dim('who, when, why, which files, what it cost')}`,
    `  keeping    ${plural(plan.kept, 'run')} with their contents intact`,
    '',
  ];

  rows.push(
    `  history    ${plural(plan.history, 'ledger commit')} replaced by one`,
    s.dim('             an append-only history keeps every old tree, and every blob in it'),
    '',
  );

  if (plan.applied) {
    rows.push(
      `The ledger is compacted. ${bytes(plan.bytes)} of file contents are no longer held.`,
      s.dim('Nothing is deleted here: git owns its object store. Run git gc to reclaim the space.'),
      s.dim('blame now reports those older lines as unverifiable rather than guessing, and revert can no longer undo them.'),
    );
  } else {
    rows.push(
      s.bold('Nothing has been written.'),
      `Add ${s.bold('--apply')} to compact the ledger.`,
      s.dim('Every run record survives either way. What goes is the ability to revert those runs, and the seal-by-seal history of the ledger itself.'),
    );
  }
  return lines(...rows);
}

function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(0)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatShare(report: ShareReport, s: Style): string {
  if (!report.initialized) {
    return lines(`${PRODUCT_NAME} is not set up here: ${report.repo.root}`, `Run ${s.bold(`${CLI_NAME} init`)} to start.`);
  }
  const result = report.result;
  if (result === null) return lines('Nothing to share.');
  const rows: string[] = [];

  if (report.direction === 'push') {
    rows.push(
      result.gained > 0
        ? `Sent the ledger to ${s.bold(result.remote)}, after taking in ${plural(result.gained, 'run')} from it.`
        : `Sent the ledger to ${s.bold(result.remote)}.`,
    );
  } else if (result.unchanged) {
    rows.push(`Already in step with ${s.bold(result.remote)}.`);
  } else if (result.gained > 0) {
    rows.push(`${s.green(plural(result.gained, 'run'))} came in from ${s.bold(result.remote)}.`);
  } else {
    rows.push(`Nothing new from ${s.bold(result.remote)}.`);
  }

  if (report.direction === 'pull' && result.ahead > 0) {
    rows.push(s.dim(`${plural(result.ahead, 'run')} here that they do not have. ${CLI_NAME} push sends them.`));
  }
  if (result.disputed.length > 0) {
    rows.push(
      '',
      `${s.bold('Two ledgers disagree about the same entry.')} This should not be possible: a run is`,
      'keyed by its own id and never rewritten, and stored contents are keyed by their hash.',
      `What is here was kept. ${plural(result.disputed.length, 'entry')}: ${result.disputed.slice(0, 5).join(', ')}`,
    );
  }
  return lines(...rows);
}

export function formatReport(report: PrReport, s: Style, markdown = false): string {
  if (!report.initialized) {
    return lines(`${PRODUCT_NAME} is not set up here: ${report.repo.root}`, `Run ${s.bold(`${CLI_NAME} init`)} to start.`);
  }
  const result = report.result;
  if (result === null || result.changed === 0) {
    return markdown ? `No lines changed between \`${result?.base ?? ''}\` and HEAD.\n` : lines('No lines changed.');
  }
  const share = Math.round((result.byAgents / result.changed) * 100);
  return markdown ? asMarkdown(result, share) : asText(result, share, s);
}

function asText(result: NonNullable<PrReport['result']>, share: number, s: Style): string {
  const rows = [
    `${s.bold(`${share}% of this change was written by agents`)}  ${s.dim(`${result.byAgents} of ${plural(result.changed, 'line')}`)}`,
    '',
  ];
  for (const agent of result.agents) {
    rows.push(`  ${pad(agent.agent, 12)}  ${pad(plural(agent.lines, 'line'), 10)}  ${s.dim(agent.runs.map((run) => run.intent ?? run.id).join('; '))}`);
  }
  if (result.files.length > 0) {
    rows.push('', `  ${s.bold('by file')}`);
    const width = Math.max(...result.files.map((file) => file.path.length));
    for (const file of result.files) {
      rows.push(`    ${pad(file.path, width)}  ${s.dim(`${file.byAgents} of ${file.changed}`)}`);
    }
  }
  if (result.skipped > 0) rows.push('', s.dim(`${plural(result.skipped, 'file')} could not be read.`));
  return lines(...rows);
}

/** For a pull request comment, so it has to read well on its own. */
function asMarkdown(result: NonNullable<PrReport['result']>, share: number): string {
  const out: string[] = [
    `### ${share}% of this change was written by AI agents`,
    '',
    `${result.byAgents} of ${plural(result.changed, 'line')} this pull request touches.`,
    '',
  ];
  if (result.agents.length > 0) {
    out.push('| Agent | Lines | What it was asked to do |', '| --- | --- | --- |');
    for (const agent of result.agents) {
      const asked = agent.runs.map((run) => (run.intent === null ? `\`${run.id}\`` : run.intent)).join('<br>');
      out.push(`| \`${agent.agent}\` | ${agent.lines} | ${asked || '—'} |`);
    }
    out.push('');
  }
  if (result.files.length > 0) {
    out.push('<details><summary>By file</summary>', '', '| File | Agent lines | Changed |', '| --- | --- | --- |');
    for (const file of result.files) out.push(`| \`${file.path}\` | ${file.byAgents} | ${file.changed} |`);
    out.push('', '</details>', '');
  }
  out.push(`<sub>A line is counted only when it can be traced to the run that wrote it. [${PRODUCT_NAME}](https://deepblame.com)</sub>`);
  return `${out.join('\n')}\n`;
}

export function formatHooks(report: HooksReport, s: Style): string {
  const installed = report.files.filter((file) => file.installed);
  if (report.action === 'install') {
    const rows: string[] = [];
    for (const change of report.changes) {
      const where = relativeTo(report.repo.root, [change.file]);
      const what = whatChanged(change.file);
      rows.push(
        change.changed
          ? `${s.green('✓')} ${what}: ${s.bold(where)}`
          : `${s.dim('·')} ${what}: ${s.bold(where)} ${s.dim('(already there)')}`,
      );
    }
    const codex = report.changes.find((change) => change.file.endsWith('codex-notify.sh'));
    if (codex !== undefined) {
      rows.push(
        '',
        'One line left, and it is yours to add, not ours — Codex reads a config outside this project:',
        s.bold(`  notify = ["${codex.file}"]`),
        s.dim('  goes in ~/.codex/config.toml'),
      );
    }
    return lines(...rows);
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

/** Says what a settings file now does, in the words of the tool it belongs to. */
function whatChanged(file: string): string {
  const path = slashes(file);
  if (path.endsWith('post-commit')) return 'Every commit is now recorded, whichever tool wrote it';
  if (path.endsWith('codex-notify.sh')) return 'Codex can now report each finished turn';
  if (path.endsWith(`/${OPENCODE_PLUGIN}`)) return 'OpenCode now reports every prompt, tool call, edit and what it spent';
  if (path.includes('/.cursor/')) return 'Cursor now reports every prompt, read and edit';
  return 'Claude Code now reports every prompt, tool call and edit';
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
