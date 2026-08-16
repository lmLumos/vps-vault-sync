import { describe, it } from 'node:test';
import assert from 'node:assert';
import { threeWayMerge, generateConflictPath, formatConflictMarkers } from './merge';

describe('3-Way Merge Algorithm', () => {
  it('should cleanly merge non-conflicting edits to different lines', () => {
    const base = 'Line 1\nLine 2\nLine 3\n';
    const local = 'Line 1 edited locally\nLine 2\nLine 3\n';
    const remote = 'Line 1\nLine 2\nLine 3 edited remotely\n';

    const result = threeWayMerge(base, local, remote, 'Notes/Test.md');

    assert.strictEqual(result.hasConflict, false);
    assert.strictEqual(
      result.mergedText,
      'Line 1 edited locally\nLine 2\nLine 3 edited remotely\n'
    );
  });

  it('should detect direct collision on the same line and flag conflict', () => {
    const base = 'Header\nOriginal Content\nFooter\n';
    const local = 'Header\nLocal Edits Here\nFooter\n';
    const remote = 'Header\nRemote Edits Here\nFooter\n';

    const result = threeWayMerge(base, local, remote, 'Notes/Collision.md');

    assert.strictEqual(result.hasConflict, true);
    assert.ok(result.conflictDetails);
    assert.ok(result.conflictDetails.conflictingPath.includes('.sync-conflict-'));
    assert.strictEqual(result.conflictDetails.localText, local);
    assert.strictEqual(result.conflictDetails.remoteText, remote);
  });

  it('should handle remote updates when local has no changes since base', () => {
    const base = 'Original text';
    const local = 'Original text';
    const remote = 'New remote text';

    const result = threeWayMerge(base, local, remote, 'Notes/Simple.md');
    assert.strictEqual(result.hasConflict, false);
    assert.strictEqual(result.mergedText, 'New remote text');
  });

  it('should generate valid conflict file paths preserving extensions', () => {
    const conflictPath = generateConflictPath('Folder/MyNote.md', 1700000000000);
    assert.ok(conflictPath.startsWith('Folder/MyNote.sync-conflict-'));
    assert.ok(conflictPath.endsWith('.md'));
  });

  it('should format conflict markers properly', () => {
    const markers = formatConflictMarkers('A', 'B', 'Laptop');
    assert.ok(markers.includes('<<<<<<< Local Changes'));
    assert.ok(markers.includes('>>>>>>> Changes from Laptop'));
  });
});
