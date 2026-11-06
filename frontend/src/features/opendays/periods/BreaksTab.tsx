import { useState } from 'react';
import { Button, IconButton, TextInput } from '@carbon/react';
import { Add, Close, Edit, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import {
  createOpenDayAcademicBreak,
  deleteOpenDayAcademicBreak,
  updateOpenDayAcademicBreak,
} from '../../../api/generated/open-days/open-days';
import type { AcademicBreak } from '../../../api/generated/models';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { DateInput } from '../../../app/DateInput';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../../app/components/Facts';
import { ErrorState, InlineLoadingState } from '../../../app/PageState';
import { PanelFrame } from '../../../app/components/PanelFrame';
import { RecordTable, type RecordColumn } from '../components/RecordTable';
import { breakDays, breakError, type BreakFields } from '../model/breaks';
import { dayMonthYear, shortDate } from '../model/dates';
import { FormPanel } from '../panels/FormPanel';
import { academicBreaksQueryOptions, openDayKeys, periodsQueryOptions } from '../queries';
import { scheduleErrorMessage } from '../scheduleErrors';

type Fields = BreakFields;

function BreakForm({
  item,
  onDone,
  onCancel,
}: {
  item: AcademicBreak | null;
  onDone: (item: AcademicBreak) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<Fields>({
    defaultValues: { name: item?.name ?? '', startsOn: item?.startsOn ?? '', endsOn: item?.endsOn ?? '' },
  });
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: (values: Fields) =>
      item
        ? updateOpenDayAcademicBreak(item.id, { ...values, name: values.name.trim(), expectedVersion: item.version })
        : createOpenDayAcademicBreak({ ...values, name: values.name.trim() }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: openDayKeys.all });
      onDone(saved);
    },
    onError: (failure) => setError(scheduleErrorMessage(failure)),
  });
  const submit = form.handleSubmit((values) => {
    const problem = breakError(values);
    setError(problem);
    if (!problem) save.mutate(values);
  });
  return (
    <FormPanel
      title={item ? `Edit ${item.name}` : 'New break'}
      meta="Academic break"
      formId="od-break-form"
      primaryLabel={item ? 'Save' : 'Add break'}
      onCancel={onCancel}
      disabled={save.isPending}
    >
      <form id="od-break-form" className="od-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextInput id="od-break-name" labelText="Name" placeholder="e.g. Semester break" {...form.register('name')} />
        <div className="od-form__2">
          <Controller
            control={form.control}
            name="startsOn"
            render={({ field }) => (
              <DateInput id="od-break-start" labelText="Start" value={field.value} onChange={field.onChange} />
            )}
          />
          <Controller
            control={form.control}
            name="endsOn"
            render={({ field }) => (
              <DateInput id="od-break-end" labelText="End" value={field.value} onChange={field.onChange} />
            )}
          />
        </div>
        <p className="od-hint">
          Series skip open days in this range. Open days that already exist on these dates stay.
        </p>
        {error && (
          <p className="od-field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </FormPanel>
  );
}

/** Academic breaks: the Leitung enters them; public holidays are calculated and need no entry. */
export function BreaksTab() {
  const breaks = useQuery(academicBreaksQueryOptions());
  const periods = useQuery(periodsQueryOptions());
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'new'>('view');
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const items = breaks.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const remove = useMutation({
    mutationFn: (item: AcademicBreak) => deleteOpenDayAcademicBreak(item.id, { expectedVersion: item.version }),
    onSuccess: async () => {
      setConfirmDelete(false);
      setSelectedId(null);
      await queryClient.invalidateQueries({ queryKey: openDayKeys.all });
    },
    onError: (failure) => setError(scheduleErrorMessage(failure)),
  });
  const columns: RecordColumn<AcademicBreak>[] = [
    { key: 'name', header: 'Name', primary: true, render: (item) => <b>{item.name}</b> },
    { key: 'start', header: 'Start', render: (item) => dayMonthYear(item.startsOn) },
    {
      key: 'end',
      header: 'End',
      render: (item) =>
        item.startsOn === item.endsOn ? <span className="od-none">—</span> : dayMonthYear(item.endsOn),
    },
    { key: 'days', header: 'Days', render: breakDays },
  ];
  const query = search.trim().toLowerCase();
  const rows = items
    .filter((item) => !query || [item.name, item.startsOn, item.endsOn].join(' ').toLowerCase().includes(query))
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  const close = () => {
    setSelectedId(null);
    setMode('view');
  };
  const content = (() => {
    if (mode === 'new')
      return (
        <BreakForm
          key="new"
          item={null}
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
        <BreakForm key={selected.id} item={selected} onDone={() => setMode('view')} onCancel={() => setMode('view')} />
      );
    const covered = (periods.data?.items ?? []).filter(
      (period) => selected.endsOn >= period.startsOn && selected.startsOn <= period.endsOn,
    );
    return (
      <DetailPanel className="od-detail">
        <DetailPanelHead
          title={selected.name}
          meta={
            selected.startsOn === selected.endsOn
              ? shortDate(selected.startsOn)
              : `${shortDate(selected.startsOn)} – ${shortDate(selected.endsOn)}`
          }
          secondary="Academic break"
          actions={
            <>
              <IconButton kind="ghost" size="md" label="Edit break" onClick={() => setMode('edit')}>
                <Edit />
              </IconButton>
              <IconButton
                kind="ghost"
                size="md"
                label="Delete break"
                onClick={() => {
                  setError('');
                  setConfirmDelete(true);
                }}
              >
                <TrashCan />
              </IconButton>
              <IconButton kind="ghost" size="md" label="Close details" onClick={close}>
                <Close />
              </IconButton>
            </>
          }
        />
        <FactsGrid columns={2}>
          <Fact label="Days">{breakDays(selected)}</Fact>
          <Fact label="Periods">{covered.map((period) => period.name).join(', ') || '—'}</Fact>
        </FactsGrid>
        <DetailPanelSection>
          <p className="od-hint">Series skip these dates. A single open day can still be added on purpose.</p>
        </DetailPanelSection>
        <DestructiveActionDialog
          open={confirmDelete}
          title="Delete break?"
          fate="permanent"
          confirmLabel="Delete break"
          pending={remove.isPending}
          error={error}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => remove.mutate(selected)}
        >
          <p>
            <b>{selected.name}</b> is removed. Series no longer skip these dates when open days are added later;
            existing open days stay as they are.
          </p>
        </DestructiveActionDialog>
      </DetailPanel>
    );
  })();
  if (breaks.isPending) return <InlineLoadingState label="Loading academic breaks" />;
  if (breaks.isError)
    return (
      <ErrorState
        title="Unable to load breaks"
        message="Check the connection and try again."
        onRetry={() => void breaks.refetch()}
      />
    );
  return (
    <div className="od-split">
      <div className="od-main">
        <RecordTable
          label="Breaks"
          rows={rows}
          columns={columns}
          getId={(item) => item.id}
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
              Add break
            </Button>
          }
          empty={{ title: 'No breaks yet', description: 'Public holidays are calculated and need no entry.' }}
        />
      </div>
      <PanelFrame
        label="Break details"
        open={content !== null}
        onClose={close}
        placeholder={<p>Pick a break to see what it affects.</p>}
      >
        {content}
      </PanelFrame>
    </div>
  );
}
