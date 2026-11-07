/** Shared payload limits used by tool-schema validation and execution.
 * These are deliberately generous; JSON-schema maxLength is omitted from model
 * tool definitions so provider-side schema validation cannot reject edits first.
 */
export const MAX_PATCH_TEXT_CHARS = 50_000_000;
export const MAX_PATCH_TOTAL_CHARS = 50_000_000;
export const MAX_CREATE_CONTENT_CHARS = 50_000_000;
export const MAX_COMMAND_LENGTH = 20_000;
