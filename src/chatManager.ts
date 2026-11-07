import type { ChatData, ChatMessage } from './config';
import type { ChatStore } from './storage';

/** Persistence and chat metadata operations, independent from model/tool orchestration. */
export class ChatManager {
  constructor(private readonly store: ChatStore) {}

  create(firstMessage: string): ChatData {
    const now = Date.now();
    return {
      id: this.store.generateId(),
      title: this.store.generateTitle(firstMessage),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  load(id: string): ChatData | undefined { return this.store.getChat(id); }
  save(chat: ChatData): void { this.store.saveChat(chat); }
  list() { return this.store.listChats(); }
  delete(id: string): void { this.store.deleteChat(id); }

  snapshot(chat: ChatData, messages: ChatMessage[]): ChatData {
    const firstUser = messages.find((message) => message.role === 'user')?.content;
    return {
      ...chat,
      title: chat.title === 'New chat' && firstUser ? this.store.generateTitle(firstUser) : chat.title,
      messages: [...messages],
      updatedAt: Date.now(),
    };
  }
}
