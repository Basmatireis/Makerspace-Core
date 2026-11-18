import type { TemplateDocument } from './model';

/**
 * The unsaved document of each export, kept in memory only (never in browser storage: a template can hold personal data
 * such as names in texts). When the editor crashes, the error screen can offer these edits back.
 */
const unsaved = new Map<string, TemplateDocument>();

export const rememberUnsaved = (kind: string, doc: TemplateDocument): void => void unsaved.set(kind, doc);
export const forgetUnsaved = (kind: string): void => void unsaved.delete(kind);
export const recoverUnsaved = (kind: string): TemplateDocument | undefined => unsaved.get(kind);
