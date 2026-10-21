import type {
  ConfigurationImportAction,
  ConfigurationImportCounts,
  ConfigurationImportReport,
} from '../../api/generated/models';

type TagType = 'green' | 'blue' | 'red' | 'magenta' | 'gray' | 'cool-gray' | 'purple';

export const actionLabels: Record<ConfigurationImportAction, { label: string; type: TagType }> = {
  create: { label: 'Create', type: 'green' },
  update: { label: 'Update', type: 'blue' },
  delete: { label: 'Delete', type: 'red' },
  deactivate: { label: 'Deactivate', type: 'magenta' },
  keep: { label: 'Keep', type: 'purple' },
  skip: { label: 'Skip', type: 'cool-gray' },
  conflict: { label: 'Conflict', type: 'red' },
};

export const actionOrder: ConfigurationImportAction[] = [
  'conflict',
  'delete',
  'deactivate',
  'update',
  'create',
  'keep',
  'skip',
];

export function totalCounts(report: ConfigurationImportReport): ConfigurationImportCounts {
  const total: ConfigurationImportCounts = {
    create: 0,
    update: 0,
    delete: 0,
    deactivate: 0,
    keep: 0,
    skip: 0,
    conflict: 0,
  };
  for (const section of report.sections) {
    for (const action of actionOrder) total[action] += section.counts[action];
  }
  return total;
}

// saveBlob hands a downloaded file to the browser.
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function exportFilename(now = new Date()): string {
  return `makerspace-configuration-${now.toISOString().slice(0, 10)}.json`;
}
