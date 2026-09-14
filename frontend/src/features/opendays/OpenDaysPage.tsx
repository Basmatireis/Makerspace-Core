import { useState } from 'react';
import { Add, ArrowRight, Edit, SettingsAdjust } from '@carbon/icons-react';
import { Button, ClickableTile, Stack, Tag, Tile } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { CreateOpenDayPeriodWizard } from './CreateOpenDayPeriodWizard';
import { periodRange, statusTagType } from './format';
import { openDaySchedulePath } from './paths';
import { periodsQueryOptions } from './queries';

export function OpenDaysPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const periodsQuery = useQuery(periodsQueryOptions());
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
      {createOpen && <CreateOpenDayPeriodWizard
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(periodId, defaults) => {
          setCreateOpen(false);
          navigate(openDaySchedulePath(periodId), { state: { openDayDefaults: defaults } });
        }}
      />}
    </Stack>
  );
}
