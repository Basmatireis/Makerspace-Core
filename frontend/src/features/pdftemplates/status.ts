import type { PdfTemplateVersion } from '../../api/generated/models';

export interface StatusTag {
  label: string;
  tone: 'blue' | 'green' | 'gray';
}

/** The state shown next to the title: unsaved edits, a saved draft, the published version or the built-in default. */
export function statusOf(input: {
  dirty: boolean;
  draft: Pick<PdfTemplateVersion, 'version'> | null;
  published: Pick<PdfTemplateVersion, 'version'> | null;
}): StatusTag {
  const { dirty, draft, published } = input;
  if (dirty) return { label: `Draft v${nextVersion(draft, published)} · unsaved`, tone: 'blue' };
  if (draft) return { label: `Draft v${draft.version}`, tone: 'blue' };
  if (published) return { label: `Published v${published.version}`, tone: 'green' };
  return { label: 'Built-in default', tone: 'gray' };
}

/** The version number the draft has, or will get when it is first saved. */
export function nextVersion(
  draft: Pick<PdfTemplateVersion, 'version'> | null,
  published: Pick<PdfTemplateVersion, 'version'> | null,
): number {
  return draft?.version ?? (published?.version ?? 0) + 1;
}
