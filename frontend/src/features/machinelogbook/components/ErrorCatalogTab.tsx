import { useState, type ReactNode } from 'react';
import {
  Button,
  DataTable,
  InlineNotification,
  Link as CarbonLink,
  OverflowMenu,
  OverflowMenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  Tag,
} from '@carbon/react';
import { Add, Renew } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deletePrinterErrorCode, syncPrinterErrorCodes } from '../../../api/generated/printing/printing';
import type { PrinterErrorCode } from '../../../api/generated/models';
import { formatDateTime } from '../../../app/dateTime';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { EmptyState } from '../../../app/PageState';
import { ErrorCodeModal, type ErrorCodeDraft } from '../printerErrors/ErrorCodeModal';
import { safeLink } from '../printerErrors/printerErrorText';
import { machineLogbookKeys, printerErrorCodesQuery } from '../queries';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';

const headers = [
  { key: 'code', header: 'Code' },
  { key: 'family', header: 'Family' },
  { key: 'title', header: 'Meaning' },
  { key: 'description', header: 'What to do' },
  { key: 'link', header: 'Link' },
  { key: 'source', header: 'Source' },
];
const familyName = { hms: 'HMS', print: 'Print error' } as const;
const emptyDraft: ErrorCodeDraft = { sourceFamily: 'hms', code: '', title: '', description: '', link: null };

type Dialog = { entry?: PrinterErrorCode } | null;

/** The makerspace's recorded meanings of printer error codes; they override the Bambu wiki defaults. */
export function ErrorCatalogTab({ switcher }: { switcher?: ReactNode }) {
  const canManage = useCan()('machines.manage');
  const client = useQueryClient();
  const notify = useNotify();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [removing, setRemoving] = useState<PrinterErrorCode | null>(null);
  const catalog = useQuery(printerErrorCodesQuery());
  const items = catalog.data?.items ?? [];
  const sync = catalog.data?.sync;
  const fetchNow = useMutation({
    mutationFn: () => syncPrinterErrorCodes(),
    onSuccess: (result) => {
      client.setQueryData(printerErrorCodesQuery().queryKey, result);
    },
  });
  const remove = useMutation({
    mutationFn: (entry: PrinterErrorCode) => deletePrinterErrorCode(entry.sourceFamily, entry.code),
    onSuccess: async (_result, entry) => {
      notify({ kind: 'success', title: 'Error code removed', subtitle: entry.code });
      setRemoving(null);
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
  });
  return (
    <div className="mj-stack">
      {sync && (
        <div className="mj-stack">
          <p className="mj-secondary">
            {sync.enabled
              ? `Meanings are fetched from Bambu Lab's published list daily. ${
                  sync.lastSuccessAt
                    ? `Last fetched ${formatDateTime(sync.lastSuccessAt)} (${sync.importedCount} codes).`
                    : 'Not fetched yet.'
                }`
              : 'Automatic fetching is off (PRINTER_ERROR_CODE_SOURCE_URL is empty).'}
          </p>
          {sync.enabled && sync.lastError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title={`The last fetch failed: ${sync.lastError}`}
            />
          )}
          {fetchNow.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Fetch failed"
              subtitle={fetchNow.error instanceof Error ? fetchNow.error.message : 'Try again.'}
            />
          )}
          {canManage && (
            <div>
              <Button
                kind="tertiary"
                size="md"
                renderIcon={Renew}
                disabled={!sync.enabled || fetchNow.isPending}
                onClick={() => fetchNow.mutate()}
              >
                {fetchNow.isPending ? 'Fetching…' : 'Fetch now'}
              </Button>
            </div>
          )}
        </div>
      )}
      <QueryBoundary query={catalog} errorMessage="The error catalog could not be loaded.">
        <DataTable
          rows={items.map((entry) => ({ ...entry, family: familyName[entry.sourceFamily] }))}
          headers={headers}
        >
          {({ rows, headers: tableHeaders, getRowProps, getTableProps }) => (
            <TableContainer className="mj-table-container">
              <TableToolbar aria-label="Error catalog toolbar">
                {switcher}
                <TableToolbarContent>
                  {canManage && (
                    <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setDialog({})}>
                      Add code
                    </Button>
                  )}
                </TableToolbarContent>
              </TableToolbar>
              <Table {...getTableProps()} aria-label="Printer error catalog">
                <TableHead>
                  <TableRow>
                    {tableHeaders.map((header) => (
                      <TableHeader key={header.key}>{header.header}</TableHeader>
                    ))}
                    {canManage && <TableHeader aria-label="Actions" />}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row) => {
                    const entry = items.find((item) => item.id === row.id);
                    if (!entry) return null;
                    const href = safeLink(entry.link);
                    const { key, ...rowProps } = getRowProps({ row });
                    return (
                      <TableRow key={key} {...rowProps}>
                        <TableCell>
                          <code>{entry.code}</code>
                        </TableCell>
                        <TableCell>{familyName[entry.sourceFamily]}</TableCell>
                        <TableCell>{entry.title}</TableCell>
                        <TableCell>{entry.description || <span className="mj-secondary">—</span>}</TableCell>
                        <TableCell>
                          {href ? (
                            <CarbonLink href={href} target="_blank" rel="noopener noreferrer" size="sm">
                              Read more
                            </CarbonLink>
                          ) : (
                            <span className="mj-secondary">{entry.sourceFamily === 'hms' ? 'Bambu wiki' : '—'}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {entry.source === 'bambu' ? (
                            <Tag type="blue" size="sm">
                              Bambu Lab
                            </Tag>
                          ) : (
                            <Tag type="gray" size="sm">
                              Edited here
                            </Tag>
                          )}
                        </TableCell>
                        {canManage && (
                          <TableCell className="cds--table-column-menu">
                            <OverflowMenu
                              aria-label={`Actions for ${entry.code}`}
                              iconDescription={`Actions for ${entry.code}`}
                              flipped
                              size="sm"
                            >
                              <OverflowMenuItem itemText="Edit" onClick={() => setDialog({ entry })} />
                              <OverflowMenuItem itemText="Delete" isDelete onClick={() => setRemoving(entry)} />
                            </OverflowMenu>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {items.length === 0 && (
                <EmptyState
                  title="No error codes recorded"
                  description="Codes without a meaning here show only the code and, for HMS, the Bambu wiki link."
                />
              )}
            </TableContainer>
          )}
        </DataTable>
      </QueryBoundary>
      <p className="mj-secondary">
        Meanings recorded here appear next to printer errors, in the error history and on run pages.
      </p>
      {dialog && (
        <ErrorCodeModal
          key={dialog.entry?.id ?? 'new'}
          draft={dialog.entry ?? emptyDraft}
          fixedKey={Boolean(dialog.entry)}
          onClose={() => setDialog(null)}
        />
      )}
      <DestructiveActionDialog
        open={removing !== null}
        title="Remove error code?"
        fate="permanent"
        confirmLabel="Remove"
        pending={remove.isPending}
        error={remove.isError ? 'The code could not be removed. Try again.' : undefined}
        onConfirm={() => removing && remove.mutate(removing)}
        onClose={() => setRemoving(null)}
      >
        <p>
          The recorded meaning of <code>{removing?.code}</code> is removed. Printer errors with this code show no
          meaning afterwards.
        </p>
      </DestructiveActionDialog>
    </div>
  );
}
