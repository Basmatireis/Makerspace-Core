import { InlineNotification, StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import type { MachineJob, Print } from '../../../api/generated/models';
import { formatDateTime, formatDuration } from './format';
import { jobUsageText, printDurationSeconds, printUsageText } from './status';

/** Manual entry versus printer data, shown before a manual run is replaced. */
export function ReplaceComparison({ job, print }: { job: MachineJob; print: Print }) {
  const duration = printDurationSeconds(print);
  const rows = [
    { field: 'Start', manual: formatDateTime(job.startsAt), printer: formatDateTime(print.startedAt) },
    { field: 'Runtime', manual: formatDuration(job.durationSeconds), printer: duration === null ? '—' : formatDuration(duration) },
    { field: 'Material', manual: jobUsageText(job), printer: printUsageText(print) },
  ];
  return (
    <>
      <StructuredListWrapper isCondensed aria-label={`Comparison of ${job.displayId} and ${print.displayId}`}>
        <StructuredListHead>
          <StructuredListRow head>
            <StructuredListCell head>Field</StructuredListCell>
            <StructuredListCell head>Manual entry</StructuredListCell>
            <StructuredListCell head>From printer</StructuredListCell>
          </StructuredListRow>
        </StructuredListHead>
        <StructuredListBody>
          {rows.map((row) => (
            <StructuredListRow key={row.field}>
              <StructuredListCell noWrap>{row.field}</StructuredListCell>
              <StructuredListCell>{row.manual}</StructuredListCell>
              <StructuredListCell>{row.printer}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      <InlineNotification kind="warning" lowContrast hideCloseButton title="Manual run replaced" subtitle="The manual run is replaced with the printer's data. Price is recalculated." />
    </>
  );
}
