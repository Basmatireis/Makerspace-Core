import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import type {
  MachineRun,
  MachineRunReportedUsageItem,
  MachineRunReportedUsageSegment,
} from '../../../api/generated/models';
import { RefLink } from '../../../app/RefLink';
import { openReportedLines, reportedLineName, reportedLineQuantity } from '../jobs/runLines';
import { unitText } from '../processConfig';
import { formatQuantity, formatTime } from '../shared/format';
import { FromMachineTag, hasSegments } from '../shared/status';

/** "from layer 41", else the time the feed moved to the segment's spool. */
const startText = (segment: MachineRunReportedUsageSegment) =>
  segment.startLayer != null ? `from layer ${segment.startLayer}` : `from ${formatTime(segment.startedAt)}`;

/** Parts of reported lines that no spool fed, or whose quantity is unknown: nothing booked them yet. */
const openSegments = (run: MachineRun) =>
  (run.reportedUsageItems ?? [])
    .filter(hasSegments)
    .flatMap((item) =>
      item.segments
        .filter((segment) => !segment.spoolId || segment.estimatedQuantityGrams == null)
        .map((segment) => ({ run, item, segment })),
    );

/**
 * The material of one or more runs in one table: booked usage and, below it, report lines the machine could not
 * assign to a material, each with "Map" when `onMap` is given, and the parts of a line fed by several spools that no
 * spool accounts for, with "Map" when `onMapSegment` is given. `showRun` adds the run column for a job.
 */
export function MaterialUsageTable({
  runs,
  showRun,
  description,
  onMap,
  onMapSegment,
}: {
  runs: MachineRun[];
  showRun: boolean;
  description: string;
  onMap?: (run: MachineRun, item: MachineRunReportedUsageItem) => void;
  onMapSegment?: (run: MachineRun, item: MachineRunReportedUsageItem, segment: MachineRunReportedUsageSegment) => void;
}) {
  const booked = runs.flatMap((run) => run.usages.map((usage) => ({ run, usage })));
  const open = runs.flatMap((run) => openReportedLines(run).map((item) => ({ run, item })));
  const segments = runs.flatMap(openSegments);
  const actions = (Boolean(onMap) && open.length > 0) || (Boolean(onMapSegment) && segments.length > 0);
  const columns = 3 + (showRun ? 1 : 0) + (actions ? 1 : 0);
  const runCell = (run: MachineRun) =>
    showRun && (
      <TableCell>
        <div className="mj-cell-stack">
          <RefLink kind="run" reference={run.displayId} id={run.id} />
          {run.usagesFromMachine && (
            <span>
              <FromMachineTag />
            </span>
          )}
        </div>
      </TableCell>
    );
  return (
    <TableContainer title="Material usage" description={description}>
      <Table size="md" aria-label="Material usage">
        <TableHead>
          <TableRow>
            <TableHeader>Material</TableHeader>
            {showRun && <TableHeader>Run</TableHeader>}
            <TableHeader>Source</TableHeader>
            <TableHeader>Quantity</TableHeader>
            {actions && (
              <TableHeader>
                <span className="cds--visually-hidden">Actions</span>
              </TableHeader>
            )}
          </TableRow>
        </TableHead>
        <TableBody>
          {booked.length === 0 && open.length === 0 && segments.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns}>No material recorded.</TableCell>
            </TableRow>
          )}
          {booked.map(({ run, usage }) => (
            <TableRow key={`${run.id}-${usage.id}`}>
              <TableCell>
                <div className="mj-cell-stack">
                  <span>{usage.ownership === 'external' ? usage.label || usage.materialName : usage.materialName}</span>
                  <span className="mj-secondary">{usage.materialTypeName}</span>
                </div>
              </TableCell>
              {runCell(run)}
              <TableCell>
                {usage.ownership === 'external'
                  ? 'Recipient’s own (not charged)'
                  : usage.spoolDisplayId
                    ? `Spool ${usage.spoolDisplayId}${usage.spoolId ? '' : ' (deleted)'}`
                    : 'Makerspace stock'}
              </TableCell>
              <TableCell>
                {formatQuantity(usage.quantity)} {unitText(usage.unit)}{' '}
                {usage.quantityBasis === 'estimated' && (
                  <Tag type="outline" size="sm">
                    Estimated
                  </Tag>
                )}
              </TableCell>
              {actions && <TableCell />}
            </TableRow>
          ))}
          {open.map(({ run, item }) => {
            const grams = reportedLineQuantity(item);
            return (
              <TableRow key={`${run.id}-open-${item.reportRevision}-${item.lineNumber}`}>
                <TableCell>
                  <div className="mj-cell-stack">
                    <span>{reportedLineName(item)}</span>
                    <span className="mj-secondary">Reported by the machine</span>
                  </div>
                </TableCell>
                {runCell(run)}
                <TableCell>
                  <Tag type="warm-gray" size="sm">
                    Not mapped
                  </Tag>
                </TableCell>
                <TableCell>{grams == null ? '—' : `${formatQuantity(grams)} g`}</TableCell>
                {actions && (
                  <TableCell>
                    {onMap && (
                      <Button
                        kind="ghost"
                        size="sm"
                        aria-label={`Map ${reportedLineName(item)}${showRun ? ` of ${run.displayId}` : ''}`}
                        onClick={() => onMap(run, item)}
                      >
                        Map
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
          {segments.map(({ run, item, segment }) => {
            const name = `${reportedLineName(item)} part ${segment.index + 1}`;
            return (
              <TableRow key={`${run.id}-segment-${item.reportRevision}-${item.lineNumber}-${segment.index}`}>
                <TableCell>
                  <div className="mj-cell-stack">
                    <span>{name}</span>
                    <span className="mj-secondary">
                      Reported by the machine · {startText(segment)}
                      {segment.split === 'progress' ? ' · estimated by progress' : ''}
                    </span>
                  </div>
                </TableCell>
                {runCell(run)}
                <TableCell>
                  <Tag type="red" size="sm">
                    {segment.spoolId ? 'Quantity unknown' : 'No spool'}
                  </Tag>
                </TableCell>
                <TableCell>
                  {segment.estimatedQuantityGrams == null ? '—' : `${formatQuantity(segment.estimatedQuantityGrams)} g`}
                </TableCell>
                {actions && (
                  <TableCell>
                    {onMapSegment && (
                      <Button
                        kind="ghost"
                        size="sm"
                        aria-label={`Map ${name}${showRun ? ` of ${run.displayId}` : ''}`}
                        onClick={() => onMapSegment(run, item, segment)}
                      >
                        Map
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
