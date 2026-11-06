import { useState } from 'react';
import {
  ClickableTile,
  InlineNotification,
  Select,
  SelectItem,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
} from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { Membership, OpenDayPeriod } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasAnyPermission, hasPermission, PermissionId } from '../auth/permissions';
import { saveBlob } from '../configtransfer/helpers';
import { plural, shortDate } from '../dashboard/format';
import { ExcuseDialog, MembershipDialog } from './StaffingDialogs';
import { StaffingPanel, type PanelCan } from './StaffingPanel';
import { PanelFrame } from '../../app/components/PanelFrame';
import { StaffingRulesTab } from './StaffingRulesTab';
import { StaffingTable } from './StaffingTable';
import {
  filterDefs,
  filterRows,
  glanceCount,
  GLANCE_PRESETS,
  isPresetActive,
  sortRows,
  staffingCsv,
  type GlanceTileId,
  type SortKey,
  type SortState,
  type StaffingFilterValues,
} from './staffing';
import { staffingDashboardOptions, staffingPeriodsOptions } from './staffingQueries';
import './staffing.scss';

const TABS = [
  { id: 'people', label: 'People' },
  { id: 'rules', label: 'Rules' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function GlanceTile({
  label,
  value,
  unit,
  helper,
  active,
  onClick,
}: {
  label: string;
  value: number;
  unit: string;
  helper: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <ClickableTile
      className={`st-glance__tile${active ? ' is-active' : ''}`}
      onClick={onClick}
      role="button"
      aria-pressed={active}
    >
      <span className="st-glance__label">{label}</span>
      <span className="st-glance__value">
        {value}
        <small>{unit}</small>
      </span>
      <span className="st-secondary">{helper}</span>
    </ClickableTile>
  );
}

function PeopleTab({ canManage, periods }: { canManage: boolean; periods: OpenDayPeriod[] }) {
  const currentUser = useCurrentUser();
  const [periodId, setPeriodId] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<StaffingFilterValues>({});
  const [sort, setSort] = useState<SortState>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [membershipChange, setMembershipChange] = useState<Membership | null>(null);
  const [excusing, setExcusing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({ ...staffingDashboardOptions(periodId), placeholderData: keepPreviousData });

  if (query.isPending) return <FullPageLoading label="Loading staffing" />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title="Unable to load staffing"
        message="Check the connection and try again."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const { semester, rules, supervisors } = query.data;
  const selectedPeriodId = periodId ?? semester?.periodId ?? '';
  const period = periods.find((item) => item.id === semester?.periodId);
  const defs = filterDefs(supervisors);
  const visible = sortRows(filterRows(supervisors, search, filters), sort);
  const selected = supervisors.find((row) => row.personId === selectedId) ?? null;

  const can: PanelCan = {
    assign: hasPermission(currentUser, PermissionId.open_daysassign),
    manage: canManage,
    membership: hasPermission(currentUser, PermissionId.peoplerolesassign),
    openPerson: hasPermission(currentUser, PermissionId.peoplereadall),
    schedule: hasAnyPermission(currentUser, [PermissionId.open_daysread, PermissionId.open_daysmanage]),
  };

  const applyFilters = (values: StaffingFilterValues) => {
    setFilters(values);
    setPage(1);
  };
  const toggleSort = (key: SortKey) => {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: 'asc' };
      return current.direction === 'asc' ? { key, direction: 'desc' } : null;
    });
  };
  const glance = (id: GlanceTileId) => ({
    value: glanceCount(supervisors, id),
    active: isPresetActive(filters, id),
    onClick: () => applyFilters(isPresetActive(filters, id) ? {} : GLANCE_PRESETS[id]),
  });
  const deadline = semester ? `Sign-up deadline ${shortDate(semester.signUpBy)}` : 'No open-day period';
  const closePanel = () => setSelectedId(null);

  return (
    <div className="st-people">
      <div className="st-period">
        {periods.length > 0 && (
          <Select
            id="staffing-period"
            labelText="Semester"
            inline
            value={selectedPeriodId}
            onChange={(event) => {
              setPeriodId(event.target.value);
              setPage(1);
            }}
          >
            {periods.map((item) => (
              <SelectItem key={item.id} value={item.id} text={item.name} />
            ))}
          </Select>
        )}
      </div>
      {notice && (
        <InlineNotification kind="success" lowContrast title={notice} onCloseButtonClick={() => setNotice(null)} />
      )}
      {semester === null && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="No open-day period"
          subtitle="Supervisors and trainees are shown without open-day counts."
        />
      )}
      <section aria-label="At a glance" className="st-glance">
        <GlanceTile label="Below minimum" unit="people" helper={deadline} {...glance('below')} />
        <GlanceTile
          label="Ready for supervisor"
          unit="trainees"
          helper={`${plural(rules.traineeReadyAfter, 'open day')} as trainee`}
          {...glance('ready')}
        />
        <GlanceTile
          label="Nothing coming up"
          unit="below minimum"
          helper="Below minimum and not signed up for anything"
          {...glance('idle')}
        />
        <GlanceTile
          label="Lab rules not confirmed"
          unit="people"
          helper="They confirm the Lab Rules themselves"
          {...glance('labRules')}
        />
      </section>
      <div className="st-split">
        <div className="st-split__list">
          <StaffingTable
            rows={visible}
            filterDefs={defs}
            search={search}
            filters={filters}
            sort={sort}
            page={page}
            pageSize={pageSize}
            selectedId={selected?.personId ?? null}
            hasAnyRows={supervisors.length > 0}
            onSearch={(value) => {
              setSearch(value);
              setPage(1);
            }}
            onFilters={applyFilters}
            onSort={(key) => {
              toggleSort(key);
              setPage(1);
            }}
            onPage={(nextPage, nextPageSize) => {
              setPage(nextPage);
              setPageSize(nextPageSize);
            }}
            onSelect={setSelectedId}
            onExport={() =>
              saveBlob(
                new Blob([staffingCsv(visible)], { type: 'text/csv;charset=utf-8' }),
                `staffing-${(semester?.name ?? 'people').toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}.csv`,
              )
            }
          />
        </div>
        <PanelFrame
          label="Person details"
          open={selected !== null}
          placeholder="Pick a person to see their open days."
          onClose={closePanel}
        >
          {selected && (
            <StaffingPanel
              key={selected.personId}
              row={selected}
              semester={semester}
              period={period}
              warningWindowDays={rules.warningWindowDays}
              currentPersonId={currentUser.person.id}
              can={can}
              onClose={closePanel}
              onMembership={setMembershipChange}
              onExcuse={() => setExcusing(true)}
              onNotify={setNotice}
            />
          )}
        </PanelFrame>
      </div>
      <MembershipDialog
        member={selected}
        target={membershipChange}
        onClose={() => setMembershipChange(null)}
        onChanged={setNotice}
      />
      <ExcuseDialog
        member={excusing ? selected : null}
        periodId={semester?.periodId ?? null}
        periodName={semester?.name ?? ''}
        onClose={() => setExcusing(false)}
        onExcused={setNotice}
      />
    </div>
  );
}

/** Staffing: who staffs open days against their minimum (People), and the rules behind it (Rules). */
export function SupervisorStaffingPage() {
  const currentUser = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const canManage = hasPermission(currentUser, PermissionId.open_daysmanage);
  const canOpenPeople = hasPermission(currentUser, PermissionId.peoplereadall);
  const canReadPeriods = hasAnyPermission(currentUser, [PermissionId.open_daysread, PermissionId.open_daysmanage]);
  const periodsQuery = useQuery(staffingPeriodsOptions(canReadPeriods));
  // Drafts are for the people who plan open days; the API already leaves them out for everyone else.
  const periods = (periodsQuery.data?.items ?? []).filter((period) => canManage || period.status !== 'draft');
  const tab: TabId = params.get('tab') === 'rules' ? 'rules' : 'people';

  return (
    <PageShell
      title="Staffing"
      breadcrumbs={[
        { label: 'Directory' },
        ...(canOpenPeople ? [{ label: 'People', to: '/people' }] : []),
        { label: 'Staffing' },
      ]}
      width="wide"
      className="supervisor-staffing-page"
      tabs={
        <Tabs
          selectedIndex={TABS.findIndex((item) => item.id === tab)}
          onChange={({ selectedIndex }) =>
            setParams(
              (previous) => {
                const next = new URLSearchParams(previous);
                if (TABS[selectedIndex].id === 'people') next.delete('tab');
                else next.set('tab', TABS[selectedIndex].id);
                return next;
              },
              { replace: true },
            )
          }
        >
          <TabList aria-label="Staffing sections">
            {TABS.map((item) => (
              <Tab key={item.id}>{item.label}</Tab>
            ))}
          </TabList>
          {/* The sections render below the header, so Carbon's panels stay empty. */}
          <TabPanels>
            {TABS.map((item) => (
              <TabPanel key={item.id} className="st-tab-panel" />
            ))}
          </TabPanels>
        </Tabs>
      }
    >
      {tab === 'people' ? (
        <PeopleTab canManage={canManage} periods={periods} />
      ) : (
        <StaffingRulesTab canEdit={canManage} />
      )}
    </PageShell>
  );
}
