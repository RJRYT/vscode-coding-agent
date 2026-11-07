import * as vscode from 'vscode';
import {
  ChatData,
  ChatMemory,
  ChatSummary,
  MAX_CHATS,
  MAX_MEMORY_FACTS,
} from './config';

const STORAGE_KEY = 'nemotronAgent.chats';

export class ChatStore {
  private readonly context: vscode.ExtensionContext;
  private readonly cache = new Map<string, ChatData[]>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  private getChatsKey(workspaceId: string): string {
    return `${STORAGE_KEY}.${workspaceId}`;
  }

  private getWorkspaceId(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return undefined;
    // Use the first workspace folder's URI as a stable identifier.
    return folders[0].uri.toString();
  }

  private readChats(workspaceId: string): ChatData[] {
    const cached = this.cache.get(workspaceId);
    if (cached) return cached;
    const loaded = this.context.workspaceState.get<ChatData[]>(this.getChatsKey(workspaceId), []);
    this.cache.set(workspaceId, loaded);
    return loaded;
  }

  private persistChats(workspaceId: string, chats: ChatData[]): void {
    const key = this.getChatsKey(workspaceId);
    const snapshot = chats.map((chat) => ({ ...chat, messages: [...chat.messages] }));
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.context.workspaceState.update(key, snapshot));
    this.writes.set(key, next);
    void next.catch(() => this.writes.delete(key));
  }

  listChats(): ChatSummary[] {
    const workspaceId = this.getWorkspaceId();
    if (!workspaceId) return [];
    const raw = this.readChats(workspaceId);
    return raw
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messages.filter((message) => message.role === 'user' || message.role === 'assistant').length,
        preview: c.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => m.content ?? '')
          .join(' ')
          .slice(0, 120),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getChat(id: string): ChatData | undefined {
    const workspaceId = this.getWorkspaceId();
    if (!workspaceId) return undefined;
    const chats = this.readChats(workspaceId);
    return chats.find((c) => c.id === id);
  }

  saveChat(chat: ChatData): void {
    const workspaceId = this.getWorkspaceId();
    if (!workspaceId) return;
    const chats = this.readChats(workspaceId);
    const existing = chats.findIndex((c) => c.id === chat.id);
    if (existing >= 0) {
      chats[existing] = chat;
    } else {
      chats.unshift(chat);
      if (chats.length > MAX_CHATS) {
        chats.length = MAX_CHATS;
      }
    }
    this.persistChats(workspaceId, chats);
  }

  deleteChat(id: string): void {
    const workspaceId = this.getWorkspaceId();
    if (!workspaceId) return;
    const chats = this.readChats(workspaceId);
    const filtered = chats.filter((c) => c.id !== id);
    if (filtered.length !== chats.length) {
      this.cache.set(workspaceId, filtered);
      this.persistChats(workspaceId, filtered);
    }
  }

  getMemory(id: string): ChatMemory | undefined {
    const chat = this.getChat(id);
    return chat?.memory;
  }

  saveMemory(id: string, memory: ChatMemory): void {
    const chat = this.getChat(id);
    if (!chat) return;
    const facts = memory.facts.slice(0, MAX_MEMORY_FACTS);
    chat.memory = { facts, updatedAt: Date.now() };
    this.saveChat(chat);
  }

  addMemoryFact(id: string, fact: string): void {
    const memory = this.getMemory(id) ?? { facts: [], updatedAt: Date.now() };
    if (memory.facts.includes(fact)) return;
    memory.facts.unshift(fact);
    this.saveMemory(id, memory);
  }

  generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  generateTitle(firstUserMessage: string): string {
    const trimmed = firstUserMessage.trim().replace(/\s+/g, ' ');
    return trimmed.slice(0, 60) || 'New chat';
  }
}