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

  listChats(): ChatSummary[] {
    const workspaceId = this.getWorkspaceId();
    if (!workspaceId) return [];
    const raw = this.context.workspaceState.get<ChatData[]>(this.getChatsKey(workspaceId), []);
    return raw
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
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
    const chats = this.context.workspaceState.get<ChatData[]>(this.getChatsKey(workspaceId), []);
    return chats.find((c) => c.id === id);
  }

  saveChat(chat: ChatData): void {
    const workspaceId = this.getWorkspaceId();
    if (!workspaceId) return;
    const chats = this.context.workspaceState.get<ChatData[]>(this.getChatsKey(workspaceId), []);
    const existing = chats.findIndex((c) => c.id === chat.id);
    if (existing >= 0) {
      chats[existing] = chat;
    } else {
      chats.unshift(chat);
      if (chats.length > MAX_CHATS) {
        chats.length = MAX_CHATS;
      }
    }
    void this.context.workspaceState.update(this.getChatsKey(workspaceId), chats);
  }

  deleteChat(id: string): void {
    const workspaceId = this.getWorkspaceId();
    if (!workspaceId) return;
    const chats = this.context.workspaceState.get<ChatData[]>(this.getChatsKey(workspaceId), []);
    const filtered = chats.filter((c) => c.id !== id);
    if (filtered.length !== chats.length) {
      void this.context.workspaceState.update(this.getChatsKey(workspaceId), filtered);
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