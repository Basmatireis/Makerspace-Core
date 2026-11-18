import {
  Button,
  InlineLoading,
  InlineNotification,
  Modal,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tag,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { PdfTemplateExport, PdfTemplateState, PdfTemplateVersionMeta } from '../../../api/generated/models';
import { formatDateTime } from '../../../app/dateTime';
import { pdfTemplateVersionsQuery } from '../queries';

const STATE_TAG: Record<PdfTemplateState, { label: string; type: 'blue' | 'green' | 'gray' }> = {
  draft: { label: 'Draft', type: 'blue' },
  published: { label: 'Published', type: 'green' },
  archived: { label: 'Archived', type: 'gray' },
};

function whoAndWhen(version: PdfTemplateVersionMeta): string {
  if (version.state === 'published' && version.publishedAt)
    return `Published ${formatDateTime(version.publishedAt)}${version.publishedBy ? ` by ${version.publishedBy}` : ''}`;
  return `Edited ${formatDateTime(version.updatedAt)}${version.createdBy ? ` by ${version.createdBy}` : ''}`;
}

export interface VersionsModalProps {
  kind: PdfTemplateExport;
  templateName: string;
  onClose: () => void;
  /** Copies a version into the draft; the editor then shows it. */
  onRestore: (version: PdfTemplateVersionMeta) => void;
  /** Loads the built-in default into the editor as an undoable edit. */
  onReset: () => void;
  /** Deletes the saved draft and shows the published version again; null while there is no draft. */
  onDiscardDraft: (() => void) | null;
  busy: boolean;
  error: string | null;
}

type Confirm = { kind: 'restore'; version: PdfTemplateVersionMeta } | { kind: 'reset' } | { kind: 'discard' };

const CONFIRM_TEXT = {
  restore: (v: PdfTemplateVersionMeta | undefined) => ({
    heading: `Restore version ${v?.version ?? ''} as the draft?`,
    body: 'The version becomes a new draft and replaces the current draft and any unsaved edits in the editor. The published version stays as it is.',
    primary: 'Restore as draft',
  }),
  reset: () => ({
    heading: 'Reset to the built-in default?',
    body: 'The editor shows the built-in layout instead of your edits. Nothing is saved until you save the draft, and Undo brings your edits back until then.',
    primary: 'Reset to default',
  }),
  discard: () => ({
    heading: 'Discard the saved draft?',
    body: 'The draft is deleted and the published version is shown again. Edits that are only in the draft are lost, and this cannot be undone.',
    primary: 'Discard draft',
  }),
};

/**
 * The versions of a template: restore one as the new draft, return to the built-in default, or drop the draft. Each of
 * these replaces or deletes work, so each asks first.
 */
export function VersionsModal({
  kind,
  templateName,
  onClose,
  onRestore,
  onReset,
  onDiscardDraft,
  busy,
  error,
}: VersionsModalProps) {
  const versions = useQuery(pdfTemplateVersionsQuery(kind, true));
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  if (confirm) {
    const text = confirm.kind === 'restore' ? CONFIRM_TEXT.restore(confirm.version) : CONFIRM_TEXT[confirm.kind]();
    const run = () => {
      if (confirm.kind === 'restore') onRestore(confirm.version);
      else if (confirm.kind === 'reset') onReset();
      else onDiscardDraft?.();
    };
    return (
      <Modal
        open
        size="sm"
        danger={confirm.kind === 'discard'}
        modalLabel={templateName}
        modalHeading={text.heading}
        primaryButtonText={text.primary}
        secondaryButtonText="Cancel"
        primaryButtonDisabled={busy}
        onRequestClose={() => setConfirm(null)}
        onRequestSubmit={run}
      >
        <p>{text.body}</p>
        {error && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="That did not work." subtitle={error} />
        )}
        {busy && <InlineLoading description="Working…" />}
      </Modal>
    );
  }
  return (
    <Modal open passiveModal modalHeading="Versions" modalLabel={templateName} onRequestClose={onClose} size="md">
      {versions.isPending && <InlineLoading description="Loading versions…" />}
      {versions.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="The versions could not be loaded."
          subtitle={versions.error.message}
        />
      )}
      {error && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="That did not work." subtitle={error} />
      )}
      {versions.data && (
        <StructuredListWrapper isCondensed aria-label="Versions of this template">
          <StructuredListBody>
            {versions.data.length === 0 && (
              <StructuredListRow>
                <StructuredListCell>No saved versions yet: the built-in default is in use.</StructuredListCell>
              </StructuredListRow>
            )}
            {versions.data.map((version) => {
              const tag = STATE_TAG[version.state];
              return (
                <StructuredListRow key={version.id}>
                  <StructuredListCell>
                    <strong>Version {version.version}</strong>{' '}
                    <Tag size="sm" type={tag.type}>
                      {tag.label}
                    </Tag>
                    <div className="pdft-versions__who">{whoAndWhen(version)}</div>
                  </StructuredListCell>
                  <StructuredListCell className="pdft-versions__action">
                    <Button
                      kind="ghost"
                      size="sm"
                      disabled={busy || version.state !== 'archived'}
                      onClick={() => setConfirm({ kind: 'restore', version })}
                    >
                      {version.state === 'published'
                        ? 'In use'
                        : version.state === 'draft'
                          ? 'Current draft'
                          : 'Restore as draft'}
                    </Button>
                  </StructuredListCell>
                </StructuredListRow>
              );
            })}
          </StructuredListBody>
        </StructuredListWrapper>
      )}
      <div className="pdft-versions__footer">
        <Button kind="tertiary" size="sm" disabled={busy} onClick={() => setConfirm({ kind: 'reset' })}>
          Reset to the built-in default
        </Button>
        {onDiscardDraft && (
          <Button kind="danger--ghost" size="sm" disabled={busy} onClick={() => setConfirm({ kind: 'discard' })}>
            Discard the saved draft
          </Button>
        )}
      </div>
    </Modal>
  );
}
