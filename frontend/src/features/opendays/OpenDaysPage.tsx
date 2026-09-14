import { useState, type ChangeEvent } from 'react';
import { Add, ArrowRight, Edit, SettingsAdjust } from '@carbon/icons-react';
import { Button, ClickableTile, DatePicker, DatePickerInput, InlineNotification, Modal, Stack, Tag, TextInput, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createOpenDayPeriod } from '../../api/generated/open-days/open-days';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { periodRange, statusTagType } from './format';
import { openDaySchedulePath } from './paths';
import { openDayKeys, periodsQueryOptions } from './queries';

type PeriodForm = { name: string; startsOn: string; endsOn: string };

export function OpenDaysPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const periodsQuery = useQuery(periodsQueryOptions());
  const { register, handleSubmit, reset, setValue, formState: { errors, submitCount } } = useForm<PeriodForm>({
    defaultValues: { name: '', startsOn: '', endsOn: '' },
  });
  const createMutation = useMutation({
    mutationFn: (values: PeriodForm) => createOpenDayPeriod(values),
    onSuccess: async (period) => {
      await queryClient.invalidateQueries({ queryKey: openDayKeys.periods() });
      setCreateOpen(false);
      reset();
      navigate(openDaySchedulePath(period.id));
    },
  });
  const canManage = hasPermission(currentUser, PermissionId.open_daysmanage);

  return (
    <Stack gap={7} className="open-days-page">
      <PageHeader
        title="Open Days"
        description="Plan schedules, coordinate staffing, and see your assignments."
        actions={canManage ? <><Button kind="secondary" renderIcon={SettingsAdjust} onClick={() => navigate('/open-days/manage')}>Manage periods</Button><Button renderIcon={Add} onClick={() => setCreateOpen(true)}>New period</Button></> : undefined}
      />
      {periodsQuery.isPending && <InlineLoadingState label="Loading Open Day periods" />}
      {periodsQuery.isError && <ErrorState title="Unable to load Open Days" message="Check the connection and try again." onRetry={() => void periodsQuery.refetch()} />}
      {periodsQuery.data && (
        <section aria-labelledby="periods-heading">
          <h2 id="periods-heading" className="open-days-section-title">Periods</h2>
          <div className="period-grid">
            {periodsQuery.data.items.map((period) => (
              <Tile key={period.id} className="period-tile">
                <div className="period-tile__heading"><h3>{period.name}</h3><Tag type={statusTagType(period.status)}>{period.status}</Tag></div>
                <p className="period-tile__range">{periodRange(period)}</p>
                <div className="period-tile__stats period-tile__stats--summary">
                  <span><strong>{period.totalOpenDays}</strong><small>Open Days</small></span>
                  <span><strong className={period.openSupervisorPositions > 0 ? 'status-bad' : 'status-good'}>{period.openSupervisorPositions}</strong><small>Open supervisor positions</small></span>
                </div>
                <p className="period-tile__footer">{period.myAssignmentCount > 0 ? `You: ${period.myAssignmentCount} assignment${period.myAssignmentCount === 1 ? '' : 's'}` : 'No assignments'}{period.cancelledCount > 0 ? ` · ${period.cancelledCount} cancelled` : ''}</p>
                <div className="period-tile__actions">
                  <Button kind="ghost" size="sm" renderIcon={ArrowRight} onClick={() => navigate(`/open-days/${period.id}`)}>View period</Button>
                  {canManage && period.status !== 'archived' && <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => navigate(openDaySchedulePath(period.id))}>Edit period</Button>}
                </div>
              </Tile>
            ))}
            {canManage && <ClickableTile className="period-tile period-tile--new" onClick={() => setCreateOpen(true)}><Add size={24} /><span>New period</span></ClickableTile>}
          </div>
          {periodsQuery.data.items.length === 0 && !canManage && <div className="empty-state"><h2>No visible periods</h2><p>Open Day periods will appear here when staffing opens.</p></div>}
        </section>
      )}
      {createOpen && <Modal
        open={createOpen}
        modalHeading="Create Open Day period"
        primaryButtonText={createMutation.isPending ? 'Creating…' : 'Create period'}
        secondaryButtonText="Cancel"
        primaryButtonDisabled={createMutation.isPending}
        onRequestClose={() => {
          setCreateOpen(false);
          reset();
          createMutation.reset();
        }}
        onRequestSubmit={() => void handleSubmit((values) => createMutation.mutate(values))()}
      >
        <Stack gap={5}>
          {createMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Period could not be created" subtitle="Review the values and try again." />}
          <TextInput id="period-name" labelText="Name" invalid={Boolean(errors.name)} invalidText="Enter a name." {...register('name', { required: true })} />
          <input type="hidden" {...register('startsOn', { required: true })} />
          <input type="hidden" {...register('endsOn', { required: true })} />
          <DatePicker
            datePickerType="range"
            dateFormat="Y-m-d"
            onChange={(dates) => {
              setValue('startsOn', dateValue(dates[0]), { shouldDirty: true, shouldValidate: submitCount > 0 });
              setValue('endsOn', dateValue(dates[1]), { shouldDirty: true, shouldValidate: submitCount > 0 });
            }}
          >
            <DatePickerInput
              id="period-start"
              labelText="Start date"
              placeholder="yyyy-mm-dd"
              invalid={submitCount > 0 && Boolean(errors.startsOn)}
              invalidText="Choose a start date."
              onChange={(event: ChangeEvent<HTMLInputElement>) => setValue('startsOn', event.target.value, { shouldDirty: true, shouldValidate: submitCount > 0 })}
            />
            <DatePickerInput
              id="period-end"
              labelText="End date"
              placeholder="yyyy-mm-dd"
              invalid={submitCount > 0 && Boolean(errors.endsOn)}
              invalidText="Choose an end date."
              onChange={(event: ChangeEvent<HTMLInputElement>) => setValue('endsOn', event.target.value, { shouldDirty: true, shouldValidate: submitCount > 0 })}
            />
          </DatePicker>
        </Stack>
      </Modal>}
    </Stack>
  );
}

function dateValue(date?: Date) {
  if (!date) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
