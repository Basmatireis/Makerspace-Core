import { useState } from 'react';
import { Button, Tag } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { OpenDayPeriod } from '../../../api/generated/models';
import { ErrorState, InlineLoadingState } from '../../../app/PageState';
import { dateOf, dayMonthYear } from '../model/dates';
import { newPeriodDefaults } from '../model/periodDefaults';
import { PanelFrame } from '../../../app/components/PanelFrame';
import { RecordTable, type RecordColumn } from '../components/RecordTable';
import { periodsQueryOptions } from '../queries';
import { PeriodForm } from './PeriodForm';
import { PeriodPanel } from './PeriodPanel';
import { periodRange, STATUS_TAG } from './status';

type Mode = 'view' | 'edit' | 'new';

function FillBar({ done, total }: { done: number; total: number }) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className="od-fill">
      <span className="od-fill__n">{total ? `${percent} %` : '—'}</span>
      {total > 0 && (
        <span className="od-fill__bar" role="img" aria-label={`${done} of ${total} fully staffed`}>
          <i style={{ inlineSize: `${percent}%` }} />
        </span>
      )}
    </span>
  );
}

/** The period list with the selected period's panel, form or the new-period form beside it. */
export function PeriodsTab({ initialId, canSignUp }: { initialId: string | null; canSignUp: boolean }) {
  const periods = useQuery(periodsQueryOptions());
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const [mode, setMode] = useState<Mode>('view');
  const [search, setSearch] = useState('');
  const items = periods.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;

  const columns: RecordColumn<OpenDayPeriod>[] = [
    {
      key: 'name',
      header: 'Period',
      primary: true,
      render: (period) => (
        <span className="od-cell-2">
          <b>{period.name}</b>
          <small>{periodRange(period)}</small>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (period) => (
        <Tag type={STATUS_TAG[period.status].type} size="sm">
          {STATUS_TAG[period.status].label}
        </Tag>
      ),
    },
    { key: 'days', header: 'Open days', render: (period) => period.totalOpenDays - period.cancelledCount },
    {
      key: 'staffed',
      header: 'Fully staffed',
      render: (period) => (
        <FillBar done={period.fullyStaffedCount} total={period.totalOpenDays - period.cancelledCount} />
      ),
    },
    {
      key: 'open',
      header: 'Open supervisor places',
      render: (period) =>
        period.openSupervisorPositions ? (
          <Tag type="red" size="sm">
            {period.openSupervisorPositions}
          </Tag>
        ) : (
          <span className="od-none">—</span>
        ),
    },
    ...(canSignUp
      ? [{ key: 'mine', header: 'Yours', render: (period: OpenDayPeriod) => period.myAssignmentCount }]
      : []),
    {
      key: 'deadline',
      header: 'Sign-up deadline',
      render: (period) =>
        period.signUpDeadline ? dayMonthYear(period.signUpDeadline) : <span className="od-none">Default</span>,
    },
  ];
  const query = search.trim().toLowerCase();
  const rows = items
    .filter(
      (period) =>
        !query ||
        [period.name, STATUS_TAG[period.status].label, periodRange(period)].join(' ').toLowerCase().includes(query),
    )
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn));
  const close = () => {
    setSelectedId(null);
    setMode('view');
  };
  const today = dateOf(new Date());
  const content = (() => {
    if (mode === 'new')
      return (
        <PeriodForm
          key="new"
          period={null}
          initial={newPeriodDefaults(items, today)}
          others={[...items].sort((a, b) => b.startsOn.localeCompare(a.startsOn))}
          onDone={(created) => {
            setSelectedId(created.id);
            setMode('view');
          }}
          onCancel={() => setMode('view')}
        />
      );
    if (!selected) return null;
    if (mode === 'edit')
      return (
        <PeriodForm
          key={selected.id}
          period={selected}
          initial={{
            name: selected.name,
            startsOn: selected.startsOn,
            endsOn: selected.endsOn,
            signUpDeadline: selected.signUpDeadline ?? '',
            copySeriesFromPeriodId: '',
          }}
          others={[]}
          onDone={() => setMode('view')}
          onCancel={() => setMode('view')}
        />
      );
    return (
      <PeriodPanel
        key={selected.id}
        period={selected}
        canSignUp={canSignUp}
        onEdit={() => setMode('edit')}
        onClose={close}
        onDeleted={close}
      />
    );
  })();

  if (periods.isPending) return <InlineLoadingState label="Loading Open Day periods" />;
  if (periods.isError)
    return (
      <ErrorState
        title="Unable to load Open Days"
        message="Check the connection and try again."
        onRetry={() => void periods.refetch()}
      />
    );
  return (
    <div className="od-split" data-guide="open-days-periods">
      <div className="od-main">
        <RecordTable
          label="Periods"
          rows={rows}
          columns={columns}
          getId={(period) => period.id}
          getName={(period) => period.name}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setMode('view');
          }}
          onSearch={setSearch}
          toolbar={
            <Button
              kind="primary"
              size="lg"
              renderIcon={Add}
              onClick={() => {
                setSelectedId(null);
                setMode('new');
              }}
            >
              New period
            </Button>
          }
          empty={{ title: 'No periods yet', description: 'Create a period to plan open days.' }}
        />
      </div>
      <PanelFrame
        label="Period details"
        open={content !== null}
        onClose={close}
        placeholder={<p>Pick a period to see its numbers, series and holidays.</p>}
      >
        {content}
      </PanelFrame>
    </div>
  );
}
