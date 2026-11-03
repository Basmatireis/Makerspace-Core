/* eslint-disable react-refresh/only-export-components -- the dialog and the request it sends belong together */
import { useState } from 'react';
import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { exportCashbook } from '../../api/generated/payments/payments';
import type { ExportCashbookContents, ExportCashbookFormat, ExportCashbookParams } from '../../api/generated/models';
import { DateInput } from '../../app/DateInput';
import { dateInAppTimeZone } from '../../app/dateTime';
import { saveBlob } from '../configtransfer/helpers';
import { useNotify } from '../machinelogbook/shared/toasts';
import type { Period } from './period';

export type ExportValues = { from: string; to: string; contents: ExportCashbookContents; format: ExportCashbookFormat };

/** The query of the export and the file name the server gives it (`cashbook-cash-register-2026-10-01-2026-10-31.pdf`). */
export function cashbookExport(values: ExportValues): { params: ExportCashbookParams; filename: string } {
  return {
    params: { from: values.from, to: values.to, contents: values.contents, format: values.format },
    filename: `cashbook-${values.contents.replace('_', '-')}-${values.from}-${values.to}.${values.format}`,
  };
}

/** "From must not be after Through" and missing days; null when the range can be exported. */
export function exportRangeError(from: string, to: string): { from?: string; to?: string } | null {
  if (!from || !to)
    return { ...(from ? {} : { from: 'Choose the first day' }), ...(to ? {} : { to: 'Choose the last day' }) };
  return from > to ? { from: 'From must not be after Through' } : null;
}

const option = (title: string, helper: string) => (
  <span className="sales-option">
    <span>{title}</span>
    <span className="sales-secondary">{helper}</span>
  </span>
);

/**
 * Downloads the cashbook of whole days as the server renders it: the HTU Kassabuch sheet as PDF, or CSV for Excel,
 * with the cash register only or every payment.
 */
export function ExportCashbookModal({
  period,
  contents: initialContents,
  onClose,
}: {
  period: Period;
  contents: ExportCashbookContents;
  onClose: () => void;
}) {
  const notify = useNotify();
  const today = dateInAppTimeZone(new Date());
  const [values, setValues] = useState<ExportValues>({
    from: period.from ?? `${today.slice(0, 8)}01`,
    to: period.to ?? today,
    contents: initialContents,
    format: 'pdf',
  });
  const [tried, setTried] = useState(false);
  const rangeError = exportRangeError(values.from, values.to);
  const patch = (next: Partial<ExportValues>) => setValues((current) => ({ ...current, ...next }));
  const download = useMutation({
    mutationFn: async (input: ExportValues) => {
      const request = cashbookExport(input);
      // The generated client hands the attachment over as a Blob; the browser saves it under the server's name.
      const blob = await exportCashbook(request.params);
      return { blob, filename: request.filename };
    },
    onSuccess: ({ blob, filename }) => {
      saveBlob(blob, filename);
      notify({ kind: 'success', title: 'Cashbook downloaded', subtitle: filename });
      onClose();
    },
  });

  return (
    <Modal
      open
      size="md"
      modalLabel="Cashbook"
      modalHeading="Export cashbook"
      primaryButtonText={download.isPending ? 'Preparing…' : values.format === 'pdf' ? 'Download PDF' : 'Download CSV'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={download.isPending}
      onRequestClose={() => {
        if (!download.isPending) onClose();
      }}
      onRequestSubmit={() => {
        setTried(true);
        if (!rangeError) download.mutate(values);
      }}
    >
      <Stack gap={6}>
        <div className="sales-form-grid">
          <DateInput
            id="export-from"
            labelText="From"
            value={values.from}
            onChange={(from) => patch({ from })}
            invalid={tried && !!rangeError?.from}
            invalidText={rangeError?.from}
            required
          />
          <DateInput
            id="export-to"
            labelText="Through"
            value={values.to}
            onChange={(to) => patch({ to })}
            invalid={tried && !!rangeError?.to}
            invalidText={rangeError?.to}
            required
          />
        </div>
        <RadioButtonGroup
          legendText="Contents"
          name="export-contents"
          orientation="vertical"
          valueSelected={values.contents}
          onChange={(value) => patch({ contents: value as ExportCashbookContents })}
        >
          <RadioButton
            id="export-contents-cash"
            value="cash_register"
            labelText={option(
              'Cash register only',
              'Cash receipts, refunds, withdrawals and deposits with running balance; replaces the handwritten cashbook.',
            )}
          />
          <RadioButton
            id="export-contents-all"
            value="all_payments"
            labelText={option('All payments', 'Also card and wiRef entries, no balance column.')}
          />
        </RadioButtonGroup>
        <RadioButtonGroup
          legendText="Format"
          name="export-format"
          orientation="vertical"
          valueSelected={values.format}
          onChange={(value) => patch({ format: value as ExportCashbookFormat })}
        >
          <RadioButton
            id="export-format-pdf"
            value="pdf"
            labelText={option(
              'PDF',
              'The HTU Kassabuch sheet: Nr., Datum, Kassierer*in, Text, Einnahme, Ausgabe, with the balance carried forward and a signature field.',
            )}
          />
          <RadioButton
            id="export-format-csv"
            value="csv"
            labelText={option('CSV for Excel', 'Semicolon-separated, decimal comma, UTF-8 BOM.')}
          />
        </RadioButtonGroup>
        {download.error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="The cashbook could not be exported"
            subtitle={download.error.message}
          />
        )}
      </Stack>
    </Modal>
  );
}
