import { useState } from 'react';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  FileUploader,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  Stack,
  Tile,
} from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import type {
  ConfigurationImportMode,
  ConfigurationImportReport,
  ConfigurationSection,
} from '../../api/generated/models';
import {
  applyConfigurationImport,
  previewConfigurationImport,
} from '../../api/generated/configuration-transfer/configuration-transfer';
import { ApiError } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { formatDateTime } from '../../app/dateTime';
import { totalCounts } from './helpers';
import { ImportReport } from './ImportReport';
import { readConfigurationFile, sectionLabel, type ConfigurationFileSummary, type SectionDefinition } from './sections';

const maxFileBytes = 64 << 20;

function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const data = error.data as { code?: string; details?: { reason?: unknown; section?: unknown } } | undefined;
    if (data?.code === 'configuration_changed') {
      return 'The configuration changed since the preview. Preview the import again before applying it.';
    }
    const reason = typeof data?.details?.reason === 'string' ? data.details.reason : undefined;
    const section = typeof data?.details?.section === 'string' ? data.details.section : undefined;
    if (reason) {
      return section ? `${sectionLabel(section as ConfigurationSection)}: ${reason}` : reason;
    }
  }
  return error instanceof Error ? error.message : 'The request failed. Try again.';
}

export function ImportPanel({ sections }: { sections: SectionDefinition[] }) {
  const [file, setFile] = useState<File>();
  const [summary, setSummary] = useState<ConfigurationFileSummary>();
  const [fileError, setFileError] = useState<string>();
  const [selected, setSelected] = useState<ConfigurationSection[]>([]);
  const [mode, setMode] = useState<ConfigurationImportMode>('insert');
  const [preview, setPreview] = useState<ConfigurationImportReport>();
  const [result, setResult] = useState<ConfigurationImportReport>();
  const [confirming, setConfirming] = useState(false);

  const available = sections.filter((section) => summary?.sections.includes(section.key));
  const unavailable = (summary?.sections ?? []).filter((key) => !sections.some((section) => section.key === key));
  const ordered = sections.map((section) => section.key).filter((key) => selected.includes(key));

  const previewMutation = useMutation({
    mutationFn: () => previewConfigurationImport(file as Blob, { mode, sections: ordered }),
    onSuccess: (report) => {
      setPreview(report);
      setResult(undefined);
    },
  });
  const applyMutation = useMutation({
    mutationFn: (report: ConfigurationImportReport) =>
      applyConfigurationImport(file as Blob, { mode, sections: ordered, fingerprint: report.fingerprint }),
    onSuccess: (report) => {
      setConfirming(false);
      setPreview(undefined);
      setResult(report);
    },
  });

  // Every change of the inputs invalidates an earlier preview.
  const resetPreview = () => {
    setPreview(undefined);
    setResult(undefined);
    previewMutation.reset();
    applyMutation.reset();
  };

  const chooseFile = async (added: File | undefined) => {
    resetPreview();
    setSummary(undefined);
    setSelected([]);
    setFileError(undefined);
    setFile(added);
    if (!added) return;
    if (added.size > maxFileBytes) {
      setFileError('The file exceeds 64 MiB.');
      return;
    }
    try {
      const read = await readConfigurationFile(added);
      setSummary(read);
      setSelected(sections.filter((section) => read.sections.includes(section.key)).map((section) => section.key));
    } catch (error) {
      setFileError(error instanceof Error ? error.message : 'The file could not be read.');
    }
  };

  const toggle = (key: ConfigurationSection, checked: boolean) => {
    resetPreview();
    setSelected((current) => (checked ? [...current, key] : current.filter((item) => item !== key)));
  };

  const counts = preview ? totalCounts(preview) : undefined;
  const apply = () => {
    if (!preview) return;
    if (mode === 'overwrite') setConfirming(true);
    else applyMutation.mutate(preview);
  };

  return (
    <Tile className="configuration-transfer__panel">
      <Stack gap={6}>
        <div>
          <h2 className="configuration-transfer__heading">Import</h2>
          <p className="configuration-transfer__lead">
            Upload a configuration file, choose what to import and review the preview. Nothing changes until you apply
            it.
          </p>
        </div>
        <Stack gap={3}>
          <FileUploader
            labelTitle="Configuration file"
            labelDescription="JSON file exported by Makerspace Core, at most 64 MiB."
            buttonLabel="Choose file"
            buttonKind="tertiary"
            accept={['application/json', '.json']}
            filenameStatus="edit"
            iconDescription="Remove file"
            multiple={false}
            onChange={(event) => void chooseFile((event.target as HTMLInputElement).files?.[0])}
            onDelete={() => void chooseFile(undefined)}
          />
          {fileError && (
            <InlineNotification kind="error" lowContrast hideCloseButton title="File not usable" subtitle={fileError} />
          )}
          {summary && (
            <p className="configuration-transfer__meta">
              Exported {summary.exportedAt ? formatDateTime(summary.exportedAt) : 'at an unknown time'}
              {summary.appVersion ? ` by release ${summary.appVersion}` : ''}.
            </p>
          )}
        </Stack>

        {summary && (
          <>
            {available.length === 0 ? (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="Nothing to import"
                subtitle="The file contains no section you are allowed to import."
              />
            ) : (
              <CheckboxGroup legendText="Sections to import">
                {available.map((section) => (
                  <Checkbox
                    key={section.key}
                    id={`import-${section.key}`}
                    labelText={section.label}
                    helperText={section.description}
                    checked={selected.includes(section.key)}
                    onChange={(_, { checked }) => toggle(section.key, checked)}
                  />
                ))}
              </CheckboxGroup>
            )}
            {unavailable.length > 0 && (
              <p className="configuration-transfer__meta">
                Not available to your account: {unavailable.map(sectionLabel).join(', ')}.
              </p>
            )}
            <RadioButtonGroup
              legendText="Import mode"
              name="configuration-import-mode"
              orientation="vertical"
              valueSelected={mode}
              onChange={(value) => {
                resetPreview();
                setMode(value as ConfigurationImportMode);
              }}
            >
              <RadioButton
                id="mode-insert"
                value="insert"
                labelText="Insert: only add entries that do not exist yet; existing ones stay as they are"
              />
              <RadioButton
                id="mode-overwrite"
                value="overwrite"
                labelText="Overwrite: make the chosen sections equal the file. Entries missing from the file are deleted, or deactivated or kept when they are still in use"
              />
            </RadioButtonGroup>
            <div className="configuration-transfer__actions">
              <Button
                kind={preview ? 'secondary' : 'primary'}
                disabled={ordered.length === 0 || previewMutation.isPending}
                onClick={() => previewMutation.mutate()}
              >
                {previewMutation.isPending ? 'Preparing preview…' : 'Preview import'}
              </Button>
            </div>
          </>
        )}

        {previewMutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Preview failed"
            subtitle={failureMessage(previewMutation.error)}
          />
        )}

        {preview && counts && (
          <Stack gap={5}>
            <h3 className="configuration-transfer__subheading">Preview</h3>
            {preview.warnings.map((warning) => (
              <InlineNotification
                key={warning}
                kind="warning"
                lowContrast
                hideCloseButton
                title="Note"
                subtitle={warning}
              />
            ))}
            {counts.conflict > 0 && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="The import has conflicts"
                subtitle="Resolve the conflicts below, for example by importing the referenced sections too or leaving a section out, and preview again."
              />
            )}
            <ImportReport report={preview} />
            {applyMutation.isError && !confirming && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Import failed"
                subtitle={failureMessage(applyMutation.error)}
              />
            )}
            <div className="configuration-transfer__actions">
              <Button
                kind={mode === 'overwrite' ? 'danger' : 'primary'}
                disabled={counts.conflict > 0 || applyMutation.isPending}
                onClick={apply}
              >
                {applyMutation.isPending ? 'Importing…' : 'Apply import'}
              </Button>
            </div>
          </Stack>
        )}

        {result && (
          <Stack gap={5}>
            <InlineNotification
              kind="success"
              lowContrast
              hideCloseButton
              title="Import applied"
              subtitle={`Imported ${result.sections.map((section) => sectionLabel(section.section)).join(', ')}.`}
            />
            <ImportReport report={result} />
          </Stack>
        )}
      </Stack>
      <DestructiveActionDialog
        open={confirming && Boolean(preview)}
        title="Overwrite configuration?"
        confirmLabel="Overwrite"
        pending={applyMutation.isPending}
        error={applyMutation.isError ? failureMessage(applyMutation.error) : undefined}
        onClose={() => setConfirming(false)}
        onConfirm={() => preview && applyMutation.mutate(preview)}
      >
        <p>
          The chosen sections will match the file.{' '}
          {counts && counts.delete + counts.deactivate > 0
            ? `Deleted: ${counts.delete}. Deactivated: ${counts.deactivate}.`
            : 'No entries will be deleted or deactivated.'}{' '}
          This cannot be undone.
        </p>
      </DestructiveActionDialog>
    </Tile>
  );
}
