import { useState } from 'react';
import {
  Button,
  ComposedModal,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
} from '@carbon/react';
import { WarningAltFilled } from '@carbon/icons-react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { PrinterConnector } from '../../../api/generated/models';
import { assignmentsQuery, connectorEventsQuery, connectorsQuery, liveStatusQuery } from '../connectorQueries';
import { ageSeconds, connectorStatus } from '../shared/connectorStatus';
import { machineLogbookPaths } from '../shared/paths';
import { useNow } from '../shared/useNow';
import {
  STALE_AFTER_SECONDS,
  LIVE_REFRESH_MS,
  relativeAge,
  PrinterView,
  printerIssue,
} from './connectorDiagnostics/diagnosticsShared';
import { ConnectorPanel } from './connectorDiagnostics/ConnectorPanel';
import { PrinterPanel } from './connectorDiagnostics/PrinterPanel';
import { EventsClearBar } from './connectorDiagnostics/EventsTable';
import { ActivityTable } from './connectorDiagnostics/ActivityTable';

export function DiagnosticsModal({ connector: opened, onClose }: { connector: PrinterConnector; onClose: () => void }) {
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const now = useNow();
  // The list query holds the freshest connector (for example right after events were cleared).
  const latest = useQuery({ ...connectorsQuery(), refetchInterval: LIVE_REFRESH_MS });
  const connector = latest.data?.items.find((item) => item.id === opened.id) ?? opened;
  const status = connectorStatus(connector, now);
  const assignments = useQuery({ ...assignmentsQuery(connector.id), refetchInterval: LIVE_REFRESH_MS });
  const [showCleared, setShowCleared] = useState(false);
  const events = useQuery({ ...connectorEventsQuery(connector.id, showCleared), refetchInterval: LIVE_REFRESH_MS });
  const active = (assignments.data?.items ?? []).filter((assignment) => !assignment.endedAt);
  const liveQueries = useQueries({
    queries: active.map((assignment) => ({
      ...liveStatusQuery(assignment.machineId),
      refetchInterval: LIVE_REFRESH_MS,
    })),
  });
  const views: PrinterView[] = active.map((assignment, position) => {
    const live = liveQueries[position]?.data;
    const stale = Boolean(live && ageSeconds(live.receivedAt, now) > STALE_AFTER_SECONDS);
    return { assignment, live, stale, issue: printerIssue(assignment, live, stale) };
  });
  const allEvents = events.data?.items ?? [];
  // Tabs: the connector, one per printer, then the activity log.
  const activityIndex = views.length + 1;
  const selectedIndex = Math.min(index, activityIndex);
  const selected = selectedIndex > 0 && selectedIndex < activityIndex ? views[selectedIndex - 1] : undefined;
  return (
    <ComposedModal open size="lg" onClose={onClose} aria-label={`${connector.name} diagnostics`}>
      <ModalHeader
        label="Connector diagnostics"
        title={
          <span className="mj-inline">
            {connector.name}
            <Tag size="sm" type={status.type}>
              {status.label}
            </Tag>
          </span>
        }
      >
        <p className="mj-secondary">
          {[
            connector.locationLabel,
            connector.softwareVersion ? `software ${connector.softwareVersion}` : null,
            `last heartbeat ${connector.lastHeartbeatAt ? relativeAge(connector.lastHeartbeatAt) : 'never'}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </ModalHeader>
      <ModalBody>
        {(assignments.isError || events.isError) && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Diagnostics could not be loaded"
            subtitle="Close the dialog and try again."
          />
        )}
        <EventsClearBar
          connector={connector}
          showCleared={showCleared}
          onToggle={() => setShowCleared((current) => !current)}
        />
        <Tabs selectedIndex={selectedIndex} onChange={({ selectedIndex: next }) => setIndex(next)}>
          <TabList aria-label="Diagnostics sections" contained>
            <Tab>Connector</Tab>
            {views.map((view) => (
              <Tab key={view.assignment.id} renderIcon={view.issue ? WarningAltFilled : undefined}>
                {view.assignment.machineName}
              </Tab>
            ))}
            <Tab>Activity log</Tab>
          </TabList>
          <TabPanels>
            <TabPanel>
              <ConnectorPanel
                connector={connector}
                views={views}
                events={allEvents}
                onSelect={(machineId) =>
                  setIndex(views.findIndex((view) => view.assignment.machineId === machineId) + 1)
                }
              />
            </TabPanel>
            {views.map((view, position) => (
              <TabPanel key={view.assignment.id}>
                <PrinterPanel
                  view={view}
                  events={allEvents.filter((event) => event.machineId === view.assignment.machineId)}
                  active={index === position + 1}
                />
              </TabPanel>
            ))}
            <TabPanel>
              <ActivityTable connectorId={connector.id} active={selectedIndex === activityIndex} />
            </TabPanel>
          </TabPanels>
        </Tabs>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>
          Close
        </Button>
        {selected && (
          <Button
            kind="primary"
            onClick={() => {
              onClose();
              navigate(machineLogbookPaths.machine(selected.assignment.machineId, 'printer'));
            }}
          >
            Open printer setup
          </Button>
        )}
      </ModalFooter>
    </ComposedModal>
  );
}
