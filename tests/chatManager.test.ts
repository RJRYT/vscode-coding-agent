import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }));
import { ChatManager } from '../src/chatManager';
import type { ChatStore } from '../src/storage';

describe('ChatManager', () => {
  it('creates a chat with stable metadata and generated title', () => {
    const fakeStore = {
      generateId: () => 'chat-1',
      generateTitle: (text: string) => text.slice(0, 60),
    } as unknown as ChatStore;
    const manager = new ChatManager(fakeStore);
    const chat = manager.create('Implement a feature');
    expect(chat.id).toBe('chat-1');
    expect(chat.title).toBe('Implement a feature');
    expect(chat.messages).toEqual([]);
    expect(chat.updatedAt).toBe(chat.createdAt);
  });

  it('snapshots message arrays without mutating the source chat', () => {
    const fakeStore = {
      generateTitle: (text: string) => text.slice(0, 60),
    } as unknown as ChatStore;
    const manager = new ChatManager(fakeStore);
    const source = { id: '1', title: 'New chat', createdAt: 1, updatedAt: 1, messages: [] };
    const messages = [{ role: 'user' as const, content: 'Investigate build failure' }];
    const snapshot = manager.snapshot(source, messages);
    expect(snapshot.title).toBe('Investigate build failure');
    expect(snapshot.messages).toEqual(messages);
    expect(snapshot.messages).not.toBe(messages);
    expect(source.messages).toEqual([]);
  });
});
