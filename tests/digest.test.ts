import { describe, expect, it } from 'vitest';
import { digestManifest, sha256Hex } from '../src/realm/digest.js';

describe('digestManifest', () => {
  it('is order-independent over entries (backup baseline must not depend on scan order)', () => {
    const a = [
      { itemId: 'notes/a.md', content: 'first' },
      { itemId: 'notes/b.md', content: 'second' },
    ];
    const b = [
      { itemId: 'notes/b.md', content: 'second' },
      { itemId: 'notes/a.md', content: 'first' },
    ];
    expect(digestManifest(a)).toBe(digestManifest(b));
  });

  it('changes when an item path or content changes', () => {
    const base = [{ itemId: 'a.md', content: 'v1' }, { itemId: 'b.md', content: 'v2' }];
    expect(digestManifest([{ itemId: 'a.md', content: 'CHANGED' }, { itemId: 'b.md', content: 'v2' }])).not.toBe(digestManifest(base));
    expect(digestManifest([{ itemId: 'renamed.md', content: 'v1' }, { itemId: 'b.md', content: 'v2' }])).not.toBe(digestManifest(base));
  });

  it('hashes Buffer and string contents identically', () => {
    const text = digestManifest([{ itemId: 'a.md', content: 'hello' }]);
    const buffer = digestManifest([{ itemId: 'a.md', content: Buffer.from('hello', 'utf8') }]);
    expect(buffer).toBe(text);
  });

  it('sha256Hex is stable for a known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
