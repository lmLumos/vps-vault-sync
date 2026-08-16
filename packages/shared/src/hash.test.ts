import { describe, it } from 'node:test';
import assert from 'node:assert';
import { hashString, hashBuffer, isBinaryFile } from './hash';

describe('Hash & File Utilities', () => {
  it('should generate consistent SHA-256 hex hashes for strings', () => {
    const hash1 = hashString('Hello Obsidian VPS Sync');
    const hash2 = hashString('Hello Obsidian VPS Sync');
    const hash3 = hashString('Different content');

    assert.strictEqual(hash1, hash2);
    assert.notStrictEqual(hash1, hash3);
    assert.strictEqual(hash1.length, 64);
  });

  it('should generate matching hashes between buffer and string', () => {
    const text = '# My Test Vault Note\nSome body text.';
    const strHash = hashString(text);
    const bufHash = hashBuffer(Buffer.from(text, 'utf8'));

    assert.strictEqual(strHash, bufHash);
  });

  it('should correctly classify binary vs text file extensions', () => {
    assert.strictEqual(isBinaryFile('image.png'), true);
    assert.strictEqual(isBinaryFile('document.pdf'), true);
    assert.strictEqual(isBinaryFile('audio.mp3'), true);
    assert.strictEqual(isBinaryFile('archive.zip'), true);

    assert.strictEqual(isBinaryFile('note.md'), false);
    assert.strictEqual(isBinaryFile('data.json'), false);
    assert.strictEqual(isBinaryFile('script.js'), false);
    assert.strictEqual(isBinaryFile('styles.css'), false);
    assert.strictEqual(isBinaryFile('file.txt'), false);
  });
});
