import { InlineNotification, Modal, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { putPrinterErrorCode } from '../../../api/generated/printing/printing';
import type { PrinterErrorCodeSourceFamily } from '../../../api/generated/models';
import { machineLogbookKeys } from '../queries';
import { useNotify } from '../shared/toasts';

export type ErrorCodeDraft = {
  sourceFamily: PrinterErrorCodeSourceFamily;
  code: string;
  title: string;
  description: string;
  link: string | null;
};

type FormValues = {
  sourceFamily: PrinterErrorCodeSourceFamily;
  code: string;
  title: string;
  description: string;
  link: string;
};

const familyLabel: Record<PrinterErrorCodeSourceFamily, string> = {
  hms: 'HMS (health management)',
  print: 'Print error',
};
// The code ends up in the URL path, so only characters that need no escaping are accepted.
const codePattern = /^[A-Za-z0-9._-]+$/;

/**
 * Records what a printer error code means. `fixedKey` locks family and code (editing an entry, or adding a meaning for
 * a code the printer reported); without it both are entered.
 */
export function ErrorCodeModal({
  draft,
  fixedKey,
  onClose,
}: {
  draft: ErrorCodeDraft;
  fixedKey: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const form = useForm<FormValues>({
    mode: 'onChange',
    defaultValues: { ...draft, link: draft.link ?? '' },
  });
  const { errors, isValid } = form.formState;
  const save = useMutation({
    mutationFn: (values: FormValues) =>
      putPrinterErrorCode(values.sourceFamily, values.code.trim().toUpperCase(), {
        title: values.title.trim(),
        description: values.description.trim(),
        link: values.link.trim() || null,
      }),
    onSuccess: async (saved) => {
      notify({ kind: 'success', title: 'Meaning saved', subtitle: saved.code });
      onClose();
      // Titles and links also appear in the live status, the history and run events.
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
  });
  const submit = form.handleSubmit((values) => {
    if (!save.isPending) save.mutate(values);
  });
  return (
    <Modal
      open
      size="sm"
      modalHeading={fixedKey ? 'Printer error meaning' : 'Add error code'}
      primaryButtonText={save.isPending ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!isValid || save.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!save.isPending) onClose();
      }}
      onRequestSubmit={() => void submit()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap={5}>
          <Select
            id="error-code-family"
            labelText="Source family"
            disabled={fixedKey}
            helperText="HMS codes look like 0300-0D00-0001-0001, print errors like 07FF8003."
            {...form.register('sourceFamily')}
          >
            {(Object.keys(familyLabel) as PrinterErrorCodeSourceFamily[]).map((family) => (
              <SelectItem key={family} value={family} text={familyLabel[family]} />
            ))}
          </Select>
          <TextInput
            id="error-code-code"
            labelText="Code"
            autoComplete="off"
            disabled={fixedKey}
            invalid={Boolean(errors.code)}
            invalidText="Enter the code as the printer shows it, up to 120 letters, digits, dots, dashes or underscores."
            {...form.register('code', { required: true, maxLength: 120, pattern: codePattern })}
          />
          <TextInput
            id="error-code-title"
            labelText="Meaning"
            helperText="What the code means, in a few words. Saving makes the meaning your own: the daily fetch from Bambu Lab will not change it anymore."
            autoComplete="off"
            data-modal-primary-focus
            invalid={Boolean(errors.title)}
            invalidText="Enter a meaning of up to 160 characters."
            {...form.register('title', { required: true, maxLength: 160, validate: (value) => value.trim() !== '' })}
          />
          <TextArea
            id="error-code-description"
            labelText="What to do (optional)"
            rows={3}
            invalid={Boolean(errors.description)}
            invalidText="Use at most 2000 characters."
            {...form.register('description', { maxLength: 2000 })}
          />
          <TextInput
            id="error-code-link"
            labelText="Link (optional)"
            helperText="An https link with more. Empty uses the Bambu wiki page for HMS codes."
            autoComplete="off"
            invalid={Boolean(errors.link)}
            invalidText="Enter an https link of up to 500 characters."
            {...form.register('link', {
              maxLength: 500,
              validate: (value) => value.trim() === '' || /^https:\/\/\S+$/i.test(value.trim()),
            })}
          />
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Meaning not saved"
              subtitle="Check the entries and try again."
            />
          )}
        </Stack>
      </form>
    </Modal>
  );
}
