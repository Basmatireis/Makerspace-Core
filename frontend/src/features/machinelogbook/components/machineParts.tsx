/* eslint-disable react-refresh/only-export-components -- small machine helpers and their tags belong together */
import { Tab, TabList, TabPanel, TabPanels, Tabs, Tag } from '@carbon/react';
import type {
  Machine,
  MachineActivity,
  MachineAvailability,
  MachineConnectorState,
  MachineCurrentItem,
  PrinterLiveStatusSnapshot,
  PrinterProfile,
} from '../../../api/generated/models';
import { formatRelative, formatTime } from '../shared/format';

export type MachineRow = {
  id: string;
  machine: Machine;
  availability: MachineAvailability;
  current: NonNullable<MachineCurrentItem> | null;
  connector: MachineConnectorState | null;
  connectorState: 'connected' | 'issue' | 'none';
  lastJobAt: string | null;
};

/** Joins machines with their activity (availability, current item, connector state, last job). */
export function machineRows(machines: Machine[], activity: MachineActivity[]): MachineRow[] {
  const byMachine = new Map(activity.map((item) => [item.machineId, item]));
  return machines.map((machine) => machineRow(machine, byMachine.get(machine.id)));
}

export function machineRow(machine: Machine, item: MachineActivity | undefined): MachineRow {
  const availability: MachineAvailability =
    item?.availability ?? (machine.status === 'active' ? 'available' : machine.status);
  const connector = item?.connector ?? null;
  const connectorState: MachineRow['connectorState'] = !connector?.runtimeState
    ? 'none'
    : ['disconnected', 'degraded'].includes(connector.runtimeState)
      ? 'issue'
      : 'connected';
  return {
    id: machine.id,
    machine,
    availability,
    current: item?.current ?? null,
    connector,
    connectorState,
    lastJobAt: item?.lastJobStartedAt ?? null,
  };
}

const connectorMeta = {
  connected: { label: 'Connected', type: 'green' },
  connecting: { label: 'Connecting', type: 'blue' },
  degraded: { label: 'Degraded', type: 'purple' },
  disconnected: { label: 'Disconnected', type: 'red' },
  disabled: { label: 'Disabled', type: 'gray' },
} as const;

export const connectorStateLabel = (connector: MachineConnectorState | null | undefined) =>
  connector?.runtimeState ? connectorMeta[connector.runtimeState].label : 'Manual';

/** The connector's state as a tag ("Degraded · E42"); machines without a connector read "Manual". */
export function ConnectorStateTag({ connector }: { connector: MachineConnectorState | null | undefined }) {
  if (!connector?.runtimeState) return <span className="mj-secondary">Manual</span>;
  const meta = connectorMeta[connector.runtimeState];
  const code = connector.runtimeState === 'degraded' && connector.runtimeErrorCode;
  return (
    <Tag size="sm" type={meta.type} title={code ? `${meta.label} · ${code}` : undefined}>
      {code ? `${meta.label} · ${code}` : meta.label}
    </Tag>
  );
}

/** Second line of a current item: when it started and when it should end. */
export function currentStatusText(current: NonNullable<MachineCurrentItem>) {
  return `Started ${formatRelative(current.startedAt)}${current.endsAt ? ` · ends ~${formatTime(current.endsAt)}` : ''}`;
}

/** What a machine without a current item is doing, as one line. */
export function idleText(row: Pick<MachineRow, 'availability' | 'lastJobAt'>) {
  if (row.availability === 'maintenance') return 'Marked for maintenance';
  if (row.availability === 'retired') return 'Retired';
  return row.lastJobAt ? `Last job ${formatRelative(row.lastJobAt)}` : 'No jobs yet';
}

export type PageSection = { id: string; label: string };

/**
 * Page-level tabs under the page title (PageShell `tabs`): Carbon line tabs whose sections render below the header
 * instead of in tab panels.
 */
export function PageSectionTabs({
  sections,
  selected,
  onChange,
  label,
  guide,
}: {
  sections: PageSection[];
  selected: string;
  onChange: (id: string) => void;
  label: string;
  /** The `data-guide` name of the tab bar, so guided tours can point at it. */
  guide?: string;
}) {
  return (
    <div className="mj-page-tabs" data-guide={guide}>
      <Tabs
        selectedIndex={Math.max(
          0,
          sections.findIndex((section) => section.id === selected),
        )}
        onChange={({ selectedIndex }) => onChange(sections[selectedIndex].id)}
      >
        <TabList aria-label={label}>
          {sections.map((section) => (
            <Tab key={section.id}>{section.label}</Tab>
          ))}
        </TabList>
        {/* Carbon tabs point aria-controls at a panel; the sections render below the header, so the panels stay empty. */}
        <TabPanels>
          {sections.map((section) => (
            <TabPanel key={section.id} className="mj-page-tabs__panel" />
          ))}
        </TabPanels>
      </Tabs>
    </div>
  );
}

/** "222 °C / 215 °C · bed 60 °C": the temperatures a printer reports, or null when it reports none. */
export function temperaturesText(status: PrinterLiveStatusSnapshot): string | null {
  const nozzles = status.temperatures.extruders
    .map((extruder) => extruder.currentC)
    .filter((value): value is number => value != null)
    .map((value) => `${Math.round(value)} °C`);
  const parts = [
    nozzles.length ? `nozzle ${nozzles.join(' / ')}` : null,
    status.temperatures.bedC != null ? `bed ${Math.round(status.temperatures.bedC)} °C` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** Mounted spools of a printer profile, one line per slot with a spool. */
export function mountedSpoolLines(profile: PrinterProfile | undefined) {
  if (!profile) return [];
  return profile.slots
    .filter((slot) => slot.status !== 'retired' && slot.spoolId)
    .sort((a, b) => a.inputUnitName.localeCompare(b.inputUnitName, 'en', { numeric: true }) || a.position - b.position)
    .map((slot) => ({ id: slot.id, where: `${slot.inputUnitName} · ${slot.name}`, spool: slot.spoolDisplayId ?? '' }));
}
