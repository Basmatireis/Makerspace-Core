import {
  InlineNotification,
  StructuredListBody,
  StructuredListCell,
  StructuredListHead,
  StructuredListRow,
  StructuredListWrapper,
} from '@carbon/react';
import type { MachineJob, MachineRun } from '../../../api/generated/models';
import { formatDateTime, formatDuration } from './format';
import { manualRuns, reportedUsageText, usagesText } from './status';

/** Manual runs of a job versus the recorded run, shown before the recorded run is attached. */
export function ReplaceComparison({ job, run, replace }: { job: MachineJob; run: MachineRun; replace: boolean }) {
  const manual = manualRuns(job);
  if (manual.length === 0) return null;
  const start = Math.min(...manual.map((item) => new Date(item.startedAt).getTime()));
  const rows = [
    { field: 'Start', manual: formatDateTime(new Date(start).toISOString()), recorded: formatDateTime(run.startedAt) },
    {
      field: 'Runtime',
      manual: formatDuration(manual.reduce((sum, item) => sum + item.durationSeconds, 0)),
      recorded: `${formatDuration(run.durationSeconds)}${run.state === 'running' ? ' so far' : ''}`,
    },
    { field: 'Material', manual: usagesText(manual.flatMap((item) => item.usages)), recorded: reportedUsageText(run) },
  ];
  return (
    <>
      <StructuredListWrapper
        isCondensed
        aria-label={`Comparison of the manual runs of ${job.displayId} and ${run.displayId}`}
      >
        <StructuredListHead>
          <StructuredListRow head>
            <StructuredListCell head>Field</StructuredListCell>
            <StructuredListCell head>
              {manual.length === 1 ? 'Manual run' : `Manual runs (${manual.length})`}
            </StructuredListCell>
            <StructuredListCell head>Recorded run</StructuredListCell>
          </StructuredListRow>
        </StructuredListHead>
        <StructuredListBody>
          {rows.map((row) => (
            <StructuredListRow key={row.field}>
              <StructuredListCell noWrap>{row.field}</StructuredListCell>
              <StructuredListCell>{row.manual}</StructuredListCell>
              <StructuredListCell>{row.recorded}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      {replace ? (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Manual runs replaced"
          subtitle="The manual runs stay on the job as replaced; their material goes back to stock and the machine's data counts instead. Price is recalculated."
        />
      ) : (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Added next to the manual runs"
          subtitle="Runtime and material of all runs add up. Price is recalculated."
        />
      )}
    </>
  );
}
