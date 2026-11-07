export type PromptVariables = Record<string, string>;

/** Single-pass placeholder expansion; user preference values are never reprocessed as template syntax. */
export function renderPromptTemplate(template: string, variables: PromptVariables): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : placeholder
  );
}
