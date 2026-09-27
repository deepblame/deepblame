/**
 * Enough of the editor to run the extension outside one.
 *
 * The extension layer is thin, but thin is not the same as right: it still has
 * to put the correct ranges on the correct file, clear them when the file
 * changes, and hand the ledger the path the person is actually looking at. None
 * of that is visible from `annotate.ts`, and a real VS Code cannot be started
 * here — so this stands in for it, records what it was told to draw, and lets a
 * test drive the events an editor would send.
 *
 * What it deliberately does not check is appearance. Whether the mark is the
 * right shade of green in a dark theme is not knowable from here.
 */

export interface Drawn {
  range: [number, number, number, number];
  contentText?: string;
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === 'number' && typeof b === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c ?? a, d ?? b);
    } else {
      this.start = a as Position;
      this.end = b as Position;
    }
  }
}

export class MarkdownString {
  isTrusted: boolean | { readonly enabledCommands: readonly string[] } = false;
  constructor(public value = '') {}
}

export class Hover {
  constructor(
    readonly contents: unknown,
    readonly range?: Range,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 } as const;
export const DecorationRangeBehavior = { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

/** One decoration type, and whatever is currently drawn with it. */
export interface DecorationType {
  readonly id: number;
  drawn: Drawn[];
  dispose(): void;
}

type Listener = (value: unknown) => void;

/** The parts of the editor the extension talks to, all of it observable. */
class Stub {
  decorations: DecorationType[] = [];
  statusBar = { text: '', tooltip: '', visible: false, command: '', dispose(): void {} };
  commands = new Map<string, (...args: unknown[]) => unknown>();
  hovers: { selector: unknown; provider: { provideHover: (...args: unknown[]) => unknown } }[] = [];
  listeners = new Map<string, Listener[]>();
  settings = new Map<string, unknown>([['deepblame.enabled', true]]);
  /** Every modal the extension raised, and the answer to give for the next one. */
  asked: { message: string; detail?: string; items: string[] }[] = [];
  answers: (string | undefined)[] = [];
  shown: string[] = [];
  opened: { language?: string; content?: string }[] = [];
  editor: FakeEditor | null = null;
  folder: string | null = null;

  reset(): void {
    this.decorations = [];
    this.commands.clear();
    this.hovers = [];
    this.listeners.clear();
    this.asked = [];
    this.answers = [];
    this.shown = [];
    this.opened = [];
    this.editor = null;
    this.statusBar = { text: '', tooltip: '', visible: false, command: '', dispose(): void {} };
    this.settings = new Map([['deepblame.enabled', true]]);
  }

  fire(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

export const stub = new Stub();

/** A document and its editor, as the extension sees them. */
export class FakeEditor {
  selection: { active: Position };
  constructor(
    readonly path: string,
    public text: string,
    line = 0,
  ) {
    this.selection = { active: new Position(line, 0) };
  }

  get document() {
    const lines = this.text.split('\n');
    return {
      uri: { fsPath: this.path, scheme: 'file' },
      lineCount: lines.length,
      lineAt: (line: number) => ({
        text: lines[line] ?? '',
        range: new Range(line, 0, line, (lines[line] ?? '').length),
      }),
    };
  }

  /** What the extension asked to be drawn with one decoration type. */
  decorationsOf(index: number): Drawn[] {
    return stub.decorations[index]?.drawn ?? [];
  }

  setDecorations(type: DecorationType, given: { range: Range; renderOptions?: { after?: { contentText?: string } } }[]): void {
    type.drawn = given.map((one) => ({
      range: [one.range.start.line, one.range.start.character, one.range.end.line, one.range.end.character],
      ...(one.renderOptions?.after?.contentText === undefined
        ? {}
        : { contentText: one.renderOptions.after.contentText }),
    }));
  }

  at(line: number): this {
    this.selection = { active: new Position(line, 0) };
    return this;
  }
}

function on(event: string) {
  return (listener: Listener) => {
    const held = stub.listeners.get(event) ?? [];
    held.push(listener);
    stub.listeners.set(event, held);
    return { dispose: (): void => {} };
  };
}

export const window = {
  get activeTextEditor(): FakeEditor | undefined {
    return stub.editor ?? undefined;
  },
  createTextEditorDecorationType(): DecorationType {
    const type: DecorationType = { id: stub.decorations.length, drawn: [], dispose: (): void => {} };
    stub.decorations.push(type);
    return type;
  },
  createStatusBarItem() {
    const bar = stub.statusBar;
    return {
      set text(value: string) {
        bar.text = value;
      },
      get text(): string {
        return bar.text;
      },
      set tooltip(value: string) {
        bar.tooltip = value;
      },
      set command(value: string) {
        bar.command = value;
      },
      show: (): void => {
        bar.visible = true;
      },
      hide: (): void => {
        bar.visible = false;
      },
      dispose: (): void => {},
    };
  },
  showInformationMessage(message: string, ...rest: unknown[]) {
    return record(message, rest);
  },
  showWarningMessage(message: string, ...rest: unknown[]) {
    return record(message, rest);
  },
  showErrorMessage(message: string, ...rest: unknown[]) {
    return record(message, rest);
  },
  showTextDocument(): Promise<void> {
    return Promise.resolve();
  },
  onDidChangeActiveTextEditor: on('activeEditor'),
  onDidChangeTextEditorSelection: on('selection'),
  onDidChangeWindowState: on('windowState'),
};

function record(message: string, rest: unknown[]): Promise<string | undefined> {
  const options = typeof rest[0] === 'object' && rest[0] !== null ? (rest[0] as { detail?: string }) : undefined;
  const items = rest.filter((one): one is string => typeof one === 'string');
  stub.shown.push(message);
  if (options?.detail !== undefined || items.length > 0) {
    stub.asked.push({ message, detail: options?.detail, items });
    return Promise.resolve(stub.answers.shift());
  }
  return Promise.resolve(undefined);
}

export const workspace = {
  getConfiguration(section: string) {
    return {
      get: <T>(key: string, fallback: T): T => (stub.settings.get(`${section}.${key}`) as T) ?? fallback,
      update: (key: string, value: unknown): Promise<void> => {
        stub.settings.set(`${section}.${key}`, value);
        return Promise.resolve();
      },
    };
  },
  get workspaceFolders() {
    return stub.folder === null ? undefined : [{ uri: { fsPath: stub.folder } }];
  },
  asRelativePath(uri: { fsPath: string }): string {
    const base = stub.folder;
    return base !== null && uri.fsPath.startsWith(`${base}/`) ? uri.fsPath.slice(base.length + 1) : uri.fsPath;
  },
  openTextDocument(options: { language?: string; content?: string }): Promise<unknown> {
    stub.opened.push(options);
    return Promise.resolve({});
  },
  onDidSaveTextDocument: on('save'),
  onDidChangeTextDocument: on('change'),
  onDidChangeConfiguration: on('configuration'),
};

export const languages = {
  registerHoverProvider(selector: unknown, provider: { provideHover: (...args: unknown[]) => unknown }) {
    stub.hovers.push({ selector, provider });
    return { dispose: (): void => {} };
  },
};

export const commands = {
  registerCommand(name: string, handler: (...args: unknown[]) => unknown) {
    stub.commands.set(name, handler);
    return { dispose: (): void => {} };
  },
  executeCommand(name: string, ...args: unknown[]): unknown {
    return stub.commands.get(name)?.(...args);
  },
};
