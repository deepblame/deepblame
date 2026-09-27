import { blame, findRun, openRepo, revert, type BlameResult } from '@deepblame/core';
import * as vscode from 'vscode';
import {
  agentName,
  agentNotes,
  applyEdit,
  bands,
  explain,
  fileSummary,
  hover,
  label,
  noteAt,
  summaryTooltip,
  undoPrompt,
  undoResult,
  type LineNote,
} from './annotate';

/**
 * The editor layer. It holds no opinions of its own: `annotate.ts` decides what
 * every piece of text says, and this file puts it on the screen and takes the
 * three actions a person can ask for.
 *
 * Reading the ledger means running git, which is quick but not free, so it
 * happens when the answer can actually have changed — a different file, a save,
 * the window coming back into focus after an agent has been working in a
 * terminal — and never on a keystroke. Between those, an unsaved edit shifts
 * the marks already on screen.
 */

const AGENT_COLOR = new vscode.ThemeColor('deepblame.agentLine');
const LABEL_COLOR = new vscode.ThemeColor('deepblame.annotation');

let enabled = true;
let notes: LineNote[] = [];
/** The file the notes belong to, so a stale answer is never drawn on another. */
let notesFor: string | null = null;
let result: BlameResult | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const band = vscode.window.createTextEditorDecorationType({
    isWholeLine: false,
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: AGENT_COLOR,
    overviewRulerColor: AGENT_COLOR,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const trailing = vscode.window.createTextEditorDecorationType({
    after: { color: LABEL_COLOR, margin: '0 0 0 3em', fontStyle: 'italic' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const status = vscode.window.createStatusBarItem('deepblame.share', vscode.StatusBarAlignment.Right, 100);
  status.command = 'deepblame.toggle';
  context.subscriptions.push(band, trailing, status);

  enabled = vscode.workspace.getConfiguration('deepblame').get<boolean>('enabled', true);

  /** Redraws from whatever is already known. Cheap: no git, no disk. */
  const draw = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) return;
    const mine = notesFor === editor.document.uri.fsPath;
    if (!enabled || !mine) {
      editor.setDecorations(band, []);
      editor.setDecorations(trailing, []);
      status.hide();
      return;
    }
    const last = editor.document.lineCount - 1;
    editor.setDecorations(
      band,
      bands(notes)
        .filter((run) => run.from <= last)
        .map((run) => ({ range: new vscode.Range(run.from, 0, Math.min(run.to, last), 0) })),
    );

    // The label sits on the cursor's line only. On every line it would be a
    // wall of grey text competing with the code.
    const here = editor.selection.active.line;
    const note = here > last ? null : noteAt(notes, here);
    const end = note === null ? 0 : editor.document.lineAt(here).text.length;
    editor.setDecorations(
      trailing,
      note === null
        ? []
        : [
            {
              range: new vscode.Range(here, end, here, end),
              renderOptions: { after: { contentText: label(note.span) } },
            },
          ],
    );

    const share = fileSummary(result);
    if (share === null) {
      status.hide();
      return;
    }
    status.text = `$(robot) ${share}`;
    status.tooltip = summaryTooltip(result);
    status.show();
  };

  /** Asks the ledger again. Debounced, because saves and focus arrive in bursts. */
  const refresh = (delay = 120): void => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined || editor.document.uri.scheme !== 'file') {
        notes = [];
        notesFor = null;
        result = null;
        draw();
        return;
      }
      const path = editor.document.uri.fsPath;
      const answer = read(path);
      result = answer;
      notes = agentNotes(answer);
      notesFor = path;
      draw();
    }, delay);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      // Clear first: the old file's marks must never linger on the new one.
      notes = [];
      notesFor = null;
      result = null;
      draw();
      refresh(0);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) draw();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.fsPath === notesFor) refresh(250);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.fsPath !== notesFor || event.contentChanges.length === 0) return;
      for (const change of event.contentChanges) {
        notes = applyEdit(notes, {
          from: change.range.start.line,
          to: change.range.end.line,
          lines: change.text.split('\n').length,
        });
      }
      draw();
    }),
    // An agent working in a terminal or another window seals as it stops, so
    // coming back to the editor is exactly when the answer has changed.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) refresh(400);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('deepblame.enabled')) return;
      enabled = vscode.workspace.getConfiguration('deepblame').get<boolean>('enabled', true);
      draw();
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      {
        provideHover(document, position) {
          if (!enabled || document.uri.fsPath !== notesFor) return null;
          const note = noteAt(notes, position.line);
          if (note === null) return null;
          const text = new vscode.MarkdownString(hover(note.span, { commands: true }));
          // Only so the two action links work. The content is ours.
          text.isTrusted = { enabledCommands: ['deepblame.undoRun', 'deepblame.showRun'] };
          return new vscode.Hover(text, document.lineAt(position.line).range);
        },
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepblame.toggle', async () => {
      enabled = !enabled;
      await vscode.workspace
        .getConfiguration('deepblame')
        .update('enabled', enabled, vscode.ConfigurationTarget.Workspace);
      draw();
    }),
    vscode.commands.registerCommand('deepblame.explainLine', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) return;
      const line = editor.selection.active.line;
      const note = noteAt(notes, line);
      const said = explain(note?.span ?? null, vscode.workspace.asRelativePath(editor.document.uri), line);
      const options = note === null ? [] : ['Undo this run'];
      void vscode.window.showInformationMessage(said.split('\n')[0] ?? '', { modal: true, detail: said }, ...options).then(
        (chosen) => {
          if (chosen !== undefined && note !== null) void undoRun(note.run.run_id, refresh);
        },
      );
    }),
    vscode.commands.registerCommand('deepblame.undoRun', (runId: unknown) => {
      if (typeof runId !== 'string') return;
      void undoRun(runId, refresh);
    }),
    vscode.commands.registerCommand('deepblame.showRun', (runId: unknown) => {
      if (typeof runId !== 'string') return;
      showRun(runId);
    }),
  );

  refresh(0);
}

export function deactivate(): void {
  if (pending !== null) clearTimeout(pending);
}

/** Reads the ledger for one file, and stays quiet when there is nothing to say. */
function read(path: string): BlameResult | null {
  try {
    return blame(dirOf(path), path).result;
  } catch {
    // Not a repository, not tracked, DeepBlame not set up, git missing. None of
    // these are the person's problem right now, and an editor that pops errors
    // at you for opening a file is worse than one that says nothing.
    return null;
  }
}

/** The plan, then a confirmation, then — only then — the files change. */
async function undoRun(runId: string, refresh: (delay?: number) => void): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const cwd = editor === undefined ? workspaceDir() : dirOf(editor.document.uri.fsPath);
  if (cwd === null) return;

  const found = safely(() => findRun(openRepo(cwd), runId));
  const planned = safely(() => revert(cwd, { runs: [runId] }));
  if (planned === null || planned.plan === null) {
    void vscode.window.showWarningMessage('DeepBlame could not work out how to undo that run here.');
    return;
  }
  const run = found?.run ?? null;
  if (run === null) {
    void vscode.window.showWarningMessage('That run is no longer in the ledger.');
    return;
  }
  const ask = undoPrompt(planned.plan, run);
  if (ask === null) {
    void vscode.window.showInformationMessage(`Nothing of that ${agentName(run)} run is left to undo.`);
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    ask.message,
    { modal: true, detail: ask.detail },
    'Undo it',
  );
  if (answer !== 'Undo it') return;

  const done = safely(() => revert(cwd, { runs: [runId], apply: true }));
  if (done === null || done.plan === null) {
    void vscode.window.showErrorMessage('DeepBlame could not write the files back.');
    return;
  }
  void vscode.window.showInformationMessage(undoResult(done.plan));
  refresh(0);
}

/** Everything one run did, in a scratch document rather than a popup. */
function showRun(runId: string): void {
  const editor = vscode.window.activeTextEditor;
  const cwd = editor === undefined ? workspaceDir() : dirOf(editor.document.uri.fsPath);
  if (cwd === null) return;
  const found = safely(() => findRun(openRepo(cwd), runId));
  if (found === null) {
    void vscode.window.showWarningMessage('That run is no longer in the ledger.');
    return;
  }
  void vscode.workspace
    .openTextDocument({ language: 'json', content: JSON.stringify(found.run, null, 2) })
    .then((document) => vscode.window.showTextDocument(document, { preview: true }));
}

function safely<T>(work: () => T): T | null {
  try {
    return work();
  } catch {
    return null;
  }
}

function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? path : path.slice(0, cut);
}

function workspaceDir(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}
