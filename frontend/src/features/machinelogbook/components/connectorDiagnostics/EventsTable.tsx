import { Fragment, useState } from 'react';
import {
  Button,
  CodeSnippet,
  DataTable,
  InlineNotification,
  Modal,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableExpandedRow,
  TableExpandHeader,
  TableExpandRow,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PrinterConnector, PrinterConnectorEvent } from '../../../../api/generated/models';
import { clearPrinterConnectorEvents } from '../../../../api/generated/printer-connectors/printer-connectors';
import { connectorKeys } from '../../connectorQueries';
import { groupConnectorEvents } from '../../shared/connectorEvents';
import { formatDateTime, formatRelative } from '../../shared/format';
import { useNotify } from '../../shared/toasts';
import { useCan } from '../../shared/useCan';
import { eventLabels, reviewReason, stateLabels, relativeAge } from './diagnosticsShared';

const EVENT_PAGE_SIZE = 20;

export function EventsTable({ events, caption }: { events: PrinterConnectorEvent[]; caption: string }) {
  const [visible, setVisible] = useState(EVENT_PAGE_SIZE);
  const groups = groupConnectorEvents(events);
  const shown = groups.slice(0, visible);
  const rows = shown.map((group) => ({
    id: group.id,
    time: group.newest.receivedAt,
    label: eventLabels[group.newest.kind],
    summary: group.summary,
  }));
  const headers = [
    { key: 'time', header: 'Received' },
    { key: 'label', header: 'Event' },
    { key: 'summary', header: 'What happened' },
  ];
  return (
    <Stack gap={3}>
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getRowProps, getTableProps }) => (
          <TableContainer>
            <Table {...getTableProps()} size="sm" aria-label={caption}>
              <TableHead>
                <TableRow>
                  <TableExpandHeader aria-label="Raw payload" />
                  {tableHeaders.map((header) => (
                    <TableHeader key={header.key}>{header.header}</TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => {
                  // Carbon can retain the previous row model for one render
                  // while a polling response changes the grouped event IDs.
                  const group = shown.find((item) => item.id === row.id);
                  if (!group) return null;
                  const event = group.newest;
                  const { key, ...rowProps } = getRowProps({ row });
                  return (
                    <Fragment key={key}>
                      <TableExpandRow
                        {...rowProps}
                        aria-label={`Show raw payload of ${eventLabels[event.kind]} at ${formatDateTime(event.receivedAt)}`}
                      >
                        <TableCell>
                          <div className="mj-cell-stack">
                            <span title={formatDateTime(event.receivedAt)}>{relativeAge(event.receivedAt)}</span>
                            {group.count > 1 && (
                              <span className="mj-secondary">since {relativeAge(group.oldest.receivedAt)}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{eventLabels[event.kind]}</TableCell>
                        <TableCell>
                          <div className="mj-cell-stack">
                            <span className="mj-inline">
                              {group.summary}
                              {group.count > 1 && (
                                <Tag size="sm" type="gray">
                                  ×{group.count}
                                </Tag>
                              )}
                            </span>
                            {event.applicationState !== 'applied' && (
                              <span className="mj-secondary">
                                {stateLabels[event.applicationState]}
                                {event.applicationReason ? ` · ${reviewReason(event.applicationReason)}` : ''}
                              </span>
                            )}
                          </div>
                        </TableCell>
                      </TableExpandRow>
                      {row.isExpanded && (
                        <TableExpandedRow colSpan={tableHeaders.length + 1}>
                          <CodeSnippet type="multi" feedback="Copied" aria-label="Raw event payload">
                            {JSON.stringify(event.payload, null, 2)}
                          </CodeSnippet>
                        </TableExpandedRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>
      {groups.length > visible && (
        <div>
          <Button kind="ghost" size="sm" onClick={() => setVisible((count) => count + EVENT_PAGE_SIZE)}>
            Show older events ({groups.length - visible} more)
          </Button>
        </div>
      )}
    </Stack>
  );
}

/** Clear-events control, the "cleared" line and the toggle that brings cleared events back. Events are never deleted. */
export function EventsClearBar({
  connector,
  showCleared,
  onToggle,
}: {
  connector: PrinterConnector;
  showCleared: boolean;
  onToggle: () => void;
}) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const [confirming, setConfirming] = useState(false);
  const canManage = can('printer_connectors.manage');
  const clear = useMutation({
    mutationFn: () => clearPrinterConnectorEvents(connector.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: connectorKeys.all });
      notify({
        kind: 'success',
        title: 'Events cleared',
        subtitle: `Older events of ${connector.name} are hidden. They stay available with "Show cleared events".`,
      });
      setConfirming(false);
    },
  });
  if (!canManage && !connector.eventsClearedAt) return null;
  return (
    <div className="mj-inline mj-diag-clear-bar">
      {canManage && (
        <Button
          kind="tertiary"
          size="sm"
          onClick={() => {
            clear.reset();
            setConfirming(true);
          }}
        >
          Clear events
        </Button>
      )}
      {connector.eventsClearedAt && (
        <>
          <span className="mj-secondary">
            Events cleared {formatRelative(connector.eventsClearedAt)}
            {connector.eventsClearedByName ? ` by ${connector.eventsClearedByName}` : ''}
          </span>
          <Button kind="ghost" size="sm" onClick={onToggle}>
            {showCleared ? 'Hide cleared events' : 'Show cleared events'}
          </Button>
        </>
      )}
      {confirming && (
        <Modal
          open
          size="xs"
          modalHeading="Clear events?"
          primaryButtonText={clear.isPending ? 'Clearing…' : 'Clear events'}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={clear.isPending}
          preventCloseOnClickOutside
          onRequestClose={() => setConfirming(false)}
          onSecondarySubmit={() => setConfirming(false)}
          onRequestSubmit={() => clear.mutate()}
        >
          <Stack gap={5}>
            <p>
              The event lists of {connector.name} and its printers start empty. Nothing is deleted; use "Show cleared
              events" to see older events again.
            </p>
            {clear.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Events not cleared"
                subtitle="Try again."
              />
            )}
          </Stack>
        </Modal>
      )}
    </div>
  );
}
