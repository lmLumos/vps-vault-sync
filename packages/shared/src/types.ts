export interface FileMetadata {
  path: string;            // Normalized relative path with forward slashes (e.g. "Folder/Note.md" or ".obsidian/plugins/...")
  hash: string;            // SHA-256 or fast hex hash of file content
  mtime: number;           // Last modified timestamp in milliseconds
  size: number;            // File size in bytes
  isBinary: boolean;       // Whether the file is treated as binary vs UTF-8 text
  isDeleted?: boolean;     // For tombstone tracking if needed
}

export type VaultManifest = Record<string, FileMetadata>;

export type SyncChangeType = 'create' | 'modify' | 'delete' | 'rename';

export interface BaseSyncEvent {
  id: string;              // Unique event ID (UUID or nanoid)
  clientId: string;        // ID of originating client (or 'server' if originated on VPS)
  timestamp: number;       // Unix epoch ms
}

export interface FileCreateOrModifyEvent extends BaseSyncEvent {
  type: 'create' | 'modify';
  path: string;
  hash: string;
  mtime: number;
  size: number;
  isBinary: boolean;
  baseHash?: string;       // The hash of the ancestor document the edit was based on (for 3-way merge)
  content?: string;        // Inline base64 for binary or UTF-8 string for small text (< 1MB)
  chunked?: boolean;       // If true, content must be fetched / pushed via streaming HTTP endpoint
}

export interface FileDeleteEvent extends BaseSyncEvent {
  type: 'delete';
  path: string;
  previousHash?: string;
}

export interface FileRenameEvent extends BaseSyncEvent {
  type: 'rename';
  oldPath: string;
  newPath: string;
  hash: string;
  mtime: number;
}

export type SyncEvent = FileCreateOrModifyEvent | FileDeleteEvent | FileRenameEvent;

export interface MergeResult {
  hasConflict: boolean;
  mergedText: string;
  conflictDetails?: {
    baseText: string;
    localText: string;
    remoteText: string;
    conflictingPath: string;
  };
}

export interface SyncOptions {
  syncObsidianConfig: boolean;
  syncWorkspace: boolean;
  conflictStrategy: 'three-way' | 'last-write-wins';
  ignoredPatterns: string[];
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  syncObsidianConfig: true,
  syncWorkspace: false,
  conflictStrategy: 'three-way',
  ignoredPatterns: [
    '.git/**',
    '.sync-archive/**',
    '.sync-trash/**',
    '.trash/**',
    '**/.DS_Store',
    '**/Thumbs.db',
    '**/desktop.ini',
    '**/*.tmp',
    '**/*.swp',
    '**/*~',
    '.obsidian/cache/**',
    '.obsidian/workspace.json.tmp',
    '.obsidian/plugins/vps-vault-sync/data.json'
  ]
};
