import { describe, expect, it } from 'vitest';
import { renderPromptTemplate } from '../src/promptTemplate';

describe('system prompt template', () => {
  it('replaces only supported dynamic values', () => {
    expect(
      renderPromptTemplate('Workspace {{WORKSPACE_NAME}} · {{PERSONA}}', {
        WORKSPACE_NAME: 'my-app',
        PERSONA: 'senior engineer',
      })
    ).toBe('Workspace my-app · senior engineer');
  });

  it('does not recursively interpret placeholder-like user preferences', () => {
    expect(
      renderPromptTemplate('Persona: {{PERSONA}}; tone: {{TONE}}', {
        PERSONA: '{{TONE}}',
        TONE: 'concise',
      })
    ).toBe('Persona: {{TONE}}; tone: concise');
  });

  it('leaves unknown placeholders visible for diagnosis', () => {
    expect(renderPromptTemplate('Value {{UNKNOWN}}', {})).toBe('Value {{UNKNOWN}}');
  });
});
