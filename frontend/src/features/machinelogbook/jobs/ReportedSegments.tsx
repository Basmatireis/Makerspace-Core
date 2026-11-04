import { Button, Tag } from '@carbon/react';
import type {
  MachineRun,
  MachineRunReportedUsageItem,
  MachineRunReportedUsageSegment,
} from '../../../api/generated/models';
import { RefLink } from '../../../app/RefLink';
import { formatQuantity, formatTime } from '../shared/format';
import { hasSegments } from '../shared/status';
import { reportedLineName } from './runLines';

/** "from layer 41", else the time the feed moved to the segment's spool. */
const startText = (segment: MachineRunReportedUsageSegment) =>
  segment.startLayer != null ? `from layer ${segment.startLayer}` : `from ${formatTime(segment.startedAt)}`;

/**
 * The spools that fed reported lines during one print, one nested list per line with segments. A segment without
 * spool is flagged; `onMap` (staff who may edit the run) offers to book it through the usage replacement.
 */
export function ReportedSegments({
  run,
  onMap,
}: {
  run: Pick<MachineRun, 'reportedUsageItems' | 'usages'>;
  onMap?: (item: MachineRunReportedUsageItem, segment: MachineRunReportedUsageSegment) => void;
}) {
  const lines = (run.reportedUsageItems ?? []).filter(hasSegments);
  if (lines.length === 0) return null;
  return (
    <div className="mj-stack" aria-label="Spools per reported line">
      {lines.map((item) => (
        <div key={`${item.reportRevision}-${item.lineNumber}`}>
          <span>
            {reportedLineName(item)} · fed by {item.segments.length} spools
          </span>
          <ul className="jobs-lines">
            {item.segments.map((segment, position) => {
              const usage = segment.spoolId
                ? run.usages.find((candidate) => candidate.spoolId === segment.spoolId)
                : undefined;
              const previous = item.segments[position - 1];
              const article = usage?.materialName;
              const showArticle =
                article && (position === 0 || (previous && previous.materialId !== segment.materialId));
              return (
                <li key={segment.index} className="jobs-lines__line">
                  <span>
                    {segment.spoolId ? (
                      <RefLink kind="spool" reference={usage?.spoolDisplayId ?? 'Spool'} id={segment.spoolId} />
                    ) : (
                      <Tag type="red" size="sm">
                        No spool
                      </Tag>
                    )}
                    {showArticle ? ` · ${article}` : ''}
                    {' · '}
                    {segment.estimatedQuantityGrams != null
                      ? `${formatQuantity(segment.estimatedQuantityGrams)} g`
                      : 'quantity unknown'}
                    {` · ${startText(segment)}`}
                    {segment.split === 'progress' ? ' · estimated by progress' : ''}
                  </span>
                  {onMap && (!segment.spoolId || segment.estimatedQuantityGrams == null) && (
                    <Button kind="ghost" size="sm" onClick={() => onMap(item, segment)}>
                      Book {reportedLineName(item)} part {segment.index + 1} on a spool
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
