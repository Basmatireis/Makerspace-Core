import { type ReactNode } from 'react';
import {
  InlineNotification,
  Link as CarbonLink,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import type { PrinterConnector, PrinterConnectorEvent } from '../../../../api/generated/models';
import { adapterLabel } from '../../printerSetup';
import { connectorStatus } from '../../shared/connectorStatus';
import { connectorDiagnostic } from '../../shared/connectorHelpers';
import { useNow } from '../../shared/useNow';
import { eventLabels, reviewReason, runtimeLabels, runtimeTypes, relativeAge, PrinterView } from './diagnosticsShared';

export function ConnectorPanel({
  connector,
  views,
  events,
  onSelect,
}: {
  connector: PrinterConnector;
  views: PrinterView[];
  events: PrinterConnectorEvent[];
  onSelect: (machineId: string) => void;
}) {
  const now = useNow();
  const status = connectorStatus(connector, now);
  const review = events.filter((event) => event.applicationState === 'review_required');
  const failing = views.find((view) => view.assignment.runtimeErrorCode);
  const configured = connector.appliedConfigurationRevision === connector.configurationRevision;
  const facts: [string, ReactNode][] = [
    ['Lifecycle', connector.lifecycle.charAt(0).toUpperCase() + connector.lifecycle.slice(1)],
    [
      'Health',
      <Tag key="h" size="sm" type={status.type}>
        {status.label}
      </Tag>,
    ],
    ['Software', connector.softwareVersion ?? 'Unknown'],
    [
      'Configuration',
      `Revision ${connector.appliedConfigurationRevision} of ${connector.configurationRevision} applied${configured ? '' : ' (update pending)'}`,
    ],
    ['Last heartbeat', connector.lastHeartbeatAt ? relativeAge(connector.lastHeartbeatAt) : 'Never'],
    ['Event queue', `${connector.pendingEventCount} pending · ${connector.quarantinedEventCount} quarantined`],
  ];
  return (
    <Stack gap={6}>
      {connector.healthState === 'degraded' && connector.lifecycle === 'active' && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Connector needs attention"
          subtitle={
            failing
              ? `${failing.assignment.machineName}: ${failing.issue}`
              : connector.healthSummary
                ? connectorDiagnostic(connector.healthSummary)
                : 'One of its printers reports a problem.'
          }
        />
      )}
      <StructuredListWrapper isCondensed isFlush aria-label="Connector summary">
        <StructuredListBody>
          {facts.map(([label, value]) => (
            <StructuredListRow key={label}>
              <StructuredListCell noWrap>{label}</StructuredListCell>
              <StructuredListCell>{value}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      {review.length > 0 && (
        <div>
          <h4 className="mj-group-title">Events that need review</h4>
          <Stack gap={3}>
            {review.map((event) => (
              <InlineNotification
                key={event.id}
                kind="warning"
                lowContrast
                hideCloseButton
                title={reviewReason(event.applicationReason) ?? 'Needs review'}
                subtitle={`${eventLabels[event.kind]} · ${relativeAge(event.receivedAt)}`}
              />
            ))}
          </Stack>
        </div>
      )}
      <div>
        <h4 className="mj-group-title">Assigned printers</h4>
        {views.length === 0 ? (
          <p className="mj-secondary">No printers assigned. Assign a printer from its setup.</p>
        ) : (
          <Table size="sm" aria-label="Assigned printers">
            <TableHead>
              <TableRow>
                {['Printer', 'Adapter', 'Runtime state', 'Last data', 'Issue'].map((header) => (
                  <TableHeader key={header}>{header}</TableHeader>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {views.map(({ assignment, live, issue }) => (
                <TableRow key={assignment.id}>
                  <TableCell>
                    <CarbonLink
                      href="#"
                      onClick={(event) => {
                        event.preventDefault();
                        onSelect(assignment.machineId);
                      }}
                    >
                      {assignment.machineName}
                    </CarbonLink>
                  </TableCell>
                  <TableCell>{adapterLabel(assignment.adapterKind)}</TableCell>
                  <TableCell>
                    {assignment.runtimeState ? (
                      <Tag size="sm" type={runtimeTypes[assignment.runtimeState]}>
                        {runtimeLabels[assignment.runtimeState]}
                      </Tag>
                    ) : (
                      <span className="mj-secondary">Not reported</span>
                    )}
                  </TableCell>
                  <TableCell>{live ? relativeAge(live.receivedAt) : 'None yet'}</TableCell>
                  <TableCell>{issue ?? <span className="mj-secondary">None</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Stack>
  );
}
