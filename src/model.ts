import type { ChatMessage, ModelResponse, ToolCall } from './config';

export class ModelClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly reasoning: boolean;
  private readonly onDelta?: (text: string) => void;
  private readonly onReasoningDelta?: (text: string) => void;

  constructor({
    baseUrl,
    apiKey,
    model,
    maxTokens,
    reasoning,
    onDelta,
    onReasoningDelta,
  }: {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    reasoning: boolean;
    onDelta?: (text: string) => void;
    onReasoningDelta?: (text: string) => void;
  }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.reasoning = reasoning;
    this.onDelta = onDelta;
    this.onReasoningDelta = onReasoningDelta;
  }

  async request(
    signal: AbortSignal,
    messages: ChatMessage[],
    tools: unknown[]
  ): Promise<ModelResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        temperature: 1,
        top_p: 0.95,
        max_tokens: this.maxTokens,
        stream: true,
        chat_template_kwargs: { enable_thinking: this.reasoning, force_nonempty_content: true },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`NVIDIA API returned ${response.status}: ${body.slice(0, 1400)}`);
    }
    if (!response.body) {
      throw new Error('NVIDIA API returned an empty response stream.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    const toolCalls = new Map<number, ToolCall>();

    let done = false;
    while (!done) {
      const { value, done: chunkDone } = await reader.read();
      done = chunkDone;
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }
        const parsed = payload as {
          error?: { message?: string };
          choices?: Array<{ delta?: unknown }>;
        };
        if (parsed.error) {
          throw new Error(parsed.error.message || 'NVIDIA stream returned an error.');
        }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        const deltaObj = delta as {
          reasoning_content?: unknown;
          content?: unknown;
          tool_calls?: unknown[];
        };
        if (typeof deltaObj.reasoning_content === 'string' && deltaObj.reasoning_content) {
          reasoning += deltaObj.reasoning_content;
          this.onReasoningDelta?.(deltaObj.reasoning_content);
        }
        if (typeof deltaObj.content === 'string' && deltaObj.content) {
          content += deltaObj.content;
          this.onDelta?.(deltaObj.content);
        }
        for (const call of deltaObj.tool_calls ?? []) {
          const callObj = call as {
            index?: unknown;
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          };
          const index = Number(callObj.index ?? 0);
          const existing = toolCalls.get(index) ?? {
            id: '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (callObj.id) existing.id = String(callObj.id);
          if (callObj.function?.name) existing.function.name += String(callObj.function.name);
          if (callObj.function?.arguments)
            existing.function.arguments += String(callObj.function.arguments);
          toolCalls.set(index, existing);
        }
      }
    }

    const orderedCalls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call);
    return { content, reasoning, toolCalls: orderedCalls };
  }
}