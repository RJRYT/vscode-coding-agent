import { describe, expect, it, vi } from 'vitest';
import { ToolDispatcher } from '../src/toolDispatcher';
import type { ToolRegistry } from '../src/tools';

describe('ToolDispatcher', () => {
  it('validates arguments before calling a registry method', async () => {
    const registry = { readFile: vi.fn(async (path: string) => ({ content: `read:${path}` })) } as unknown as ToolRegistry;
    const dispatcher = new ToolDispatcher(registry);
    const result = await dispatcher.dispatch('read_file', { path: 'src/index.ts' }, new AbortController().signal);
    expect(result.content).toBe('read:src/index.ts');
    expect(registry.readFile).toHaveBeenCalledWith('src/index.ts');
  });

  it('does not dispatch malformed or unsupported operations', async () => {
    const registry = { readFile: vi.fn() } as unknown as ToolRegistry;
    const dispatcher = new ToolDispatcher(registry);
    await expect(dispatcher.dispatch('read_file', { path: '' }, new AbortController().signal)).rejects.toThrow(/path/);
    await expect(dispatcher.dispatch('remove_workspace', {}, new AbortController().signal)).rejects.toThrow(/Unsupported tool/);
    expect(registry.readFile).not.toHaveBeenCalled();
  });
});
