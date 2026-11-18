import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { RefLink } from '../../../app/RefLink';
import {
  Button,
  DataTable,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  Tooltip,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import type { MachineJob, MachineRun } from '../../../api/generated/models';
import { AttentionFlag, attentionColumnClassName } from '../../../app/components/AttentionFlag';
import { runAttention } from '../jobDetail/jobDetailShared';
import { formatDateTime, formatDuration } from '../shared/format';
import { JobRowStatusTag, OutcomeTag, RunStateTag, runStateNow } from '../shared/status';
import '../styles/jobs.scss';

const headers = [
  { key: 'run', header: 'Run' },
  { key: 'status', header: 'Status' },
  { key: 'start', header: 'Start' },
  { key: 'runtime', header: 'Runtime' },
];
const hideNarrow = new Set(['start', 'runtime']);

/**
 * One status per run: running or replaced while that is what matters, then the outcome, and "Needs outcome" for a
 * run that ended without one. With `tooltip`, an outcome the machine reported says so on hover and keyboard focus.
 */
export function RunStatus({ run, now, tooltip = false }: { run: MachineRun; now: number; tooltip?: boolean }) {
  if (run.state === 'replaced') return <RunStateTag state="replaced" size="sm" />;
  const state = runStateNow(run, now);
  if (state === 'running') return <RunStateTag state="running" size="sm" />;
  if (!run.outcome) return <JobRowStatusTag status="needs_outcome" size="sm" />;
  if (!tooltip || !run.outcomeFromMachine) return <OutcomeTag outcome={run.outcome} size="sm" />;
  return (
    <Tooltip align="bottom" description="Reported by the machine">
      <button type="button" className="mj-tag-trigger">
        <OutcomeTag outcome={run.outcome} size="sm" />
      </button>
    </Tooltip>
  );
}

type Props = {
  job: MachineJob;
  now: number;
  canEdit: boolean;
  /** The run whose properties the job page shows next to the table. */
  selectedId: string | undefined;
  onSelect: (run: MachineRun) => void;
  onAdd: () => void;
};

/**
 * The runs of one job, manual and recorded, one line each. Clicking a row (or Enter on it) shows the run's
 * properties, files and actions next to the table; the flag at the end marks material that still needs someone.
 */
export function JobRunsTable({ job, now, canEdit, selectedId, onSelect, onAdd }: Props) {
  const [showReplaced, setShowReplaced] = useState(false);
  const ordered = [...job.runs].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  const replaced = ordered.filter((run) => run.state === 'replaced');
  const visible = showReplaced
    ? [...ordered.filter((run) => run.state !== 'replaced'), ...replaced]
    : ordered.filter((run) => run.state !== 'replaced');
  const rows = visible.map((run) => ({
    id: run.id,
    run: run.displayId,
    status: run.outcome ?? run.state,
    start: run.startedAt,
    runtime: run.durationSeconds,
  }));

  return (
    <div className="mj-stack">
      <DataTable rows={rows} headers={headers} size="md">
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer
            title="Runs"
            description="Every machine run of this job. Runtime and material add up; replaced runs are history only. Select a run to see its files and actions."
            className="mj-table-container"
          >
            {canEdit && (
              <TableToolbar aria-label="Run actions">
                <TableToolbarContent>
                  <Button kind="primary" size="lg" renderIcon={Add} onClick={onAdd}>
                    Add
                  </Button>
                </TableToolbarContent>
              </TableToolbar>
            )}
            <Table {...getTableProps()} aria-label="Runs" className="mj-runs-table">
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
                  <TableHeader className={attentionColumnClassName}>
                    <span className="cds--visually-hidden">Needs attention</span>
                  </TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => {
                  const run = visible.find((item) => item.id === row.id);
                  if (!run) return null;
                  const { key, ...props } = getRowProps({ row });
                  const live = runStateNow(run, now) === 'running';
                  const selected = run.id === selectedId;
                  const className = ['mj-row-clickable', run.state === 'replaced' && 'mj-run-row--replaced']
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <TableRow
                      key={key}
                      {...props}
                      isSelected={selected}
                      aria-current={selected ? 'true' : undefined}
                      tabIndex={0}
                      className={className}
                      onClick={(event: MouseEvent<HTMLElement>) => {
                        if (!(event.target as HTMLElement).closest('a, button')) onSelect(run);
                      }}
                      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
                        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' '))
                          return;
                        event.preventDefault();
                        onSelect(run);
                      }}
                    >
                      <TableCell className="mj-runs-table__run">
                        <RefLink kind="run" reference={run.displayId} id={run.id} />
                      </TableCell>
                      <TableCell>
                        <RunStatus run={run} now={now} tooltip />
                      </TableCell>
                      <TableCell className="mj-hide-narrow">{formatDateTime(run.startedAt)}</TableCell>
                      <TableCell className="mj-hide-narrow">
                        {formatDuration(run.durationSeconds)}
                        {live ? ' so far' : ''}
                      </TableCell>
                      <TableCell className={attentionColumnClassName}>
                        <AttentionFlag attention={runAttention(run, now)} />
                      </TableCell>
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
