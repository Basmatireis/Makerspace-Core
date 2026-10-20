import { useState } from 'react';
import { RefLink } from '../../../app/RefLink';
import {
  Button,
  DataTable,
  OverflowMenu,
  OverflowMenuItem,
  ProgressBar,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
} from '@carbon/react';
import { Add, Link as LinkIcon } from '@carbon/icons-react';
import type { MachineJob, MachineRun } from '../../../api/generated/models';
import { formatDateTime, formatDuration, formatTime } from '../shared/format';
import {
  FromMachineTag,
  isRunLive,
  RunOutcomeTag,
  runEnd,
  RunSourceTag,
  RunStateTag,
  runName,
  runProgress,
  runConsumptionText,
  runStateNow,
} from '../shared/status';
import '../styles/jobs.scss';

export type RunAction = 'edit' | 'usage' | 'cancel' | 'delete' | 'detach';

const headers = [
  { key: 'run', header: 'Run' },
  { key: 'source', header: 'Source' },
  { key: 'state', header: 'State' },
  { key: 'start', header: 'Start' },
  { key: 'end', header: 'End' },
  { key: 'runtime', header: 'Runtime' },
  { key: 'outcome', header: 'Outcome' },
  { key: 'material', header: 'Material' },
];
const hideNarrow = new Set(['source', 'start', 'runtime']);

/** Row actions available for one run, depending on the permissions of the viewer. */
function actionsFor(
  run: MachineRun,
  now: number,
  canEdit: boolean,
  canDelete: boolean,
): { action: RunAction; label: string; isDelete?: boolean }[] {
  if (run.state === 'replaced') return [];
  const live = isRunLive(run, now);
  const mayDelete = canDelete || (run.source === 'manual' && canEdit);
  return [
    // A running recorded run has no start to correct and cannot have an outcome yet.
    ...(canEdit && (run.source === 'manual' || !live) ? [{ action: 'edit' as const, label: 'Edit run' }] : []),
    ...(canEdit ? [{ action: 'usage' as const, label: 'Edit material usage' }] : []),
    ...(canEdit && run.source === 'manual' && live ? [{ action: 'cancel' as const, label: 'Cancel run' }] : []),
    ...(canEdit && run.source === 'recorded'
      ? [{ action: 'detach' as const, label: 'Detach from job', isDelete: true }]
      : []),
    ...(mayDelete ? [{ action: 'delete' as const, label: 'Delete run', isDelete: true }] : []),
  ];
}

type Props = {
  job: MachineJob;
  now: number;
  canEdit: boolean;
  /** machine_jobs.delete: lets recorded runs be deleted too. */
  canDelete?: boolean;
  /** An unassigned recorded run exists on the job's machine, so attaching is worth offering. */
  canAttach: boolean;
  onAction: (action: RunAction, run: MachineRun) => void;
  onAdd: () => void;
  onAttach: () => void;
};

/** The runs of one job: manual and recorded, with row actions for people who may edit the job. */
export function JobRunsTable({ job, now, canEdit, canDelete = false, canAttach, onAction, onAdd, onAttach }: Props) {
  const [showReplaced, setShowReplaced] = useState(false);
  const ordered = [...job.runs].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  const replaced = ordered.filter((run) => run.state === 'replaced');
  const visible = showReplaced
    ? [...ordered.filter((run) => run.state !== 'replaced'), ...replaced]
    : ordered.filter((run) => run.state !== 'replaced');
  const showActions = canEdit || canDelete;
  const rows = visible.map((run) => ({
    id: run.id,
    run: run.displayId,
    source: run.source,
    state: run.state,
    start: run.startedAt,
    end: runEnd(run) ?? '',
    runtime: run.durationSeconds,
    outcome: run.outcome ?? '',
    material: '',
  }));

  return (
    <div className="mj-stack">
      <DataTable rows={rows} headers={headers} size="md">
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer
            title="Runs"
            description="Every machine run of this job. Runtime and material add up; replaced runs are history only."
            className="mj-table-container"
          >
            {canEdit && (
              <TableToolbar aria-label="Run actions">
                <TableToolbarContent>
                  {canAttach && (
                    <Button kind="ghost" size="lg" renderIcon={LinkIcon} onClick={onAttach}>
                      Attach recorded run
                    </Button>
                  )}
                  <Button kind="tertiary" size="lg" renderIcon={Add} onClick={onAdd}>
                    Add run
                  </Button>
                </TableToolbarContent>
              </TableToolbar>
            )}
            <Table {...getTableProps()} aria-label="Runs">
              <TableHead>
                <TableRow>
                  {tableHeaders.map((header) => {
                    const { key, ...props } = getHeaderProps({ header });
                    return (
                      <TableHeader
                        key={key}
                        {...props}
                        className={hideNarrow.has(header.key) ? 'mj-hide-narrow' : undefined}
                      >
                        {header.header}
                      </TableHeader>
                    );
                  })}
                  {showActions && <TableHeader aria-label="Actions" />}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => {
                  const run = visible.find((item) => item.id === row.id);
                  if (!run) return null;
                  const { key, ...props } = getRowProps({ row });
                  const state = runStateNow(run, now);
                  const live = state === 'running';
                  const end = runEnd(run);
                  const progress = runProgress(run, now);
                  const isReplaced = run.state === 'replaced';
                  const actions = actionsFor(run, now, canEdit, canDelete);
                  return (
                    <TableRow key={key} {...props} className={isReplaced ? 'mj-run-row--replaced' : undefined}>
                      <TableCell>
                        <div className="mj-cell-stack">
                          <RefLink kind="run" reference={run.displayId} id={run.id} />
                          <span className="mj-secondary">{run.fileName ? runName(run) : 'No file name'}</span>
                          <span className="mj-secondary mj-show-narrow">
                            {run.source === 'recorded'
                              ? `Recorded${run.connectorName ? ` via ${run.connectorName}` : ''}`
                              : 'Manual'}{' '}
                            · {formatDateTime(run.startedAt)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="mj-hide-narrow">
                        <div className="mj-cell-stack">
                          <span>
                            <RunSourceTag source={run.source} size="sm" />
                          </span>
                          {run.connectorName && <span className="mj-secondary">{run.connectorName}</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        {isReplaced ? (
                          <RunStateTag state="replaced" size="sm" />
                        ) : (
                          <RunStateTag state={state} size="sm" />
                        )}
                      </TableCell>
                      <TableCell className="mj-hide-narrow">{formatDateTime(run.startedAt)}</TableCell>
                      <TableCell>
                        {live ? (
                          <ProgressBar
                            label="Run progress"
                            hideLabel
                            size="small"
                            value={progress}
                            max={100}
                            helperText={`${progress} %${end ? ` · ends ~${formatTime(end)}` : ''}`}
                          />
                        ) : end ? (
                          formatDateTime(end)
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="mj-hide-narrow">
                        {formatDuration(run.durationSeconds)}
                        {live ? ' so far' : ''}
                      </TableCell>
                      <TableCell>
                        {live || isReplaced ? (
                          <span className="mj-secondary">—</span>
                        ) : (
                          <div className="mj-cell-stack">
                            <span>
                              <RunOutcomeTag outcome={run.outcome} size="sm" />
                            </span>
                            {run.outcomeFromMachine && (
                              <span>
                                <FromMachineTag />
                              </span>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="mj-cell-stack">
                          <span>{runConsumptionText(run)}</span>
                          {run.usagesFromMachine && (
                            <span>
                              <FromMachineTag />
                            </span>
                          )}
                        </div>
                      </TableCell>
                      {showActions && (
                        <TableCell className="cds--table-column-menu">
                          {actions.length > 0 && (
                            <OverflowMenu
                              aria-label={`Actions for ${run.displayId}`}
                              iconDescription={`Actions for ${run.displayId}`}
                              flipped
                              size="md"
                            >
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
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>
      {replaced.length > 0 && (
        <div>
          <Button kind="ghost" size="sm" onClick={() => setShowReplaced((current) => !current)}>
            {showReplaced ? 'Hide replaced runs' : `Show replaced runs (${replaced.length})`}
          </Button>
        </div>
      )}
    </div>
  );
}
