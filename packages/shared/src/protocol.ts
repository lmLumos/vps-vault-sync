import { FileMetadata, SyncEvent, VaultManifest } from './types';

export const PROTOCOL_VERSION = '1.0.0';

export type MessageType =
  | 'AUTH_REQUEST'
  | 'AUTH_RESPONSE'
  | 'MANIFEST_REQUEST'
  | 'MANIFEST_RESPONSE'
  | 'MANIFEST_DIFF_REQUEST'
  | 'MANIFEST_DIFF_RESPONSE'
  | 'SYNC_EVENT'
  | 'SYNC_EVENT_ACK'
  | 'FILE_GET_REQUEST'
  | 'FILE_GET_RESPONSE'
  | 'FILE_PUT_REQUEST'
  | 'FILE_PUT_RESPONSE'
  | 'PING'
  | 'PONG'
  | 'ERROR_NOTIFICATION';

export interface BaseMessage {
  id: string;              // Correlation ID for request-response
  type: MessageType;
  timestamp: number;
}

export interface AuthRequestMessage extends BaseMessage {
  type: 'AUTH_REQUEST';
  token: string;
  clientId: string;
  clientName: string;
  protocolVersion: string;
  deviceType: 'desktop' | 'mobile';
}

export interface AuthResponseMessage extends BaseMessage {
  type: 'AUTH_RESPONSE';
  success: boolean;
  serverVersion: string;
  serverTime: number;
  vaultName: string;
  error?: string;
}

export interface ManifestRequestMessage extends BaseMessage {
  type: 'MANIFEST_REQUEST';
}

export interface ManifestResponseMessage extends BaseMessage {
  type: 'MANIFEST_RESPONSE';
  manifest: VaultManifest;
  serverTime: number;
}

export interface ManifestDiffRequestMessage extends BaseMessage {
  type: 'MANIFEST_DIFF_REQUEST';
  clientManifest: VaultManifest;
}

export interface ManifestDiff {
  toUpload: string[];      // Files client has that server lacks or has older version
  toDownload: string[];    // Files server has that client lacks or has older version
  conflicts: string[];     // Files modified simultaneously on both sides
  toDeleteOnServer: string[];
  toDeleteOnClient: string[];
}

export interface ManifestDiffResponseMessage extends BaseMessage {
  type: 'MANIFEST_DIFF_RESPONSE';
  diff: ManifestDiff;
  serverManifest: VaultManifest;
}

export interface SyncEventMessage extends BaseMessage {
  type: 'SYNC_EVENT';
  event: SyncEvent;
}

export interface SyncEventAckMessage extends BaseMessage {
  type: 'SYNC_EVENT_ACK';
  eventId: string;
  path: string;
  success: boolean;
  newHash?: string;
  newMtime?: number;
  conflictDetected?: boolean;
  conflictPath?: string;
  error?: string;
}

export interface FileGetRequestMessage extends BaseMessage {
  type: 'FILE_GET_REQUEST';
  path: string;
}

export interface FileGetResponseMessage extends BaseMessage {
  type: 'FILE_GET_RESPONSE';
  path: string;
  exists: boolean;
  metadata?: FileMetadata;
  content?: string;        // Base64 encoded or UTF-8 text string
  isBinary?: boolean;
  error?: string;
}

export interface FilePutRequestMessage extends BaseMessage {
  type: 'FILE_PUT_REQUEST';
  path: string;
  content: string;         // Base64 or UTF-8
  isBinary: boolean;
  mtime: number;
  hash: string;
  baseHash?: string;       // For 3-way merge validation
}

export interface FilePutResponseMessage extends BaseMessage {
  type: 'FILE_PUT_RESPONSE';
  path: string;
  success: boolean;
  metadata?: FileMetadata;
  conflictOccurred?: boolean;
  conflictPath?: string;
  error?: string;
}

export interface PingMessage extends BaseMessage {
  type: 'PING';
}

export interface PongMessage extends BaseMessage {
  type: 'PONG';
}

export interface ErrorNotificationMessage extends BaseMessage {
  type: 'ERROR_NOTIFICATION';
  code: string;
  message: string;
  details?: unknown;
}

export type WebSocketMessage =
  | AuthRequestMessage
  | AuthResponseMessage
  | ManifestRequestMessage
  | ManifestResponseMessage
  | ManifestDiffRequestMessage
  | ManifestDiffResponseMessage
  | SyncEventMessage
  | SyncEventAckMessage
  | FileGetRequestMessage
  | FileGetResponseMessage
  | FilePutRequestMessage
  | FilePutResponseMessage
  | PingMessage
  | PongMessage
  | ErrorNotificationMessage;
