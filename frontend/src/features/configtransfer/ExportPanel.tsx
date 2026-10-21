import { useState } from 'react';
import { Button, Checkbox, CheckboxGroup, InlineNotification, Stack, Tile } from '@carbon/react';
import { Download } from '@carbon/icons-react';
import { useMutation } from '@tanstack/react-query';
import type { ConfigurationSection } from '../../api/generated/models';
import { exportConfiguration } from '../../api/generated/configuration-transfer/configuration-transfer';
import { exportFilename, saveBlob } from './helpers';
import type { SectionDefinition } from './sections';

export function ExportPanel({ sections }: { sections: SectionDefinition[] }) {
  const [selected, setSelected] = useState<ConfigurationSection[]>(() => sections.map((section) => section.key));
  const download = useMutation({
    mutationFn: () => exportConfiguration({ sections: selected }),
    onSuccess: (blob) => saveBlob(blob, exportFilename()),
  });
  const toggle = (key: ConfigurationSection, checked: boolean) =>
    setSelected((current) =>
      checked
        ? sections.map((s) => s.key).filter((k) => k === key || current.includes(k))
        : current.filter((k) => k !== key),
    );

  return (
    <Tile className="configuration-transfer__panel">
      <Stack gap={6}>
        <div>
          <h2 className="configuration-transfer__heading">Export</h2>
          <p className="configuration-transfer__lead">
            Download the chosen sections as a JSON file. Passwords, tokens and other secrets are never included.
          </p>
        </div>
        <CheckboxGroup legendText="Sections to export">
          {sections.map((section) => (
            <Checkbox
              key={section.key}
              id={`export-${section.key}`}
              labelText={section.label}
              helperText={section.description}
              checked={selected.includes(section.key)}
              onChange={(_, { checked }) => toggle(section.key, checked)}
            />
          ))}
        </CheckboxGroup>
        <div className="configuration-transfer__actions">
          <Button kind="ghost" size="md" onClick={() => setSelected(sections.map((section) => section.key))}>
            Select all
          </Button>
          <Button kind="ghost" size="md" onClick={() => setSelected([])}>
            Clear
          </Button>
          <Button
            renderIcon={Download}
            disabled={selected.length === 0 || download.isPending}
            onClick={() => download.mutate()}
          >
            {download.isPending ? 'Preparing file…' : 'Download file'}
          </Button>
        </div>
        {download.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Export failed"
            subtitle={download.error.message}
          />
        )}
      </Stack>
    </Tile>
  );
}
