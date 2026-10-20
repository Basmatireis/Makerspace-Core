import { Add } from '@carbon/icons-react';
import {
  Button,
  ComposedModal,
  FileUploaderDropContainer,
  ModalBody,
  ModalFooter,
  ModalHeader,
  OverflowMenu,
  OverflowMenuItem,
  Select,
  SelectItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { downloadEventFile, getUploadEventFileUrl, removeEventFile } from '../../api/generated/events/events';
import type { EventFile } from '../../api/generated/models';
import { apiFetch } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { InlineLoadingState } from '../../app/PageState';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { useLatestCallback } from '../../app/useLatestCallback';
import { FileEditDialog } from './EventEditDialogs';
import { MutationError } from './EventPanelError';
import { formatInstant } from './format';
import { eventFilesQueryOptions, eventKeys } from './queries';

export function EventFilesPanel({
  eventId,
  canManage,
  archived,
}: {
  eventId: string;
  canManage: boolean;
  archived: boolean;
}) {
  const actionButtons = useRef(new Map<string, HTMLElement>());
  const deleteLauncher = useRef<HTMLElement | null>(null);
  const client = useQueryClient();
  const query = useQuery(eventFilesQueryOptions(eventId));
  const [file, setFile] = useState<File | null>(null);
  const [visibility, setVisibility] = useState<'internal' | 'public'>('internal');
  const [showUpload, setShowUpload] = useState(false);
  const [editingFile, setEditingFile] = useState<EventFile | null>(null);
  const [removeTarget, setRemoveTarget] = useState<EventFile | null>(null);
  const [editingFileDirty, setEditingFileDirty] = useState(false);
  const isDirty = Boolean(editingFileDirty || (showUpload && (file || visibility !== 'internal')));
  const guard = useUnsavedChanges({
    isDirty,
    onDiscard: () => {
      setFile(null);
      setVisibility('internal');
      setShowUpload(false);
      setEditingFile(null);
      setEditingFileDirty(false);
    },
  });
  const refresh = async () => client.invalidateQueries({ queryKey: eventKeys.files(eventId) });
  const upload = useMutation({
    mutationFn: () =>
      apiFetch(getUploadEventFileUrl(eventId), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': file?.name ?? '',
          'X-File-Content-Type': file?.type || 'application/octet-stream',
          'X-Event-File-Visibility': visibility,
        },
        body: file,
      }),
    onSuccess: async () => {
      setFile(null);
      setShowUpload(false);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      removeEventFile(eventId, id, { expectedVersion: version }),
    onSuccess: async () => {
      setRemoveTarget(null);
      await refresh();
    },
  });
  const closeUpload = useLatestCallback(() => {
    if (!upload.isPending) guard.requestDiscard(() => setShowUpload(false));
    return false;
  });
  const download = async (id: string, filename: string) => {
    const blob = await downloadEventFile(eventId, id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Stack gap={7}>
      <section className="event-panel-heading">
        <div>
          <h2>Files</h2>
          <p>Documents and images shared with the event team or public visitors.</p>
        </div>
        {canManage && !archived && (
          <Button renderIcon={Add} size="sm" onClick={() => setShowUpload(true)}>
            Upload file
          </Button>
        )}
      </section>
      <MutationError error={upload.error ?? remove.error} />
      {query.isPending && <InlineLoadingState label="Loading files" />}
      {query.data?.items.length ? (
        <TableContainer className="event-files-table">
          <Table size="lg">
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Type</TableHeader>
                <TableHeader>Visibility</TableHeader>
                <TableHeader>Size</TableHeader>
                <TableHeader>Uploaded</TableHeader>
                <TableHeader>Actions</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {query.data.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <strong>{item.originalFilename}</strong>
                    {item.isBanner && (
                      <Tag size="sm" type="purple">
                        banner
                      </Tag>
                    )}
                    {item.description && <p>{item.description}</p>}
                  </TableCell>
                  <TableCell>{item.contentType}</TableCell>
                  <TableCell>
                    <Tag size="sm" type={item.visibility === 'public' ? 'green' : 'gray'}>
                      {item.visibility}
                    </Tag>
                  </TableCell>
                  <TableCell>
                    {item.sizeBytes >= 1024 * 1024
                      ? `${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MiB`
                      : `${Math.ceil(item.sizeBytes / 1024)} KiB`}
                  </TableCell>
                  <TableCell>{formatInstant(item.createdAt)}</TableCell>
                  <TableCell>
                    <OverflowMenu
                      ref={(node) => {
                        if (node) actionButtons.current.set(item.id, node);
                        else actionButtons.current.delete(item.id);
                      }}
                      iconDescription={`Actions for ${item.originalFilename}`}
                      size="sm"
                      flipped
                    >
                      <OverflowMenuItem
                        itemText="Download"
                        onClick={() => void download(item.id, item.originalFilename)}
                      />
                      {canManage && !archived && (
                        <OverflowMenuItem itemText="Edit details" onClick={() => setEditingFile(item)} />
                      )}{' '}
                      {canManage && !archived && (
                        <OverflowMenuItem
                          isDelete
                          itemText="Remove"
                          onClick={() => {
                            deleteLauncher.current = actionButtons.current.get(item.id) ?? null;
                            setRemoveTarget(item);
                          }}
                        />
                      )}
                    </OverflowMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        !query.isPending && (
          <div className="empty-state">
            <h3>No files attached</h3>
            <p>Upload internal working files or public visitor resources.</p>
          </div>
        )
      )}
      {showUpload && (
        <ComposedModal open={!guard.dialogOpen} onClose={closeUpload} size="sm" preventCloseOnClickOutside>
          <ModalHeader title="Upload file" />
          <ModalBody>
            <Stack gap={5}>
              <FileUploaderDropContainer
                id="event-file-upload"
                accept={[
                  'application/pdf',
                  'image/jpeg',
                  'image/png',
                  'image/gif',
                  'image/webp',
                  'text/plain',
                  'text/csv',
                  'application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.ms-powerpoint',
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                ]}
                maxFileSize={25 << 20}
                multiple={false}
                labelText="Choose or drop an allowed file up to 25 MiB"
                onAddFiles={(_, data) => setFile(data.addedFiles[0] ?? null)}
              />
              <Select
                id="event-file-visibility"
                labelText="Visibility"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as 'internal' | 'public')}
              >
                <SelectItem value="internal" text="Internal" />
                <SelectItem value="public" text="Public" />
              </Select>
            </Stack>
          </ModalBody>
          <ModalFooter>
            <Button kind="secondary" disabled={upload.isPending} onClick={closeUpload}>
              Cancel
            </Button>
            <Button disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
              {upload.isPending ? 'Uploading…' : 'Upload file'}
            </Button>
          </ModalFooter>
        </ComposedModal>
      )}
      {editingFile && (
        <FileEditDialog
          eventId={eventId}
          file={editingFile}
          open={!guard.dialogOpen}
          onDirtyChange={setEditingFileDirty}
          onClose={() =>
            guard.requestDiscard(() => {
              setEditingFile(null);
              setEditingFileDirty(false);
            })
          }
          onSaved={async () => {
            setEditingFile(null);
            setEditingFileDirty(false);
            return refresh();
          }}
        />
      )}
      <DestructiveActionDialog
        launcherButtonRef={deleteLauncher}
        open={Boolean(removeTarget) && !guard.dialogOpen}
        title={`Remove ${removeTarget?.originalFilename ?? 'file'}?`}
        confirmLabel="Remove file"
        pending={remove.isPending}
        error={String(remove.error ?? '') || undefined}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) remove.mutate({ id: removeTarget.id, version: removeTarget.version });
        }}
      >
        <p>The file is detached from the event and will no longer be available to the team or public visitors.</p>
      </DestructiveActionDialog>
      <UnsavedChangesDialog guard={guard} />
    </Stack>
  );
}
