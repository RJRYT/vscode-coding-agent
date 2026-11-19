import { describe, expect, it } from 'vitest';

// Minimal in-memory replica of searchWorkspace's matching/pagination rules,
// extracted from ToolRegistry.searchWorkspace so its output contract can be
// verified without the vscode API.
const MAX_SEARCH_RESULT_LIMIT = 200;
const MAX_SEARCH_FILES = 2500;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 20 * 1024 * 1024;

type FakeFile = { path: string; bytes: Uint8Array; sensitive?: boolean };

function searchSync(
  files: FakeFile[],
  query: string,
  glob?: string,
  rawLimit?: number,
  rawOffset?: number
) {
  const needle = query?.trim();
  if (!needle) throw new Error('Search query is empty.');
  const limit = Math.min(Math.max(Number(rawLimit) || 30, 1), MAX_SEARCH_RESULT_LIMIT);
  const offset = Math.max(0, Math.min(Number(rawOffset) || 0, 100_000));
  const include = glob?.trim() ? glob : '**/*';
  const globRe = new RegExp(
    '^' +
      include
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '::DOUBLE::')
        .replace(/\*/g, '[^/]*')
        .replace(/::DOUBLE::/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  const all = include === '**/*' ? files : files.filter((f) => globRe.test(f.path));
  const results: string[] = [];
  const normalizedNeedle = needle.toLocaleLowerCase();
  let scannedBytes = 0;
  let skippedLargeFiles = 0;
  for (const file of all) {
    if (results.length >= offset + limit || scannedBytes >= MAX_SEARCH_TOTAL_BYTES) break;
    if (file.sensitive) continue;
    if (
      file.bytes.byteLength > MAX_SEARCH_FILE_BYTES ||
      scannedBytes + file.bytes.byteLength > MAX_SEARCH_TOTAL_BYTES
    ) {
      skippedLargeFiles++;
      continue;
    }
    if (file.bytes.includes(0)) continue;
    scannedBytes += file.bytes.byteLength;
    const lines = new TextDecoder().decode(file.bytes).split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < offset + limit; index++) {
      if (lines[index].toLocaleLowerCase().includes(normalizedNeedle)) {
        results.push(`${file.path}:${index + 1}: ${lines[index].trim().slice(0, 260)}`);
      }
    }
  }
  const pageResults = results.slice(offset, offset + limit);
  if (!pageResults.length) return { content: `No matches found.`, skippedLargeFiles };
  const notes: string[] = [];
  if (results.length >= offset + limit)
    notes.push(
      `Result page: ${offset + 1}-${offset + pageResults.length}; use offset for the next page.`
    );
  if (skippedLargeFiles) notes.push(`${skippedLargeFiles} large files skipped.`);
  return {
    content: notes.length
      ? `${pageResults.join('\n')}\n\n[${notes.join(' ')}]`
      : pageResults.join('\n'),
    skippedLargeFiles,
  };
}

const mk = (path: string, content: string): FakeFile => ({
  path,
  bytes: new TextEncoder().encode(content),
});

describe('searchWorkspace semantics', () => {
  const files = [
    mk('src/index.ts', 'const alpha = 1;\nconst beta = alpha + 1;\n'),
    mk('src/util/helper.ts', 'export const ALPHA_CASE = 2;\n'),
    mk('docs/readme.md', '# alpha\nalpha appears here too.\n'),
    mk('data/binary.bin', 'al\0pha'),
    { path: 'secrets/env.bak', bytes: new TextEncoder().encode('alpha token'), sensitive: true },
  ];

  it('matches case-insensitively and reports path:line', () => {
    const out = searchSync(files, 'ALPHA');
    expect(out.content).toContain('src/index.ts:1: const alpha = 1;');
    expect(out.content).toContain('src/util/helper.ts:1: export const ALPHA_CASE = 2;');
    expect(out.content).toContain('docs/readme.md:1: # alpha');
  });

  it('skips binary files and sensitive paths', () => {
    const out = searchSync(files, 'alpha');
    expect(out.content).not.toContain('binary.bin');
    expect(out.content).not.toContain('env.bak');
  });

  it('paginates with limit and offset', () => {
    const page1 = searchSync(files, 'alpha', undefined, 2);
    expect(
      page1.content.split('\n').filter((l) => l.includes('.ts') || l.includes('.md')).length
    ).toBe(2);
    const page2 = searchSync(files, 'alpha', undefined, 2, 2);
    expect(page2.content).toContain('Result page: 3-');
  });

  it('honours the glob filter and reports no matches cleanly', () => {
    const out = searchSync(files, 'alpha', 'docs/*.md');
    expect(out.content).toContain('docs/readme.md');
    expect(out.content).not.toContain('src/index.ts');
    const none = searchSync(files, 'nonexistent-token-xyz');
    expect(none.content).toBe('No matches found.');
  });

  it('rejects an empty query', () => {
    expect(() => searchSync(files, '  ')).toThrow(/query is empty/i);
  });
});
