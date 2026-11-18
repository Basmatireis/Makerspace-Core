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

/** The versions of a template: restore one as the new draft, return to the built-in default, or drop the draft. */
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
                      onClick={() => onRestore(version)}
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
        <Button kind="tertiary" size="sm" disabled={busy} onClick={onReset}>
          Reset to the built-in default
        </Button>
        {onDiscardDraft && (
          <Button kind="danger--ghost" size="sm" disabled={busy} onClick={onDiscardDraft}>
            Discard the saved draft
          </Button>
        )}
      </div>
    </Modal>
  );
}
