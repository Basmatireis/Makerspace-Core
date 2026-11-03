import { useState } from 'react';
import { Button, InlineNotification, Tag } from '@carbon/react';
import { Add, Renew } from '@carbon/icons-react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deletePrinterErrorCode, syncPrinterErrorCodes } from '../../../api/generated/printing/printing';
import type {
  ListPrinterErrorCodesParams,
  PrinterErrorCode,
  PrinterErrorCodeSourceFamily,
} from '../../../api/generated/models';
import { StackCard } from '../../../app/components/CardList';
import { FuzzySelectField, type SelectOption } from '../../../app/components/FuzzyComboBox';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { ErrorCodeModal, type ErrorCodeDraft } from '../printerErrors/ErrorCodeModal';
import {
  codeComponent,
  codeComponentId,
  codeSeverity,
  printerComponents,
  severityLabel,
} from '../printerErrors/printerErrorText';
import { allPrinterErrorCodesQuery } from '../machinesQueries';
import { machineLogbookKeys, printerErrorCodesQuery } from '../queries';
import { DirectoryTable, useServerTableState, type Column } from '../shared/DirectoryTable';
import { formatRelative } from '../shared/format';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { SummaryList } from './SummaryList';

const familyName: Record<PrinterErrorCodeSourceFamily, string> = { hms: 'HMS', print: 'Print error' };
const familyOptions: SelectOption[] = [
  { id: 'hms', label: 'HMS' },
  { id: 'print', label: 'Print error' },
];
const sourceOptions: SelectOption[] = [
  { id: 'bambu', label: 'Bambu Lab' },
  { id: 'manual', label: 'Written here' },
];
const componentOptions: SelectOption[] = printerComponents.map(({ id, label }) => ({ id, label }));
const emptyDraft: ErrorCodeDraft = { sourceFamily: 'hms', code: '', title: '', description: '', link: null };
const PREFIX = 'catalog-';

type Dialog = { entry?: PrinterErrorCode } | null;

const severityTagType = { fatal: 'red', serious: 'red', common: 'outline', info: 'blue' } as const;

const columns: Column<PrinterErrorCode>[] = [
  { key: 'code', header: 'Code', render: (entry) => <code className="mj-code">{entry.code}</code> },
  {
    key: 'component',
    header: 'Component',
    narrow: true,
    render: (entry) => codeComponent(entry.code) ?? <span className="mj-secondary">—</span>,
  },
  { key: 'family', header: 'Family', narrow: true, render: (entry) => familyName[entry.sourceFamily] },
  {
    key: 'severity',
    header: 'Severity',
    narrow: true,
    render: (entry) => {
      const severity = codeSeverity(entry.sourceFamily, entry.code);
      return severity ? (
        <Tag size="sm" type={severityTagType[severity]}>
          {severityLabel[severity]}
        </Tag>
      ) : (
        <span className="mj-secondary">—</span>
      );
    },
  },
  {
    key: 'title',
    header: 'Meaning',
    className: 'mj-col-wide',
    render: (entry) => (
      <div className="mj-cell-stack">
        <span>{entry.title}</span>
        {entry.description && <span className="mj-secondary">{entry.description}</span>}
      </div>
    ),
  },
];

/**
 * The makerspace's printer error catalog: meanings fetched from Bambu Lab and written here, filtered by family,
 * component and source. A row opens the meaning for editing.
 */
export function ErrorCatalogTable() {
  const canManage = useCan()('machines.manage');
  const client = useQueryClient();
  const notify = useNotify();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [removing, setRemoving] = useState<PrinterErrorCode | null>(null);
  const table = useServerTableState(PREFIX, { key: 'code', direction: 'ASC' });
  const { url, search } = table;
  const family = familyOptions.find((option) => option.id === url.get('family'))?.id as
    PrinterErrorCodeSourceFamily | undefined;
  const source = sourceOptions.find((option) => option.id === url.get('source'))?.id as 'bambu' | 'manual' | undefined;
  const component = url.get('component') || null;
  const filtered = Boolean(search || family || source || component);
  const params: ListPrinterErrorCodesParams = {
    search: search || undefined,
    sourceFamily: family,
    source,
    page: table.page,
    pageSize: table.pageSize,
  };
  // The server knows no component, so a component filter loads the matching catalog and pages it here.
  const paged = useQuery({
    ...printerErrorCodesQuery(params),
    placeholderData: keepPreviousData,
    enabled: !component,
  });
  const whole = useQuery({
    ...allPrinterErrorCodesQuery({ sourceFamily: family, source }),
    enabled: Boolean(component),
  });
  const remove = useMutation({
    mutationFn: (entry: PrinterErrorCode) => deletePrinterErrorCode(entry.sourceFamily, entry.code),
    onSuccess: async (_result, entry) => {
      notify({ kind: 'success', title: 'Error code removed', subtitle: entry.code });
      setRemoving(null);
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
  });

  const filters = (
    <div className="mj-catalog-filters" role="group" aria-label="Filter the catalog">
      <FuzzySelectField
        id="catalog-family"
        titleText="Family"
        placeholder="All families"
        size="sm"
        options={familyOptions}
        value={family ?? null}
        onChange={(id) => url.set({ family: id })}
      />
      <FuzzySelectField
        id="catalog-component"
        titleText="Component"
        placeholder="All components"
        size="sm"
        options={componentOptions}
        value={component}
        onChange={(id) => url.set({ component: id })}
      />
      <FuzzySelectField
        id="catalog-source"
        titleText="Source"
        placeholder="All sources"
        size="sm"
        options={sourceOptions}
        value={source ?? null}
        onChange={(id) => url.set({ source: id })}
      />
    </div>
  );
  const common = {
    id: 'catalog',
    urlPrefix: PREFIX,
    label: 'Printer error catalog',
    columns,
    onClearFilters: () => url.clear(['family', 'component', 'source']),
    onRowClick: canManage ? (entry: PrinterErrorCode) => setDialog({ entry }) : undefined,
    toolbarAction: canManage ? (
      <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setDialog({})}>
        Add code
      </Button>
    ) : undefined,
    empty: {
      title: 'No error codes recorded',
      description: 'Codes without a meaning here show only the code and, for HMS, the Bambu wiki link.',
    },
  };

  return (
    <div className="mj-stack">
      {filters}
      {component ? (
        <QueryBoundary query={whole} errorMessage="The error catalog could not be loaded.">
          {(entries) => {
            const rows = entries.filter((entry) => codeComponentId(entry.code) === component);
            return (
              <DirectoryTable<PrinterErrorCode>
                {...common}
                rows={rows}
                totalCount={entries.length}
                searchText={(entry) => [entry.code, entry.title, entry.description].join(' ')}
                defaultSort={{ key: '', direction: 'ASC' }}
              />
            );
          }}
        </QueryBoundary>
      ) : (
        <QueryBoundary query={paged} errorMessage="The error catalog could not be loaded.">
          {(page) => (
            <DirectoryTable<PrinterErrorCode>
              {...common}
              mode="server"
              rows={page.items}
              total={page.total}
              isEmptyDataset={page.total === 0 && !filtered}
            />
          )}
        </QueryBoundary>
      )}
      {dialog && (
        <ErrorCodeModal
          key={dialog.entry?.id ?? 'new'}
          draft={dialog.entry ?? emptyDraft}
          fixedKey={Boolean(dialog.entry)}
          heading={dialog.entry ? 'Edit code meaning' : 'Add code meaning'}
          fetched={dialog.entry?.source === 'bambu'}
          onRemove={
            dialog.entry
              ? () => {
                  remove.reset();
                  setRemoving(dialog.entry ?? null);
                  setDialog(null);
                }
              : undefined
          }
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
          The recorded meaning of <code>{removing?.code}</code> is removed. A code fetched from Bambu Lab comes back
          with the next fetch; other printer errors with this code show no meaning afterwards.
        </p>
      </DestructiveActionDialog>
    </div>
  );
}

/** The automatic fetch of Bambu Lab's code list: schedule, last result and Fetch now. */
export function ErrorCodeSyncCard() {
  const canManage = useCan()('machines.manage');
  const client = useQueryClient();
  // One-row pages are enough for the totals of the catalog and of the codes written here.
  const all = useQuery(printerErrorCodesQuery({ page: 1, pageSize: 1 }));
  const manual = useQuery(printerErrorCodesQuery({ source: 'manual', page: 1, pageSize: 1 }));
  const fetchNow = useMutation({
    mutationFn: () => syncPrinterErrorCodes(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.printerErrorCodes() });
    },
  });
  const sync = all.data?.sync;
  return (
    <StackCard
      title="Code list from Bambu Lab"
      action={
        canManage ? (
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Renew}
            disabled={!sync?.enabled || fetchNow.isPending}
            onClick={() => fetchNow.mutate()}
          >
            {fetchNow.isPending ? 'Fetching…' : 'Fetch now'}
          </Button>
        ) : undefined
      }
    >
      <QueryBoundary query={all} errorMessage="The fetch status could not be loaded.">
        {(page) => (
          <SummaryList
            items={[
              { label: 'Source', value: "Bambu Lab's published HMS and print error list" },
              {
                label: 'Schedule',
                value: page.sync.enabled
                  ? 'Daily and when the API starts'
                  : 'Off · PRINTER_ERROR_CODE_SOURCE_URL is empty',
              },
              {
                label: 'Last fetched',
                value: page.sync.lastSuccessAt ? (
                  <>
                    {formatRelative(page.sync.lastSuccessAt)}{' '}
                    <span className="mj-secondary">· {page.sync.importedCount} codes</span>
                  </>
                ) : (
                  'Not fetched yet'
                ),
              },
              {
                label: 'Last error',
                value:
                  page.sync.enabled && page.sync.lastError ? (
                    <span className="mj-error-text">{page.sync.lastError}</span>
                  ) : (
                    <span className="mj-secondary">None</span>
                  ),
              },
              {
                label: 'Catalog',
                value: (
                  <>
                    {page.total} codes
                    {manual.data && (
                      <span className="mj-secondary"> · {manual.data.total} written here, never overwritten</span>
                    )}
                  </>
                ),
              },
            ]}
          />
        )}
      </QueryBoundary>
      {fetchNow.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Fetch failed"
          subtitle={fetchNow.error instanceof Error ? fetchNow.error.message : 'Try again.'}
        />
      )}
    </StackCard>
  );
}
