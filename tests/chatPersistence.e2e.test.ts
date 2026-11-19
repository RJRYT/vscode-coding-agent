import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { toString: () => 'file:///workspace' } }] },
}));
import { ChatStore } from '../src/storage';
import { ChatManager } from '../src/chatManager';

describe('end-to-end data layer: create -> persist -> reload', () => {
  it('round-trips a chat through real persistence', async () => {
    const values = new Map<string, unknown>();
    const context = {
      workspaceState: {
        get: (k: string, f: unknown) => (values.has(k) ? values.get(k) : f),
        update: async (k: string, v: unknown) => {
          values.set(k, v);
        },
      },
    };
    const store = new ChatStore(context as never);
    const manager = new ChatManager(store);

    let chat = manager.create('Fix the login bug');
    chat.messages.push({ role: 'user', content: 'Fix the login bug' });
    chat.messages.push({ role: 'assistant', content: 'On it — patching auth.ts.' });
    chat = manager.snapshot(chat, chat.messages);
    manager.save(chat);
    await store.flush();

    // Simulate an extension restart: brand-new store over the same persisted state.
    const store2 = new ChatStore(context as never);
    const reloaded = store2.getChat(chat.id);
    expect(reloaded?.messages).toHaveLength(2);
    expect(reloaded?.messages[1].content).toBe('On it — patching auth.ts.');
    expect(store2.listChats()[0].title).toContain('Fix the login bug');
    expect(store2.listChats()[0].messageCount).toBe(2);

    // Delete path also round-trips.
    store2.deleteChat(chat.id);
    await store2.flush();
    expect(new ChatStore(context as never).getChat(chat.id)).toBeUndefined();
  });
});
