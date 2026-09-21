import type { Artifact, FilePart, Part } from './types.js';

/** Type guard for the A2A FilePart reference form (a non-empty file.uri). */
export function isFilePart(part: Part): part is FilePart {
  return part.kind === 'file' && typeof (part as FilePart).file?.uri === 'string' && (part as FilePart).file.uri.length > 0;
}

/** Every file URI referenced by an artifact's parts, in declaration order. */
export function artifactFileUris(artifact: Artifact): string[] {
  return artifact.parts.filter(isFilePart).map(part => part.file.uri);
}
