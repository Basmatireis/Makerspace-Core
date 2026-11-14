import { Button, OverflowMenu, OverflowMenuItem, ProgressBar, Tag } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import type { MachineRun, MachineRunRecording } from '../../../api/generated/models';
import { AttentionFlag } from '../../../app/components/AttentionFlag';
import { DetailPanel, DetailPanelHead } from '../../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../../app/components/Facts';
import { formatDate, formatTime } from '../../../app/dateTime';
import { RunStatus } from '../components/JobRunsTable';
import { MediaSlides, PrintPageActions, SignageToggle } from '../jobs/MediaCard';
import { consumptionNotice } from '../recording/recordingText';
import { formatDuration } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { isRunLive, outcomeLabel, runConsumptionText, runEnd, runName, runProgress } from '../shared/status';
import { runActions, runAttention, type RunAction } from './jobDetailShared';
import '../jobs/jobs.scss';

type Props = {
  run: MachineRun;
  /** Files of the job's recorded runs; the panel shows the selected run's. */
  recordings: MachineRunRecording[];
  now: number;
  canEdit: boolean;
  canDelete: boolean;
  onAction: (action: RunAction, run: MachineRun) => void;
  /** The job's signage flag; with `onToggleSignage` the panel offers the toggle, else an "Off signage" tag. */
  offSignage: boolean;
  onToggleSignage?: () => void;
  signagePending?: boolean;
};

const dateTime = (value: string) => `${formatDate(value)} ${formatTime(value)}`;

/**
 * The selected run of a job, laid out like the detail panel of the jobs list: its print file and timelapse, a head
 * with its status, the way to the run page, and its facts in two columns. The run's actions are in the menu.
 */
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
  const menu = actions.length > 0 && (
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
  );
  return (
    <section aria-label="Run properties">
      <DetailPanel className="jobs-panel mj-run-properties">
        <div className="jobs-panel__preview">
          <MediaSlides
            key={run.id}
            recordings={recordings.filter((recording) => recording.runId === run.id)}
            empty={
              recorded
                ? { title: 'No preview', detail: 'The print file and timelapse of this run appear here.' }
                : { title: 'No preview', detail: 'A manual run has no print file or timelapse.' }
            }
          />
        </div>
        <DetailPanelHead
          title={run.fileName ? runName(run) : run.displayId}
          meta={run.fileName ? `${run.displayId} · ${run.machineName}` : run.machineName}
          secondary={recorded ? `Recorded${run.connectorName ? ` via ${run.connectorName}` : ''}` : 'Manual run'}
          helper={
            <span className="mj-inline jobs-panel__tags">
              <RunStatus run={run} now={now} />
              <Tag type={recorded ? 'teal' : 'gray'} size="sm">
                {recorded ? 'Recorded' : 'Manual'}
              </Tag>
            </span>
          }
          actions={
            <span className="mj-inline">
              <AttentionFlag attention={runAttention(run, now)} align="left" />
              {menu}
            </span>
          }
        />
        <div className="mj-inline">
          <Button kind="tertiary" size="md" renderIcon={ArrowRight} as={Link} to={machineLogbookPaths.run(run.id)}>
            Open run
          </Button>
          {recorded && (
            <SignageToggle offSignage={offSignage} onToggleSignage={onToggleSignage} signagePending={signagePending} />
          )}
        </div>
        {live && (
          <ProgressBar
            label="Run progress"
            size="small"
            value={progress}
            max={100}
            helperText={`${progress} %${end ? ` · ends ~${formatTime(end)}` : ''}`}
          />
        )}
        <FactsGrid columns={2}>
          <Fact label="Started">{dateTime(run.startedAt)}</Fact>
          <Fact label={run.endedAt ? 'Ended' : 'Expected end'}>{end ? dateTime(end) : '—'}</Fact>
          <Fact label="Runtime">
            {formatDuration(run.durationSeconds)}
            {live ? ' so far' : ''}
          </Fact>
          <Fact label="Outcome" helper={run.outcomeFromMachine ? 'from machine' : undefined}>
            {live || replaced ? '—' : run.outcome ? outcomeLabel(run.outcome) : 'Not recorded'}
          </Fact>
          <Fact label="Material" helper={run.usagesFromMachine ? 'from machine' : notice?.title}>
            {runConsumptionText(run)}
          </Fact>
          {recorded && <Fact label="File">{run.fileName ?? 'No file name'}</Fact>}
        </FactsGrid>
        {recorded && run.job && <PrintPageActions runId={run.id} />}
      </DetailPanel>
    </section>
  );
}
