import {
  Button,
  DataTable,
  InlineNotification,
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
  TableToolbar,
  TableToolbarContent,
  Tag,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { PrivacyCategory, RetentionRun, RetentionRunItem } from '../../api/generated/models';
import { startRetentionRun } from '../../api/generated/privacy/privacy';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { formatDateTime } from '../../app/dateTime';
import { ErrorState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import {
  categoryName,
  privacyCategoriesQueryOptions,
  privacyErrorMessage,
  privacyQueryKey,
  retentionRunQueryOptions,
  retentionRunsQueryOptions,
} from './privacy';

const headers = [
  { key: 'started', header: 'Started' },
  { key: 'mode', header: 'Mode' },
  { key: 'trigger', header: 'Trigger' },
  { key: 'status', header: 'Status' },
  { key: 'finished', header: 'Finished' },
];

const runStatusTypes: Record<RetentionRun['status'], 'blue' | 'green' | 'red'> = {
  running: 'blue',
  completed: 'green',
  failed: 'red',
};

const itemStatusTypes: Record<RetentionRunItem['status'], 'green' | 'warm-gray' | 'red'> = {
  applied: 'green',
  skipped_hold: 'warm-gray',
  skipped_no_handler: 'warm-gray',
  failed: 'red',
};

const itemStatusLabels: Record<RetentionRunItem['status'], string> = {
  applied: 'Applied',
  skipped_hold: 'Skipped: hold',
  skipped_no_handler: 'Skipped: no handler',
  failed: 'Failed',
};

function ItemsTable({
  items,
  categories,
  mode,
}: {
  items: readonly RetentionRunItem[];
  categories: readonly PrivacyCategory[];
  mode: RetentionRun['mode'];
}) {
  if (items.length === 0) return <p>This run planned no work.</p>;
  return (
    <Table size="sm" aria-label="Run items">
      <TableHead>
        <TableRow>
          <TableHeader>Category</TableHeader>
          <TableHeader>Action</TableHeader>
          <TableHeader>Cutoff</TableHeader>
          <TableHeader>{mode === 'dry_run' ? 'Would affect' : 'Affected'}</TableHeader>
          <TableHeader>Status</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((item) => (
          <TableRow key={`${item.categoryId}-${item.policyId ?? 'legacy'}-${item.action}`}>
            <TableCell>{categoryName(categories, item.categoryId)}</TableCell>
            <TableCell>
              <Tag type="teal" size="sm">
                {item.action}
              </Tag>
            </TableCell>
            <TableCell>{formatDateTime(item.cutoff)}</TableCell>
            <TableCell>{item.affectedCount}</TableCell>
            <TableCell>
              <Tag type={itemStatusTypes[item.status]} size="sm">
                {itemStatusLabels[item.status]}
              </Tag>
              {item.errorCode && <span className="cds--type-helper-text-01"> {item.errorCode}</span>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RunDetail({ run, categories }: { run: RetentionRun; categories: readonly PrivacyCategory[] }) {
  // List rows carry no items; the detail query loads them when the row is expanded.
  const detail = useQuery(retentionRunQueryOptions(run.id ?? ''));
  if (detail.isPending) return <SettingsLoading label="Loading run items" />;
  if (detail.isError) return <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />;
  return <ItemsTable items={detail.data.items} categories={categories} mode={run.mode} />;
}

export function RunsTab() {
  const currentUser = useCurrentUser();
  const canExecute = hasPermission(currentUser, 'privacy.retention.execute');
  const client = useQueryClient();
  const runs = useQuery(retentionRunsQueryOptions());
  const categories = useQuery(privacyCategoriesQueryOptions());
  const [confirmExecute, setConfirmExecute] = useState(false);
  const [lastRun, setLastRun] = useState<RetentionRun>();

  const start = useMutation({
    mutationFn: (mode: RetentionRun['mode']) => startRetentionRun({ mode }),
    onSuccess: async (run) => {
      setLastRun(run);
      setConfirmExecute(false);
      await client.invalidateQueries({ queryKey: [...privacyQueryKey, 'runs'] });
    },
  });

  if (runs.isPending || categories.isPending) return <SettingsLoading label="Loading execution history" />;
  if (runs.isError) return <ErrorState message={runs.error.message} onRetry={() => void runs.refetch()} />;
  if (categories.isError) {
    return <ErrorState message={categories.error.message} onRetry={() => void categories.refetch()} />;
  }

  const categoryList = categories.data.categories;
  const byId = new Map(runs.data.runs.flatMap((run) => (run.id ? [[run.id as string, run] as const] : [])));
  const rows = [...byId.keys()].map((id) => ({ id }));

  return (
    <Stack gap={5}>
      {start.isError && !confirmExecute && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Run not started"
          subtitle={privacyErrorMessage(start.error)}
        />
      )}
      {lastRun && lastRun.id === null && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Nothing to do"
          subtitle="Nothing to do: no active policy or legacy routine applied."
        />
      )}
      {lastRun && lastRun.id !== null && (
        <Stack gap={3}>
          <InlineNotification
            kind={lastRun.status === 'failed' ? 'error' : 'success'}
            lowContrast
            hideCloseButton
            title={lastRun.mode === 'dry_run' ? 'Dry run finished' : 'Run finished'}
            subtitle={lastRun.errorCode ?? `Status: ${lastRun.status}.`}
          />
          <ItemsTable items={lastRun.items} categories={categoryList} mode={lastRun.mode} />
        </Stack>
      )}
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer>
            {canExecute && (
              <TableToolbar>
                <TableToolbarContent>
                  <Button
                    kind="primary"
                    disabled={start.isPending}
                    onClick={() => {
                      start.reset();
                      start.mutate('dry_run');
                    }}
                  >
                    Dry run
                  </Button>
                  <Button
                    kind="danger"
                    disabled={start.isPending}
                    onClick={() => {
                      start.reset();
                      setConfirmExecute(true);
                    }}
                  >
                    Execute
                  </Button>
                </TableToolbarContent>
              </TableToolbar>
            )}
            <Table {...getTableProps()} aria-label="Retention runs">
              <TableHead>
                <TableRow>
                  <TableExpandHeader aria-label="Expand to see items" />
                  {tableHeaders.map((header) => {
                    const { key, ...props } = getHeaderProps({ header });
                    return (
                      <TableHeader key={key} {...props}>
                        {header.header}
                      </TableHeader>
                    );
                  })}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => {
                  const run = byId.get(row.id);
                  if (!run) return null;
                  const { key, ...rowProps } = getRowProps({ row });
                  return [
                    <TableExpandRow key={key} {...rowProps} expandHeader="Expand to see items">
                      <TableCell>{formatDateTime(run.startedAt)}</TableCell>
                      <TableCell>
                        <Tag type={run.mode === 'execute' ? 'red' : 'blue'} size="sm">
                          {run.mode === 'execute' ? 'Execute' : 'Dry run'}
                        </Tag>
                      </TableCell>
                      <TableCell>{run.trigger}</TableCell>
                      <TableCell>
                        <Tag type={runStatusTypes[run.status]} size="sm">
                          {run.status}
                        </Tag>
                      </TableCell>
                      <TableCell>{run.finishedAt ? formatDateTime(run.finishedAt) : '–'}</TableCell>
                    </TableExpandRow>,
                    <TableExpandedRow key={`${key}-items`} colSpan={tableHeaders.length + 1}>
                      {rowProps.isExpanded && <RunDetail run={run} categories={categoryList} />}
                    </TableExpandedRow>,
                  ];
                })}
              </TableBody>
            </Table>
            {rows.length === 0 && <p className="cds--type-helper-text-01">No retention runs yet.</p>}
          </TableContainer>
        )}
      </DataTable>
      <DestructiveActionDialog
        open={confirmExecute}
        title="Execute retention run"
        confirmLabel="Execute"
        pending={start.isPending}
        error={start.isError ? privacyErrorMessage(start.error) : undefined}
        onClose={() => setConfirmExecute(false)}
        onConfirm={() => start.mutate('execute')}
      >
        <p>This removes data according to the active policies. Run a dry run first to see what would be affected.</p>
      </DestructiveActionDialog>
    </Stack>
  );
}
