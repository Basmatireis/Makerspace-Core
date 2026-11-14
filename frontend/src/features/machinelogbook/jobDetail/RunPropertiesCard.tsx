import { OverflowMenu, OverflowMenuItem, ProgressBar } from '@carbon/react';
import type { MachineRun, MachineRunRecording } from '../../../api/generated/models';
import { StackCard } from '../../../app/components/CardList';
import { RefLink } from '../../../app/RefLink';
import { SummaryList } from '../components/SummaryList';
import { MediaSlides, PrintPageActions, SignageToggle } from '../jobs/MediaCard';
import { consumptionNotice } from '../recording/recordingText';
import { formatDateTime, formatDuration, formatTime } from '../shared/format';
import {
  isRunLive,
  outcomeLabel,
  runConsumptionText,
  runEnd,
  runProgress,
  runStateNow,
  RunStateTag,
} from '../shared/status';
import { runActions, type RunAction } from './jobDetailShared';
import '../styles/machines.scss';

type Props = {
  run: MachineRun;
  /** Files of the job's recorded runs; the card shows the selected run's. */
  recordings: MachineRunRecording[];
  now: number;
  canEdit: boolean;
  canDelete: boolean;
  onAction: (action: RunAction, run: MachineRun) => void;
  /** The job's signage flag; with `onToggleSignage` the card offers the toggle, else an "Off signage" tag. */
  offSignage: boolean;
  onToggleSignage?: () => void;
  signagePending?: boolean;
};

const byMachine = (fromMachine: boolean | undefined) => (fromMachine ? ' · reported by the machine' : '');

/** The selected run of a job: its print file and timelapse, its facts and its actions. */
export function RunPropertiesCard({
  run,
  recordings,
  now,
  canEdit,
  canDelete,
  onAction,
  offSignage,
  onToggleSignage,
  signagePending,
}: Props) {
  const actions = runActions(run, now, canEdit, canDelete);
  const recorded = run.source === 'recorded';
  const live = isRunLive(run, now);
  const end = runEnd(run);
  const progress = runProgress(run, now);
  const notice = consumptionNotice(run.consumptionStatus);
  const replaced = run.state === 'replaced';
  const menu =
    actions.length > 0 ? (
      <OverflowMenu iconDescription={`Actions for ${run.displayId}`} flipped size="md">
        {actions.map((item) => (
          <OverflowMenuItem
            key={item.action}
            itemText={item.label}
            isDelete={item.isDelete}
            hasDivider={item.isDelete}
            onClick={() => onAction(item.action, run)}
          />
        ))}
      </OverflowMenu>
    ) : undefined;
  return (
    <StackCard title="Run properties" action={menu} className="jobs-media mj-run-properties">
      {recorded && (
        <>
          <MediaSlides key={run.id} recordings={recordings.filter((recording) => recording.runId === run.id)} />
          <div className="mj-run-properties__media-actions">
            <SignageToggle offSignage={offSignage} onToggleSignage={onToggleSignage} signagePending={signagePending} />
            {run.job && <PrintPageActions runId={run.id} />}
          </div>
        </>
      )}
      {live && (
        <ProgressBar
          label="Run progress"
          size="small"
          value={progress}
          max={100}
          helperText={`${progress} %${end ? ` · ends ~${formatTime(end)}` : ''}`}
        />
      )}
      <SummaryList
        label={`Properties of ${run.displayId}`}
        items={[
          { label: 'Run', value: <RefLink kind="run" reference={run.displayId} id={run.id} /> },
          { label: 'State', value: <RunStateTag state={replaced ? 'replaced' : runStateNow(run, now)} size="sm" /> },
          {
            label: 'Source',
            value: recorded ? `Recorded${run.connectorName ? ` via ${run.connectorName}` : ''}` : 'Manual',
          },
          recorded && { label: 'File', value: run.fileName ?? 'No file name' },
          { label: 'Started', value: formatDateTime(run.startedAt) },
          { label: run.endedAt ? 'Ended' : 'Estimated end', value: end ? formatDateTime(end) : '—' },
          { label: 'Runtime', value: `${formatDuration(run.durationSeconds)}${live ? ' so far' : ''}` },
          !live &&
            !replaced && {
              label: 'Outcome',
              value: run.outcome ? `${outcomeLabel(run.outcome)}${byMachine(run.outcomeFromMachine)}` : 'Not recorded',
            },
          { label: 'Material', value: `${runConsumptionText(run)}${byMachine(run.usagesFromMachine)}` },
          notice && { label: 'Material status', value: notice.title },
        ]}
      />
    </StackCard>
  );
}
