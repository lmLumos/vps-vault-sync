import { DEFAULT_SYNC_OPTIONS, SyncOptions } from './types';

/**
 * Converts a gitignore-style glob pattern to a RegExp
 */
function globToRegex(pattern: string): RegExp {
  let p = pattern.trim();
  if (!p || p.startsWith('#')) {
    return /^$/; // Empty or comment
  }

  // Normalize slashes
  p = p.replace(/\\/g, '/');

  const matchFromRoot = p.startsWith('/');
  if (matchFromRoot) {
    p = p.substring(1);
  }

  const isDirectoryOnly = p.endsWith('/');
  if (isDirectoryOnly) {
    p = p.substring(0, p.length - 1);
  }

  // Normalize leading **/ to match both root and nested paths
  if (p.startsWith('**/')) {
    p = p.substring(3);
  }

  // Escape regex special chars except * and ?
  let regexStr = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Handle globstars and wildcards
  regexStr = regexStr
    .replace(/\*\*/g, '___GLOBSTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___GLOBSTAR___/g, '.*')
    .replace(/\?/g, '[^/]');

  if (matchFromRoot) {
    regexStr = `^${regexStr}`;
  } else {
    regexStr = `(^|.*/)${regexStr}`;
  }

  if (isDirectoryOnly) {
    regexStr = `${regexStr}(/.*)?$`;
  } else {
    regexStr = `${regexStr}(/.*)?$`;
  }

  return new RegExp(regexStr);
}

export class IgnoreFilter {
  private patterns: RegExp[] = [];
  private options: SyncOptions;

  constructor(options: Partial<SyncOptions> = {}, customIgnoreContent = '') {
    this.options = { ...DEFAULT_SYNC_OPTIONS, ...options };
    this.reloadPatterns(customIgnoreContent);
  }

  public reloadPatterns(customIgnoreContent = ''): void {
    const rawPatterns = [...this.options.ignoredPatterns];

    if (customIgnoreContent) {
      const lines = customIgnoreContent.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          rawPatterns.push(trimmed);
        }
      }
    }

    // Handle workspace toggle
    if (!this.options.syncWorkspace) {
      rawPatterns.push('.obsidian/workspace.json');
      rawPatterns.push('.obsidian/workspace-mobile.json');
      rawPatterns.push('.obsidian/workspaces.json');
    }

    // Handle full .obsidian ignore if disabled
    if (!this.options.syncObsidianConfig) {
      rawPatterns.push('.obsidian/**');
    }

    this.patterns = rawPatterns
      .map(p => globToRegex(p))
      .filter(r => r.source !== '^$');
  }

  public isIgnored(rawPath: string): boolean {
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');

    // Ignore empty or root paths (e.g., empty string or leading slashes only)
    if (!normalized) return true;

    for (const regex of this.patterns) {
      if (regex.test(normalized)) {
        return true;
      }
    }

    return false;
  }
}
