import { describe, expect, it, vi } from 'vitest';
import { ToolDispatcher } from '../src/toolDispatcher';
import type { ToolRegistry } from '../src/tools';

describe('ToolDispatcher', () => {
  it('validates arguments before calling a registry method', async () => {
    const registry = {
      readFile: vi.fn(async (path: string) => ({ content: `read:${path}` })),
    } as unknown as ToolRegistry;
    const dispatcher = new ToolDispatcher(registry);
    const result = await dispatcher.dispatch(
      'read_file',
      { path: 'src/index.ts' },
      new AbortController().signal
    );
    expect(result.content).toBe('read:src/index.ts');
    expect(registry.readFile).toHaveBeenCalledWith('src/index.ts', undefined, undefined);
  });

  it('does not dispatch malformed or unsupported operations', async () => {
    const registry = { readFile: vi.fn() } as unknown as ToolRegistry;
    const dispatcher = new ToolDispatcher(registry);
    await expect(
      dispatcher.dispatch('read_file', { path: '' }, new AbortController().signal)
    ).rejects.toThrow(/path/);
    await expect(
      dispatcher.dispatch('remove_workspace', {}, new AbortController().signal)
    ).rejects.toThrow(/Unsupported tool/);
    expect(registry.readFile).not.toHaveBeenCalled();
  });
});

describe('ToolDispatcher extended tools', () => {
  it('routes folder lifecycle operations through approval-aware registry methods', async () => {
    const registry = {
      createFolder: vi.fn(async (path: string) => ({ content: `created:${path}` })),
      deleteFile: vi.fn(async (path: string) => ({ content: `deleted:${path}` })),
      deleteFolder: vi.fn(async (path: string) => ({ content: `deleted-folder:${path}` })),
    } as unknown as ToolRegistry;
    const dispatcher = new ToolDispatcher(registry);
    expect(
      (
        await dispatcher.dispatch(
          'create_folder',
          { path: 'src/new' },
          new AbortController().signal
        )
      ).content
    ).toBe('created:src/new');
    expect(
      (
        await dispatcher.dispatch(
          'delete_file',
          { path: 'src/old.ts' },
          new AbortController().signal
        )
      ).content
    ).toBe('deleted:src/old.ts');
    expect(
      (
        await dispatcher.dispatch(
          'delete_folder',
          { path: 'src/old' },
          new AbortController().signal
        )
      ).content
    ).toBe('deleted-folder:src/old');
  });

  it('passes both create and edit candidates to the registry for filesystem-aware resolution', async () => {
    const registry = {
      proposeFileEdit: vi.fn(async () => ({ content: 'resolved' })),
    } as unknown as ToolRegistry;
    const dispatcher = new ToolDispatcher(registry);
    await dispatcher.dispatch(
      'propose_file_edit',
      {
        path: 'src/file.ts',
        edits: [{ oldText: 'old', newText: 'new' }],
        createContent: 'new file',
      },
      new AbortController().signal
    );
    expect(registry.proposeFileEdit).toHaveBeenCalledWith(
      'src/file.ts',
      [{ oldText: 'old', newText: 'new' }],
      'new file',
      'File change proposed by Nemotron',
      expect.any(AbortSignal)
    );
  });

  it('routes Git manager actions to the registry', async () => {
    const registry = {
      gitManager: vi.fn(async ({ action }: { action: string }) => ({ content: action })),
    } as unknown as ToolRegistry;
    const dispatcher = new ToolDispatcher(registry);
    expect(
      (await dispatcher.dispatch('git_manager', { action: 'status' }, new AbortController().signal))
        .content
    ).toBe('status');
    expect(registry.gitManager).toHaveBeenCalledWith({ action: 'status' }, expect.any(AbortSignal));
  });
});
