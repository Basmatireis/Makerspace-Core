import { useState } from 'react';
import {
  DataTable,
  DataTableSkeleton,
  InlineNotification,
  Pagination,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { PrinterConnectorActivity, PrinterConnectorActivityKind } from '../../../../api/generated/models';
import { connectorActivityQuery } from '../../connectorQueries';
import { formatDateTime } from '../../shared/format';
import { eventLabels, relativeAge } from './diagnosticsShared';

const activityLabels: Record<PrinterConnectorActivityKind, string> = {
  event_ingested: 'Event received',
  spool_auto_mounted: 'Spool mounted automatically',
  spool_auto_unmounted: 'Spool unmounted automatically',
  run_recorded: 'Run updated',
  job_run_updated: 'Job updated',
};

const fieldLabels: Record<string, string> = {
  outcome: 'outcome',
  usages: 'material usage',
  inventory: 'inventory',
  runs: 'runs',
  calculatedPrice: 'calculated price',
  effectivePrice: 'price',
};

function details(item: PrinterConnectorActivity) {
  if (item.kind === 'event_ingested') {
    return item.eventKind ? (eventLabels[item.eventKind as keyof typeof eventLabels] ?? item.eventKind) : '';
  }
  const fields = item.changedFields.map((field) => fieldLabels[field] ?? field).join(', ');
  return [item.resourceLabel, fields].filter(Boolean).join(' · ');
}

const headers = [
  { key: 'time', header: 'Time' },
  { key: 'activity', header: 'Activity' },
  { key: 'printer', header: 'Printer' },
  { key: 'details', header: 'Details' },
];

/** What the connector changed automatically: received events, spool auto-mounts, recorded runs and their jobs. */
export function ActivityTable({ connectorId, active }: { connectorId: string; active: boolean }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const activity = useQuery({
    ...connectorActivityQuery(connectorId, page, pageSize),
    enabled: active,
    placeholderData: keepPreviousData,
  });
  if (activity.isPending) {
    return <DataTableSkeleton columnCount={headers.length} rowCount={5} showHeader={false} showToolbar={false} />;
  }
  if (activity.isError) {
    return (
      <InlineNotification
        kind="error"
        lowContrast
        hideCloseButton
        title="Activity log could not be loaded"
        subtitle="Try again later."
      />
    );
  }
  const items = activity.data.items;
  const rows = items.map((item) => ({
    id: item.id,
    time: item.occurredAt,
    activity: activityLabels[item.kind],
    printer: item.machineName ?? '–',
    details: details(item),
  }));
  return (
    <Stack gap={3}>
      <p className="mj-secondary">
        Changes the connector made on its own. They are kept for 30 days and are not part of the audit log.
      </p>
      {items.length === 0 ? (
        <p>No activity in the last 30 days.</p>
      ) : (
        <DataTable rows={rows} headers={headers}>
          {({ rows: tableRows, headers: tableHeaders, getRowProps, getTableProps }) => (
            <TableContainer>
              <Table {...getTableProps()} size="sm" aria-label="Connector activity log">
                <TableHead>
                  <TableRow>
                    {tableHeaders.map((header) => (
                      <TableHeader key={header.key}>{header.header}</TableHeader>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tableRows.map((row) => {
                    const item = items.find((candidate) => candidate.id === row.id);
                    if (!item) return null;
                    const { key, ...rowProps } = getRowProps({ row });
                    return (
                      <TableRow key={key} {...rowProps}>
                        <TableCell>
                          <span title={formatDateTime(item.occurredAt)}>{relativeAge(item.occurredAt)}</span>
                        </TableCell>
                        <TableCell>{activityLabels[item.kind]}</TableCell>
                        <TableCell>{item.machineName ?? '–'}</TableCell>
                        <TableCell>{details(item)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <Pagination
                page={page}
                pageSize={pageSize}
                pageSizes={[25, 50, 100]}
                totalItems={activity.data.total}
                onChange={({ page: nextPage, pageSize: nextSize }) => {
                  setPage(nextSize === pageSize ? nextPage : 1);
                  setPageSize(nextSize);
                }}
              />
            </TableContainer>
          )}
        </DataTable>
      )}
    </Stack>
  );
}
