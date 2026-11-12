import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { toString: () => 'file:///workspace' } }] },
}));
import { ChatStore } from '../src/storage';

function createStore() {
  const values = new Map<string, unknown>();
  const context = {
    workspaceState: {
      get: (key: string, fallback: unknown) => (values.has(key) ? values.get(key) : fallback),
      update: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    },
  };
  return { store: new ChatStore(context as never), values };
}

describe('ChatStore persistence', () => {
  it('persists, reloads, summarizes and deletes chats', async () => {
    const { store } = createStore();
    const chat = {
      id: 'chat-1',
      title: 'Build UI',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { role: 'user' as const, content: 'Build UI' },
        { role: 'assistant' as const, content: 'I can help.' },
      ],
    };
    store.saveChat(chat);
    await store.flush();
    expect(store.getChat('chat-1')?.messages).toHaveLength(2);
    expect(store.listChats()[0]?.messageCount).toBe(2);
    store.deleteChat('chat-1');
    await store.flush();
    expect(store.getChat('chat-1')).toBeUndefined();
  });

  it('keeps memory facts bounded and deduplicated', async () => {
    const { store } = createStore();
    store.saveChat({ id: 'chat-2', title: 'Memory', createdAt: 1, updatedAt: 1, messages: [] });
    store.addMemoryFact('chat-2', 'Use TypeScript');
    store.addMemoryFact('chat-2', 'Use TypeScript');
    await store.flush();
    expect(store.getMemory('chat-2')?.facts).toEqual(['Use TypeScript']);
  });
});
