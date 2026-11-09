import { describe, expect, it } from 'vitest';
import { applyExactTextPatches, createPatchPreview } from '../src/patchEngine';

describe('applyExactTextPatches', () => {
  it('changes only exact targeted sections and preserves surrounding content', () => {
    const source = 'before\nconst greeting = "hello";\nafter\nconst count = 1;\n';
    const result = applyExactTextPatches(source, [
      { oldText: 'const greeting = "hello";', newText: 'const greeting = "hi";' },
      { oldText: 'const count = 1;', newText: 'const count = 2;' },
    ]);
    expect(result.text).toBe('before\nconst greeting = "hi";\nafter\nconst count = 2;\n');
  });


  it('matches anchors when only CRLF/LF line endings differ', () => {
    const source = 'function greet() {\r\n  return "hello";\r\n}\r\n';
    const result = applyExactTextPatches(source, [
      { oldText: 'function greet() {\n  return "hello";\n}', newText: 'function greet() {\n  return "hi";\n}' },
    ]);
    expect(result.text).toBe('function greet() {\r\n  return "hi";\r\n}\r\n');
  });

  it('does not match anchors whose source tokens have changed', () => {
    expect(() => applyExactTextPatches('  const value = 1;', [
      { oldText: 'const value = 2;', newText: 'const value = 3;' },
    ])).toThrow(/could not be matched in the current file snapshot/);
  });

  it('matches a unique source anchor when only internal formatting whitespace differs', () => {
    const source = 'app.use(express.urlencoded({extended:true,limit:"10mb"}));';
    const result = applyExactTextPatches(source, [
      { oldText: 'app.use(express.urlencoded({ extended: true, limit: "10mb" }));', newText: 'app.use(express.urlencoded({ extended: true, limit: "20mb" }));' },
    ]);
    expect(result.text).toBe('app.use(express.urlencoded({ extended: true, limit: "20mb" }));');
  });

  it('does not token-normalize an ambiguous anchor', () => {
    expect(() => applyExactTextPatches('a(b);\na (b);', [
      { oldText: 'a ( b );', newText: 'c();' },
    ])).toThrow(/ambiguous/);
  });

  it('rejects anchors that do not match', () => {
    expect(() =>
      applyExactTextPatches('const a = 1;', [
        { oldText: 'const b = 2;', newText: 'const b = 3;' },
      ])
    ).toThrow(/could not be matched/);
  });

  it('rejects ambiguous anchors', () => {
    expect(() =>
      applyExactTextPatches('x();\nx();', [{ oldText: 'x();', newText: 'y();' }])
    ).toThrow(/ambiguous/);
  });

  it('rejects overlapping edits', () => {
    expect(() =>
      applyExactTextPatches('abcdef', [
        { oldText: 'abc', newText: 'ABC' },
        { oldText: 'cde', newText: 'CDE' },
      ])
    ).toThrow(/overlap/);
  });

  it('allows an exact full-file snapshot replacement for deliberate rewrites', () => {
    const result = applyExactTextPatches('const a = 1;', [
      { oldText: 'const a = 1;', newText: 'const a = 2;' },
    ]);
    expect(result.text).toBe('const a = 2;');
  });

  it('supports patch anchors larger than 100 KB', () => {
    const anchor = 'x'.repeat(150_000) + 'UNIQUE';
    const source = `before\n${anchor}\nafter`;
    expect(applyExactTextPatches(source, [{ oldText: anchor, newText: 'updated' }]).text).toBe('before\nupdated\nafter');
  });

  it('allows a large focused replacement when it is not the entire file', () => {
    const anchor = 'x'.repeat(1800) + 'UNIQUE-ANCHOR';
    const source = 'header\n' + anchor + '\nfooter';
    const result = applyExactTextPatches(source, [{ oldText: anchor, newText: 'updated focused section' }]);
    expect(result.text).toContain('header\nupdated focused section\nfooter');
  });


  it('applies replacement text larger than the obsolete 5 million character cap', () => {
    const replacement = 'z'.repeat(5_000_001);
    const result = applyExactTextPatches('before UNIQUE_ANCHOR after', [
      { oldText: 'UNIQUE_ANCHOR', newText: replacement },
    ]);
    expect(result.text).toBe(`before ${replacement} after`);
  });

  it('shows only the targeted hunks in the approval preview', () => {
    const result = applyExactTextPatches('top\nconst a = 1;\nbottom', [
      { oldText: 'const a = 1;', newText: 'const a = 2;' },
    ]);
    const preview = createPatchPreview(result.patches);
    expect(preview.oldPreview).toContain('const a = 1;');
    expect(preview.oldPreview).not.toContain('top');
    expect(preview.newPreview).toContain('const a = 2;');
  });
});

it('recovers anchors that were accidentally JSON-escaped by the model', () => {
  const result = applyExactTextPatches('const folder = "src";', [
    { oldText: '\\"src\\"', newText: '"lib"' },
  ]);
  expect(result.text).toBe('const folder = "lib";');
});

it('recovers indentation and trailing-whitespace-only differences on a unique line block', () => {
  const source = 'function run() {\n\t  const value = 1;   \n\t  return value;\n}';
  const result = applyExactTextPatches(source, [
    { oldText: 'function run() {\n  const value = 1;\n  return value;\n}', newText: 'function run() {\n  const value = 2;\n  return value;\n}' },
  ]);
  expect(result.text).toBe('function run() {\n\t  const value = 2;\n\t  return value;\n}');
});

it('rejects whitespace-normalized anchors when multiple blocks match', () => {
  expect(() => applyExactTextPatches('  x();\n\tx();', [
    { oldText: 'x();', newText: 'y();' },
  ])).toThrow(/ambiguous/);
});


it('recovers multiply escaped JSON property anchors and escaped line breaks', () => {
  const source = '{\n  "include": [\n    "src/**/*.ts"\n  ]\n}';
  const result = applyExactTextPatches(source, [
    { oldText: '\\\\\"include\\\\\": [\\n    \\\\\"src/**/*.ts\\\\\"', newText: '"include": [\n    "src/**/*.tsx"' },
  ]);
  expect(result.text).toContain('"src/**/*.tsx"');
});
