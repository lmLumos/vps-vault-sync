import { diff_match_patch } from 'diff-match-patch';
import { MergeResult } from './types';

const dmp = new diff_match_patch();

/**
 * Performs a 3-way text merge between base, local, and remote revisions.
 */
export function threeWayMerge(
  baseText: string,
  localText: string,
  remoteText: string,
  filePath: string
): MergeResult {
  // Case 1: Trivial identity
  if (localText === remoteText) {
    return { hasConflict: false, mergedText: localText };
  }

  // Case 2: Local unchanged since base -> Remote wins
  if (localText === baseText) {
    return { hasConflict: false, mergedText: remoteText };
  }

  // Case 3: Remote unchanged since base -> Local wins
  if (remoteText === baseText) {
    return { hasConflict: false, mergedText: localText };
  }

  // Case 4: No common base known (or base empty) -> Check for simple line concatenation or collision
  if (!baseText) {
    // Both sides added content from scratch
    const conflictFileName = generateConflictPath(filePath);
    return {
      hasConflict: true,
      mergedText: localText,
      conflictDetails: {
        baseText: '',
        localText,
        remoteText,
        conflictingPath: conflictFileName
      }
    };
  }

  // Case 5: 3-Way patch application
  try {
    // Compute patches from base -> remote
    const patches = dmp.patch_make(baseText, remoteText);
    const [patchedText, results] = dmp.patch_apply(patches, localText);

    const allSucceeded = results.every(Boolean);

    if (allSucceeded) {
      return {
        hasConflict: false,
        mergedText: patchedText
      };
    }
  } catch {
    // Fallthrough to conflict generation
  }

  // If patch had collisions, generate conflict details
  const conflictFileName = generateConflictPath(filePath);
  return {
    hasConflict: true,
    mergedText: localText,
    conflictDetails: {
      baseText,
      localText,
      remoteText,
      conflictingPath: conflictFileName
    }
  };
}

/**
 * Generates a conflict filename such as: Note.sync-conflict-20260816-145800.md
 */
export function generateConflictPath(originalPath: string, timestamp = Date.now()): string {
  const d = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  const lastDot = originalPath.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0) {
    return `${originalPath}.sync-conflict-${dateStr}`;
  }

  const base = originalPath.substring(0, lastDot);
  const ext = originalPath.substring(lastDot);
  return `${base}.sync-conflict-${dateStr}${ext}`;
}

/**
 * Formats git-style conflict markers if inline conflict is preferred
 */
export function formatConflictMarkers(localText: string, remoteText: string, deviceName = 'Remote Device'): string {
  return `<<<<<<< Local Changes\n${localText}\n=======\n${remoteText}\n>>>>>>> Changes from ${deviceName}\n`;
}
