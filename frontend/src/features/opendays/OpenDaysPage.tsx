import { useState } from 'react';
import { Add, SettingsAdjust } from '@carbon/icons-react';
import { Button, ClickableTile, InlineNotification, Modal, Stack, Tag, TextInput } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createOpenDayPeriod } from '../../api/generated/open-days/open-days';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { periodRange, statusTagType } from './format';
import { openDayKeys, periodsQueryOptions } from './queries';

type PeriodForm = { name: string; startsOn: string; endsOn: string };

export function OpenDaysPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const periodsQuery = useQuery(periodsQueryOptions());
  const { register, handleSubmit, reset, formState: { errors } } = useForm<PeriodForm>();
  const createMutation = useMutation({
    mutationFn: (values: PeriodForm) => createOpenDayPeriod(values),
    onSuccess: async (period) => {
      await queryClient.invalidateQueries({ queryKey: openDayKeys.periods() });
      setCreateOpen(false);
      reset();
      navigate(`/open-days/${period.id}/schedule`);
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
            {periodsQuery.data.items.map((period) => {
              const staffingPercent = period.totalOpenDays === 0 ? 0 : Math.round(period.fullyStaffedCount / period.totalOpenDays * 100);
              return (
                <ClickableTile key={period.id} className="period-tile" onClick={() => navigate(`/open-days/${period.id}`)}>
                  <div className="period-tile__heading"><h3>{period.name}</h3><Tag type={statusTagType(period.status)}>{period.status}</Tag></div>
                  <p className="period-tile__range">{periodRange(period)}</p>
                  <div className="period-tile__stats">
                    <span><strong>{period.totalOpenDays}</strong><small>Total</small></span>
                    <span><strong className="status-good">{period.fullyStaffedCount}</strong><small>Staffed</small></span>
                    <span><strong className="status-bad">{period.needsStaffCount}</strong><small>Needs staff</small></span>
                  </div>
                  <div className="period-tile__progress" aria-label={`${staffingPercent}% fully staffed`}><span style={{ width: `${staffingPercent}%` }} /></div>
                  <p className="period-tile__footer">{period.myAssignmentCount > 0 ? `You: ${period.myAssignmentCount} assignment${period.myAssignmentCount === 1 ? '' : 's'}` : 'No assignments'}{period.cancelledCount > 0 ? ` · ${period.cancelledCount} cancelled` : ''}</p>
                </ClickableTile>
              );
            })}
            {canManage && <ClickableTile className="period-tile period-tile--new" onClick={() => setCreateOpen(true)}><Add size={24} /><span>New period</span></ClickableTile>}
          </div>
          {periodsQuery.data.items.length === 0 && !canManage && <div className="empty-state"><h2>No visible periods</h2><p>Open Day periods will appear here when staffing opens.</p></div>}
        </section>
      )}
      <Modal
        open={createOpen}
        modalHeading="Create Open Day period"
        primaryButtonText={createMutation.isPending ? 'Creating…' : 'Create period'}
        secondaryButtonText="Cancel"
        primaryButtonDisabled={createMutation.isPending}
        onRequestClose={() => setCreateOpen(false)}
        onRequestSubmit={() => void handleSubmit((values) => createMutation.mutate(values))()}
      >
        <Stack gap={5}>
          {createMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Period could not be created" subtitle="Review the values and try again." />}
          <TextInput id="period-name" labelText="Name" invalid={Boolean(errors.name)} invalidText="Enter a name." {...register('name', { required: true })} />
          <TextInput id="period-start" type="date" labelText="Start date" invalid={Boolean(errors.startsOn)} invalidText="Choose a start date." {...register('startsOn', { required: true })} />
          <TextInput id="period-end" type="date" labelText="End date" invalid={Boolean(errors.endsOn)} invalidText="Choose an end date." {...register('endsOn', { required: true })} />
        </Stack>
      </Modal>
    </Stack>
  );
}
