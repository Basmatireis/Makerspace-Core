import { useState, type ReactNode } from 'react';
import { Button, InlineNotification, Link as CarbonLink, OverflowMenu, OverflowMenuItem, Tag } from '@carbon/react';
import { Add, Renew } from '@carbon/icons-react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deletePrinterErrorCode, syncPrinterErrorCodes } from '../../../api/generated/printing/printing';
import type { ListPrinterErrorCodesParams, PrinterErrorCode } from '../../../api/generated/models';
import { formatDateTime } from '../../../app/dateTime';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import type { FilterCategory } from '../../../app/BatchFilter';
import { ErrorCodeModal, type ErrorCodeDraft } from '../printerErrors/ErrorCodeModal';
import { safeLink } from '../printerErrors/printerErrorText';
import { machineLogbookKeys, printerErrorCodesQuery } from '../queries';
import { DirectoryTable, useServerTableState, type Column } from '../shared/DirectoryTable';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';

const familyName = { hms: 'HMS', print: 'Print error' } as const;
const families = ['hms', 'print'] as const;
const sources = ['bambu', 'manual'] as const;
const emptyDraft: ErrorCodeDraft = { sourceFamily: 'hms', code: '', title: '', description: '', link: null };

type Dialog = { entry?: PrinterErrorCode } | null;

/** The makerspace's recorded meanings of printer error codes; they override the Bambu wiki defaults. */
export function ErrorCatalogTab({ switcher }: { switcher?: ReactNode }) {
  const canManage = useCan()('machines.manage');
  const client = useQueryClient();
  const notify = useNotify();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [removing, setRemoving] = useState<PrinterErrorCode | null>(null);
  const table = useServerTableState('catalog-', { key: 'code', direction: 'ASC' });
  const { search } = table;
  const familyValue = table.url.get('sourceFamily');
  const sourceValue = table.url.get('source');
  const family = families.find((item) => item === familyValue);
  const source = sources.find((item) => item === sourceValue);
  const params: ListPrinterErrorCodesParams = {
    search: search || undefined,
    sourceFamily: family,
    source,
    page: table.page,
    pageSize: table.pageSize,
  };
  const catalog = useQuery({ ...printerErrorCodesQuery(params), placeholderData: keepPreviousData });
  const sync = catalog.data?.sync;
  const fetchNow = useMutation({
    mutationFn: () => syncPrinterErrorCodes(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.printerErrorCodes() });
    },
  });
  const filterCategories: FilterCategory[] = [
    {
      key: 'sourceFamily',
      label: 'Family',
      single: true,
      options: families.map((item) => ({ id: item, label: familyName[item] })),
    },
    {
      key: 'source',
      label: 'Source',
      single: true,
      options: [
        { id: 'bambu', label: 'Bambu Lab' },
        { id: 'manual', label: 'Edited here' },
      ],
    },
  ];
  const columns: Column<PrinterErrorCode>[] = [
    { key: 'code', header: 'Code', render: (entry) => <code>{entry.code}</code> },
    { key: 'family', header: 'Family', render: (entry) => familyName[entry.sourceFamily] },
    { key: 'title', header: 'Meaning', render: (entry) => entry.title },
    {
      key: 'description',
      header: 'What to do',
      render: (entry) => entry.description || <span className="mj-secondary">—</span>,
    },
    {
      key: 'link',
      header: 'Link',
      render: (entry) => {
        const href = safeLink(entry.link);
        return href ? (
          <CarbonLink href={href} target="_blank" rel="noopener noreferrer" size="sm">
            Read more
          </CarbonLink>
        ) : (
          <span className="mj-secondary">{entry.sourceFamily === 'hms' ? 'Bambu wiki' : '—'}</span>
        );
      },
    },
    {
      key: 'source',
      header: 'Source',
      render: (entry) =>
        entry.source === 'bambu' ? (
          <Tag type="blue" size="sm">
            Bambu Lab
          </Tag>
        ) : (
          <Tag type="gray" size="sm">
            Edited here
          </Tag>
        ),
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: 'Actions',
            render: (entry: PrinterErrorCode) => (
              <OverflowMenu
                aria-label={`Actions for ${entry.code}`}
                iconDescription={`Actions for ${entry.code}`}
                flipped
                size="sm"
              >
                <OverflowMenuItem itemText="Edit" onClick={() => setDialog({ entry })} />
                <OverflowMenuItem itemText="Delete" isDelete onClick={() => setRemoving(entry)} />
              </OverflowMenu>
            ),
          },
        ]
      : []),
  ];
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
        {(page) => (
          <DirectoryTable
            mode="server"
            id="catalog"
            urlPrefix="catalog-"
            label="Printer error catalog"
            columns={columns}
            rows={page.items}
            total={page.total}
            isEmptyDataset={page.total === 0 && !search && !family && !source}
            filterCategories={filterCategories}
            switcher={switcher}
            toolbarAction={
              canManage ? (
                <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setDialog({})}>
                  Add code
                </Button>
              ) : undefined
            }
            empty={{
              title: 'No error codes recorded',
              description: 'Codes without a meaning here show only the code and, for HMS, the Bambu wiki link.',
            }}
          />
        )}
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
