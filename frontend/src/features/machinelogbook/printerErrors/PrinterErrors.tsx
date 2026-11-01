import { useState } from 'react';
import {
  Accordion,
  AccordionItem,
  Button,
  Link as CarbonLink,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clearPrinterErrors } from '../../../api/generated/printing/printing';
import type { PrinterErrorOccurrence, PrinterLiveStatusError } from '../../../api/generated/models';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { machineLogbookKeys, printerErrorsQuery } from '../queries';
import { formatDateTime } from '../shared/format';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { relativeAge } from '../components/connectorDiagnostics/diagnosticsShared';
import { ErrorCodeModal, type ErrorCodeDraft } from './ErrorCodeModal';
import { isNotice, safeLink, severityTag } from './printerErrorText';

type Described = {
  sourceFamily: 'print' | 'hms';
  code: string;
  title?: string | null;
  link?: string | null;
  description?: string | null;
};

function ReadMore({ link }: { link: string | null | undefined }) {
  const href = safeLink(link);
  if (!href) return null;
  return (
    <CarbonLink href={href} target="_blank" rel="noopener noreferrer" size="sm">
      Read more
    </CarbonLink>
  );
}

function ErrorMeaning({
  error,
  canManage,
  onAdd,
}: {
  error: Described;
  canManage: boolean;
  onAdd: (draft: ErrorCodeDraft) => void;
}) {
  return (
    <>
      {error.title ? (
        <span>{error.title}</span>
      ) : (
        <>
          <span className="mj-secondary">No meaning recorded</span>
          {canManage && (
            <Button
              kind="ghost"
              size="sm"
              aria-label={`Add meaning for ${error.code}`}
              onClick={() =>
                onAdd({
                  sourceFamily: error.sourceFamily,
                  code: error.code,
                  title: '',
                  description: error.description ?? '',
                  link: null,
                })
              }
            >
              Add meaning
            </Button>
          )}
        </>
      )}
    </>
  );
}

/** The errors the printer reports right now; common and info notices stay behind a toggle. */
export function LivePrinterErrors({ errors }: { errors: PrinterLiveStatusError[] }) {
  const canManage = useCan()('machines.manage');
  const [showNotices, setShowNotices] = useState(false);
  const [draft, setDraft] = useState<ErrorCodeDraft | null>(null);
  const notices = errors.filter(isNotice);
  const problems = errors.filter((error) => !isNotice(error));
  const visible = showNotices ? errors : problems;
  return (
    <Stack gap={3}>
      {errors.length === 0 && <p className="mj-secondary">No errors reported.</p>}
      {errors.length > 0 && problems.length === 0 && !showNotices && (
        <p className="mj-secondary">No errors, only notices.</p>
      )}
      {visible.map((error) => {
        const tag = severityTag(error);
        return (
          <span key={`${error.sourceFamily}-${error.code}`} className="mj-inline">
            <Tag size="sm" type={tag.type}>
              {tag.label}
            </Tag>
            <code>{error.code}</code>
            <ErrorMeaning error={error} canManage={canManage} onAdd={setDraft} />
            <ReadMore link={error.link} />
            {error.observedAt && <span className="mj-secondary">{relativeAge(error.observedAt)}</span>}
          </span>
        );
      })}
      {notices.length > 0 && (
        <div>
          <Button kind="ghost" size="sm" onClick={() => setShowNotices((shown) => !shown)}>
            {showNotices ? `Hide notices (${notices.length})` : `Show notices (${notices.length})`}
          </Button>
        </div>
      )}
      {draft && <ErrorCodeModal draft={draft} fixedKey onClose={() => setDraft(null)} />}
    </Stack>
  );
}

function HistoryRow({
  item,
  onAdd,
  canManage,
}: {
  item: PrinterErrorOccurrence;
  canManage: boolean;
  onAdd: (d: ErrorCodeDraft) => void;
}) {
  const tag = severityTag(item);
  return (
    <TableRow>
      <TableCell>
        <code>{item.code}</code>
      </TableCell>
      <TableCell>
        <Tag size="sm" type={tag.type}>
          {tag.label}
        </Tag>
      </TableCell>
      <TableCell>
        <span className="mj-inline">
          <ErrorMeaning error={item} canManage={canManage} onAdd={onAdd} />
          <ReadMore link={item.link} />
        </span>
      </TableCell>
      <TableCell>{formatDateTime(item.firstObservedAt)}</TableCell>
      <TableCell>{formatDateTime(item.lastObservedAt)}</TableCell>
      <TableCell>
        {item.resolvedAt ? (
          formatDateTime(item.resolvedAt)
        ) : (
          <Tag size="sm" type="red">
            Open
          </Tag>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Open errors first, then the resolved ones of the last 30 days; machines.manage may clear the history. */
export function PrinterErrorHistory({ machineId, active }: { machineId: string; active: boolean }) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const canRead = can('machines.read');
  const canManage = can('machines.manage');
  const [confirm, setConfirm] = useState(false);
  const [draft, setDraft] = useState<ErrorCodeDraft | null>(null);
  const history = useQuery({ ...printerErrorsQuery(machineId), enabled: active && canRead });
  const clear = useMutation({
    mutationFn: () => clearPrinterErrors(machineId),
    onSuccess: async () => {
      notify({ kind: 'success', title: 'Error history cleared' });
      setConfirm(false);
      await client.invalidateQueries({ queryKey: machineLogbookKeys.printerErrors(machineId) });
    },
  });
  if (!canRead) return null;
  const items = history.data?.items ?? [];
  return (
    <div>
      <h4 className="mj-group-title">Error history</h4>
      <Accordion>
        <AccordionItem title={history.isSuccess ? `Error history (${items.length})` : 'Error history'}>
          {history.isError ? (
            <p className="mj-secondary">The error history could not be loaded.</p>
          ) : items.length === 0 ? (
            <p className="mj-secondary">{history.isPending ? 'Loading…' : 'No errors in the last 30 days.'}</p>
          ) : (
            <Stack gap={4}>
              <Table size="sm" aria-label="Printer error history">
                <TableHead>
                  <TableRow>
                    <TableHeader>Code</TableHeader>
                    <TableHeader>Severity</TableHeader>
                    <TableHeader>Meaning</TableHeader>
                    <TableHeader>First seen</TableHeader>
                    <TableHeader>Last seen</TableHeader>
                    <TableHeader>Resolved</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((item) => (
                    <HistoryRow key={item.id} item={item} canManage={canManage} onAdd={setDraft} />
                  ))}
                </TableBody>
              </Table>
              {canManage && (
                <div>
                  <Button kind="danger--tertiary" size="sm" onClick={() => setConfirm(true)}>
                    Clear history
                  </Button>
                </div>
              )}
            </Stack>
          )}
        </AccordionItem>
      </Accordion>
      <DestructiveActionDialog
        open={confirm}
        title="Clear error history?"
        confirmLabel="Clear history"
        pending={clear.isPending}
        error={clear.isError ? 'The history could not be cleared. Try again.' : undefined}
        onConfirm={() => clear.mutate()}
        onClose={() => setConfirm(false)}
      >
        <p>
          Open errors are marked resolved and the recorded history of this printer is removed. The printer reports
          errors that still exist again.
        </p>
      </DestructiveActionDialog>
      {draft && <ErrorCodeModal draft={draft} fixedKey onClose={() => setDraft(null)} />}
    </div>
  );
}
