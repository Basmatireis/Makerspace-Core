import {
  InlineNotification,
  SkeletonPlaceholder,
  SkeletonText,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tile,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { MachineLogbookStatistics } from '../../api/generated/models';
import { dateInAppTimeZone } from '../../app/dateTime';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { statisticsQuery } from './queries';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { ExploreTab } from './statistics/ExploreTab';
import { MachinesTab } from './statistics/MachinesTab';
import { MaterialsTab } from './statistics/MaterialsTab';
import { MoneyTab } from './statistics/MoneyTab';
import { OverviewTab } from './statistics/OverviewTab';
import {
  addDays,
  DEFAULT_PERIOD,
  isPeriod,
  periodLabel,
  presetRange,
  rangeProblem,
  type DateRange,
  type Period,
} from './statistics/period';
import { PeriodPicker } from './statistics/PeriodPicker';
import './styles.scss';
import './styles/statistics.scss';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'machines', label: 'Machines' },
  { id: 'materials', label: 'Materials' },
  { id: 'money', label: 'Money' },
  { id: 'explore', label: 'Explore' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function StatisticsSkeleton() {
  return (
    <div className="stats-stack" aria-busy="true">
      <div className="fact-tiles">
        {[1, 2, 3, 4, 5, 6].map((item) => (
          <Tile key={item} className="fact-tiles__tile">
            <SkeletonText width="60%" />
            <SkeletonText heading width="40%" />
          </Tile>
        ))}
      </div>
      <div className="stats-row">
        {[1, 2].map((item) => (
          <div key={item} className="stack-card stats-card">
            <SkeletonText heading width="40%" />
            <SkeletonPlaceholder className="stats-card__skeleton" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatisticsPage() {
  const [params, setParams] = useSearchParams();
  const today = dateInAppTimeZone(new Date());
  const periodParam = params.get('period');
  const period: Period = isPeriod(periodParam) ? periodParam : DEFAULT_PERIOD;
  const fallback = presetRange(DEFAULT_PERIOD, today);
  const range: DateRange =
    period === 'custom'
      ? { from: params.get('from') ?? fallback.from, to: params.get('to') ?? fallback.to }
      : presetRange(period, today);
  const problem = rangeProblem(range);
  // The API range is half-open: `to` is the first day after the period.
  const query = useQuery({
    ...statisticsQuery({ from: range.from, to: problem ? range.to : addDays(range.to, 1) }),
    enabled: !problem,
  });
  const tabParam = params.get('tab');
  const tab: TabId = TABS.find((item) => item.id === tabParam)?.id ?? 'overview';
  const periodText = periodLabel(period, range);

  const update = (patch: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );

  const renderTab = (stats: MachineLogbookStatistics) => {
    if (stats.totals.jobs === 0 && stats.usageByWeekdayHour.length === 0 && stats.materialByMonth.length === 0)
      return (
        <EmptyState
          title="No activity in this period"
          description="Try a longer period, or check back after jobs have been recorded."
        />
      );
    return (
      <div className="stats-stack">
        {tab === 'overview' && <OverviewTab stats={stats} range={range} />}
        {tab === 'machines' && <MachinesTab stats={stats} range={range} />}
        {tab === 'materials' && <MaterialsTab stats={stats} range={range} />}
        {tab === 'money' && <MoneyTab stats={stats} range={range} />}
        {tab === 'explore' && <ExploreTab stats={stats} range={range} periodText={periodText} />}
      </div>
    );
  };

  return (
    <Tabs
      selectedIndex={TABS.findIndex((item) => item.id === tab)}
      onChange={({ selectedIndex }) => {
        const next = TABS[selectedIndex]?.id ?? 'overview';
        update({ tab: next === 'overview' ? null : next });
      }}
    >
      <PageShell
        title="Statistics"
        description="How the workshop is used, what it consumes and what it earns, compared with the previous period."
        width="wide"
        className="machine-logbook-page statistics-page"
        breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.home() }, { label: 'Statistics' }]}
        actions={
          <PeriodPicker
            period={period}
            range={range}
            onPreset={(next) => update({ period: next === DEFAULT_PERIOD ? null : next, from: null, to: null })}
            onCustom={(next) => update({ period: 'custom', from: next.from, to: next.to })}
          />
        }
        tabs={
          <TabList aria-label="Statistics sections">
            {TABS.map((item) => (
              <Tab key={item.id}>{item.label}</Tab>
            ))}
          </TabList>
        }
      >
        <TabPanels>
          {TABS.map((item) => (
            <TabPanel key={item.id} className="stats-panel">
              {item.id !== tab ? null : problem ? (
                <InlineNotification
                  kind="warning"
                  lowContrast
                  hideCloseButton
                  title="Choose a valid period"
                  subtitle={problem}
                />
              ) : (
                <QueryBoundary
                  query={query}
                  loading={<StatisticsSkeleton />}
                  errorMessage="Statistics could not be loaded."
                >
                  {(data) => renderTab(data)}
                </QueryBoundary>
              )}
            </TabPanel>
          ))}
        </TabPanels>
      </PageShell>
    </Tabs>
  );
}
