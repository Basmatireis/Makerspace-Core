import { FileUploaderButton, InlineNotification } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uploadMachineRunArtifact } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRunArtifactUploadResult } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { machineLogbookKeys } from '../queries';
import './recording.scss';

/** Header values are ASCII-only, so the name travels percent-encoded as UTF-8. */
const encodedName = (name: string) => encodeURIComponent(name.replace(/\p{Cc}/gu, '') || 'upload');

const uploadErrorText: Record<string, string> = {
  run_artifact_connector_retrieved: 'The connector already retrieved this run’s print file; it cannot be replaced.',
  run_not_recorded: 'Only runs recorded by a printer connector have a print file.',
  run_replaced: 'A replaced run cannot be changed.',
};

function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.data?.code;
    if (code && uploadErrorText[code]) return uploadErrorText[code];
    if (error.status === 413) return 'The file is larger than 512 MiB.';
    if (error.status === 422) return 'The file is not a valid 3MF print file.';
  }
  return 'The file could not be uploaded. Try again.';
}

/** Uploads the 3MF of a recorded run (machine_jobs.edit; the backend decides). */
export function RunFileUpload({
  runId,
  label = 'Upload print file (3MF)',
  onUploaded,
}: {
  runId: string;
  label?: string;
  onUploaded: (result: MachineRunArtifactUploadResult, fileName: string) => void;
}) {
  const client = useQueryClient();
  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadMachineRunArtifact(runId, file, { headers: { 'X-File-Name': encodedName(file.name) } }),
    onSuccess: async (result, file) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: machineLogbookKeys.recording(runId) }),
        client.invalidateQueries({ queryKey: machineLogbookKeys.run(runId) }),
        client.invalidateQueries({ queryKey: machineLogbookKeys.artifact(result.artifact.id) }),
      ]);
      onUploaded(result, file.name);
    },
  });
  return (
    <div className="recording-upload">
      <FileUploaderButton
        labelText={upload.isPending ? 'Uploading…' : label}
        buttonKind="tertiary"
        size="sm"
        accept={['.3mf']}
        multiple={false}
        disabled={upload.isPending}
        disableLabelChanges
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) upload.mutate(file);
        }}
      />
      {upload.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Print file not uploaded"
          subtitle={uploadErrorMessage(upload.error)}
        />
      )}
    </div>
  );
}

/** Warning after an upload whose names differ from the run's print name; the file is already stored. */
export function UploadMismatchNotice({
  result,
  fileName,
  runId,
  onKeep,
  onUploaded,
}: {
  result: MachineRunArtifactUploadResult;
  fileName: string;
  runId: string;
  onKeep: () => void;
  onUploaded: (result: MachineRunArtifactUploadResult, fileName: string) => void;
}) {
  return (
    <div className="mj-stack">
      <InlineNotification
        kind="warning"
        lowContrast
        hideCloseButton
        title="The file may not belong to this print"
        subtitle={`“${fileName}”${result.projectName ? ` (project “${result.projectName}”)` : ''} does not match the print name “${result.printName ?? ''}” the printer reported. The file is stored; keep it or replace it with another.`}
      />
      <div className="recording-actions">
        <button type="button" className="cds--btn cds--btn--sm cds--btn--ghost" onClick={onKeep}>
          Keep this file
        </button>
        <RunFileUpload runId={runId} label="Replace with another file" onUploaded={onUploaded} />
      </div>
    </div>
  );
}
