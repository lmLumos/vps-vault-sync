import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IgnoreFilter } from './ignore';

describe('IgnoreFilter', () => {
  it('should ignore default system and git directories', () => {
    const filter = new IgnoreFilter();

    assert.strictEqual(filter.isIgnored('.git/config'), true);
    assert.strictEqual(filter.isIgnored('.git/HEAD'), true);
    assert.strictEqual(filter.isIgnored('.sync-archive/history/note.bak'), true);
    assert.strictEqual(filter.isIgnored('.DS_Store'), true);
    assert.strictEqual(filter.isIgnored('Subfolder/Thumbs.db'), true);
    assert.strictEqual(filter.isIgnored('note.tmp'), true);
  });

  it('should allow regular markdown and attachment files', () => {
    const filter = new IgnoreFilter();

    assert.strictEqual(filter.isIgnored('Daily/2026-08-16.md'), false);
    assert.strictEqual(filter.isIgnored('Images/screenshot.png'), false);
    assert.strictEqual(filter.isIgnored('Projects/Code/main.py'), false);
  });

  it('should ignore workspace.json when syncWorkspace is false', () => {
    const filter = new IgnoreFilter({ syncWorkspace: false });

    assert.strictEqual(filter.isIgnored('.obsidian/workspace.json'), true);
    assert.strictEqual(filter.isIgnored('.obsidian/workspace-mobile.json'), true);
    assert.strictEqual(filter.isIgnored('.obsidian/plugins/dataview/main.js'), false);
    assert.strictEqual(filter.isIgnored('.obsidian/themes/Minimal/theme.css'), false);
  });

  it('should allow workspace.json when syncWorkspace is true', () => {
    const filter = new IgnoreFilter({ syncWorkspace: true });

    assert.strictEqual(filter.isIgnored('.obsidian/workspace.json'), false);
  });

  it('should respect custom .syncignore rules', () => {
    const customRules = `
# Secrets
Private/**
secret-*.md
*.log
`;
    const filter = new IgnoreFilter({}, customRules);

    assert.strictEqual(filter.isIgnored('Private/Diary.md'), true);
    assert.strictEqual(filter.isIgnored('secret-passwords.md'), true);
    assert.strictEqual(filter.isIgnored('debug.log'), true);
    assert.strictEqual(filter.isIgnored('Public/Note.md'), false);
  });

  it('should ignore empty and root-only paths', () => {
    const filter = new IgnoreFilter();

    assert.strictEqual(filter.isIgnored(''), true);
    assert.strictEqual(filter.isIgnored('/'), true);
    assert.strictEqual(filter.isIgnored('///'), true);
    assert.strictEqual(filter.isIgnored('\\'), true);
    assert.strictEqual(filter.isIgnored('\\\\\\'), true);
  });

  it('should ignore temporary files generated during atomic writes (Issue 19)', () => {
    const filter = new IgnoreFilter();

    assert.strictEqual(filter.isIgnored('note.md.tmp'), true);
    assert.strictEqual(filter.isIgnored('note.md.tmp.1786902157401'), true);
    assert.strictEqual(filter.isIgnored('Folder/Sub/note.md.1786902157401.tmp'), true);
    assert.strictEqual(filter.isIgnored('Folder/Sub/note.md.tmp.99999'), true);
    assert.strictEqual(filter.isIgnored('Folder/note.md'), false);
  });

  it('should always ignore plugin data.json and sync archives even with empty ignoredPatterns (Issue 6)', () => {
    const filter = new IgnoreFilter({ ignoredPatterns: [], syncObsidianConfig: true });

    assert.strictEqual(filter.isIgnored('.obsidian/plugins/vps-vault-sync/data.json'), true);
    assert.strictEqual(filter.isIgnored('.git/config'), true);
    assert.strictEqual(filter.isIgnored('.sync-archive/history/file.md'), true);
    assert.strictEqual(filter.isIgnored('.obsidian/plugins/other-plugin/data.json'), false);
  });
});
