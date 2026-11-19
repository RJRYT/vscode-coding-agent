import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '../src/tools';

vi.mock('vscode', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  // Mutable test state: the workspace root and the simulated live buffer text.
  const state = { root: '', documentText: '' };
  const makeUri = (fsPath: string) => ({
    fsPath,
    toString: () => `file://${fsPath}`,
    with: () => {
      throw new Error('Uri.with is not used in this test');
    },
  });
  const vscodeMock = {
    __state: state,
    FileType: { File: 1, Directory: 2 },
    Uri: {
      joinPath: (base: { fsPath: string }, rel: string) => makeUri(path.join(base.fsPath, rel)),
    },
    workspace: {
      get workspaceFolders() {
        return [{ uri: makeUri(state.root) }];
      },
      isTrusted: true,
      textDocuments: [] as Array<Record<string, unknown>>,
      findFiles: async () => [],
      asRelativePath: (uri: { fsPath: string }) => path.relative(state.root, uri.fsPath),
      fs: {
        readFile: async (uri: { fsPath: string }) => fs.readFileSync(uri.fsPath),
        stat: async (uri: { fsPath: string }) => {
          const s = fs.statSync(uri.fsPath);
          return { type: s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
        },
        delete: async () => {},
      },
      openTextDocument: async () => ({
        uri: makeUri(path.join(state.root, 'note.txt')),
        version: 1,
        isDirty: false,
        getText: () => state.documentText,
        positionAt: () => ({ line: 0, character: 0 }),
      }),
    },
  };
  return { default: vscodeMock, ...vscodeMock };
});

// The mocked vscode module carries __state so the test can drive it.
import * as vscodeModule from 'vscode';

const state = (vscodeModule as unknown as {
  __state: { root: string; documentText: string };
}).__state;

state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-edit-hint-'));
const setDocumentText = (text: string) => {
  state.documentText = text;
};

function makeRegistry(): ToolRegistry {
  return new ToolRegistry(async () => 'cancel');
}

function writeNote(text: string): void {
  fs.writeFileSync(path.join(state.root, 'note.txt'), text);
}

describe('stale-read diagnosis for failed edit anchors', () => {
  beforeEach(() => {
    setDocumentText('');
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('tells the model to re-read when the file changed since the last read_file', async () => {
    writeNote('alpha\nbeta\ngamma\n');
    const registry = makeRegistry();
    await registry.readFile('note.txt');

    // Simulate the live buffer having moved on after the recorded snapshot.
    setDocumentText('alpha\nbeta2\ngamma\n');

    await expect(
      registry.proposeFileEdit(
        'note.txt',
        [{ oldText: 'beta\ngamma', newText: 'beta\ndelta' }],
        undefined,
        'typo fix'
      )
    ).rejects.toThrow(/changed since your last read_file/);
  });

  it('tells the model to read the file first when no snapshot exists', async () => {
    setDocumentText('one\ntwo\nthree\n');
    const registry = makeRegistry();

    await expect(
      registry.proposeFileEdit(
        'note.txt',
        [{ oldText: 'four\nfive', newText: 'four\nsix' }],
        undefined,
        'append line'
      )
    ).rejects.toThrow(/No read_file snapshot was recorded/);
  });

  it('does not append a stale-read hint when the anchor matches', async () => {
    writeNote('alpha\nbeta\ngamma\n');
    setDocumentText('alpha\nbeta\ngamma\n');
    const registry = makeRegistry();
    await registry.readFile('note.txt');

    // askApproval returns 'cancel', so a healthy proposal stops at approval
    // instead of applying — and must arrive without any stale-read diagnosis.
    const result = await registry.proposeFileEdit(
      'note.txt',
      [{ oldText: 'beta\ngamma', newText: 'beta\ndelta' }],
      undefined,
      'typo fix'
    );
    expect(result.content ?? '').not.toMatch(/read_file snapshot|stale/i);
    expect(result.content).toMatch(/cancelled/i);
  });
});
