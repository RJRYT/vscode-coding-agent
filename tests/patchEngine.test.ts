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
