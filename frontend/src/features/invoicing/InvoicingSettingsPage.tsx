import { Button, Form, InlineNotification, Stack, TextArea, TextInput, Tile, Toggle, Checkbox } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  previewWiRefDeliveryMail,
  previewWiRefDeliveryPdf,
  sendWiRefDeliveryTestMail,
  updateWiRefDeliverySettings,
} from '../../api/generated/external-invoicing/external-invoicing';
import type { WiRefDeliverySettings, WiRefTemplateFields } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { wirefSettingsKey, wirefSettingsQuery } from './queries';

type FormValues = WiRefTemplateFields & {
  enabled: boolean;
  recipientEmail: string;
  /** One address per line; the API takes a list. */
  ccText: string;
};

const MAX_CC = 5;

function toValues(settings: WiRefDeliverySettings): FormValues {
  return {
    enabled: settings.enabled,
    recipientEmail: settings.recipientEmail,
    ccText: settings.ccEmails.join('\n'),
    mailSubject: settings.mailSubject,
    mailIntro: settings.mailIntro,
    mailClosing: settings.mailClosing,
    pdfTitle: settings.pdfTitle,
    pdfIntro: settings.pdfIntro,
    pdfClosing: settings.pdfClosing,
    showContactPerson: settings.showContactPerson,
    showApprover: settings.showApprover,
    showPurchaseOrder: settings.showPurchaseOrder,
    showServicePeriod: settings.showServicePeriod,
    showServiceDescription: settings.showServiceDescription,
  };
}

function parseCc(text: string): string[] {
  return text
    .split(/[\n,;]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function templatesOf(values: FormValues): WiRefTemplateFields {
  return {
    mailSubject: values.mailSubject,
    mailIntro: values.mailIntro,
    mailClosing: values.mailClosing,
    pdfTitle: values.pdfTitle,
    pdfIntro: values.pdfIntro,
    pdfClosing: values.pdfClosing,
    showContactPerson: values.showContactPerson,
    showApprover: values.showApprover,
    showPurchaseOrder: values.showPurchaseOrder,
    showServicePeriod: values.showServicePeriod,
    showServiceDescription: values.showServiceDescription,
  };
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const testFailure: Record<string, string> = {
  mail_disabled: 'Email delivery is switched off under Settings › Email delivery.',
  send_failed: 'The mail server did not accept the message.',
  render_failed: 'The PDF could not be created.',
};

function SettingsForm({ settings }: { settings: WiRefDeliverySettings }) {
  const client = useQueryClient();
  const form = useForm<FormValues>({ values: toValues(settings) });
  const { register, watch, setValue } = form;
  const dirty = form.formState.isDirty;
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewSubject, setPreviewSubject] = useState('');

  const save = useMutation({
    mutationFn: (values: FormValues) =>
      updateWiRefDeliverySettings({
        ...templatesOf(values),
        enabled: values.enabled,
        recipientEmail: values.recipientEmail.trim(),
        ccEmails: parseCc(values.ccText),
        expectedVersion: settings.version,
      }),
    onSuccess: async (updated) => {
      client.setQueryData(wirefSettingsKey, updated);
      form.reset(toValues(updated));
    },
  });
  const preview = useMutation({
    mutationFn: () => previewWiRefDeliveryMail(templatesOf(form.getValues())),
    onSuccess: (result) => {
      setPreviewHtml(result.html);
      setPreviewSubject(result.subject);
    },
  });
  const pdf = useMutation({
    mutationFn: () => previewWiRefDeliveryPdf(templatesOf(form.getValues())),
    onSuccess: (blob) => downloadBlob('wiref-sample.pdf', blob),
  });
  const testMail = useMutation({ mutationFn: () => sendWiRefDeliveryTestMail() });

  const submit = form.handleSubmit(async (values) => {
    if (parseCc(values.ccText).length > MAX_CC) {
      form.setError('ccText', { message: `At most ${MAX_CC} CC addresses.` });
      return;
    }
    try {
      await save.mutateAsync(values);
    } catch {
      /* rendered below */
    }
  });

  const toggle = (name: keyof FormValues, label: string) => (
    <Checkbox
      id={`wiref-${name}`}
      labelText={label}
      checked={Boolean(watch(name))}
      onChange={(_, data) => setValue(name, data.checked, { shouldDirty: true })}
    />
  );

  return (
    <Form onSubmit={submit}>
      <Stack gap={6}>
        {save.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Settings not saved"
            subtitle={save.error.message}
          />
        )}
        {save.isSuccess && !dirty && (
          <InlineNotification
            kind="success"
            lowContrast
            hideCloseButton
            title="Settings saved"
            subtitle="Requests forwarded from now on use them."
          />
        )}
        <Tile>
          <Stack gap={5}>
            <h2 className="mj-section-title">Recipient</h2>
            <Toggle
              id="wiref-enabled"
              labelText="Send approved requests to wiRef"
              labelA="Off"
              labelB="On"
              toggled={watch('enabled')}
              onToggle={(checked) => setValue('enabled', checked, { shouldDirty: true })}
            />
            <TextInput
              id="wiref-recipient"
              type="email"
              labelText="wiRef email address"
              helperText="Required to switch sending on."
              {...register('recipientEmail')}
            />
            <TextArea
              id="wiref-cc"
              labelText="CC addresses"
              helperText={`Optional, one per line, at most ${MAX_CC}.`}
              rows={3}
              invalid={Boolean(form.formState.errors.ccText)}
              invalidText={form.formState.errors.ccText?.message}
              {...register('ccText')}
            />
          </Stack>
        </Tile>
        <Tile>
          <Stack gap={5}>
            <h2 className="mj-section-title">Mail</h2>
            <TextInput id="wiref-mail-subject" labelText="Subject" maxLength={200} {...register('mailSubject')} />
            <TextArea
              id="wiref-mail-intro"
              labelText="Introduction"
              helperText="Blank lines start a new paragraph."
              rows={4}
              maxLength={2000}
              {...register('mailIntro')}
            />
            <TextArea
              id="wiref-mail-closing"
              labelText="Closing text"
              rows={3}
              maxLength={2000}
              {...register('mailClosing')}
            />
          </Stack>
        </Tile>
        <Tile>
          <Stack gap={5}>
            <h2 className="mj-section-title">PDF attachment</h2>
            <TextInput id="wiref-pdf-title" labelText="Title" maxLength={200} {...register('pdfTitle')} />
            <TextArea
              id="wiref-pdf-intro"
              labelText="Introduction"
              rows={3}
              maxLength={2000}
              {...register('pdfIntro')}
            />
            <TextArea
              id="wiref-pdf-closing"
              labelText="Closing text"
              helperText="Shown below the items."
              rows={3}
              maxLength={2000}
              {...register('pdfClosing')}
            />
          </Stack>
        </Tile>
        <Tile>
          <Stack gap={4}>
            <h2 className="mj-section-title">Placeholders</h2>
            <p className="mj-secondary">
              Write these into any text above. They are replaced when the mail is sent; anything else in double braces
              is rejected. Placeholders of fields that are switched off stay empty.
            </p>
            <dl className="mj-facts">
              {settings.placeholders.map((placeholder) => (
                <div key={placeholder.token}>
                  <dt>
                    <code>{placeholder.token}</code>
                  </dt>
                  <dd>{placeholder.description}</dd>
                </div>
              ))}
            </dl>
          </Stack>
        </Tile>
        <Tile>
          <Stack gap={4}>
            <h2 className="mj-section-title">Optional fields</h2>
            <p className="mj-secondary">Recipient, address, items and totals are always included.</p>
            {toggle('showContactPerson', 'Contact person')}
            {toggle('showPurchaseOrder', 'Purchase order reference')}
            {toggle('showServicePeriod', 'Service period')}
            {toggle('showServiceDescription', 'Service description')}
            {toggle('showApprover', 'Approver name')}
          </Stack>
        </Tile>
        <div className="mj-inline">
          <Button type="submit" kind="primary" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save settings'}
          </Button>
          <Button kind="ghost" disabled={!dirty || save.isPending} onClick={() => form.reset()}>
            Discard changes
          </Button>
        </div>
        <Tile>
          <Stack gap={5}>
            <h2 className="mj-section-title">Preview and test</h2>
            <p className="mj-secondary">
              Previews use the texts above, also unsaved ones, with fictitious invoice data. The test mail goes to the
              saved addresses.
            </p>
            <div className="mj-inline">
              <Button kind="tertiary" disabled={preview.isPending} onClick={() => preview.mutate()}>
                Preview mail
              </Button>
              <Button kind="tertiary" disabled={pdf.isPending} onClick={() => pdf.mutate()}>
                Download sample PDF
              </Button>
              <Button
                kind="tertiary"
                disabled={testMail.isPending || dirty || !settings.recipientEmail}
                onClick={() => testMail.mutate()}
              >
                {testMail.isPending ? 'Sending…' : 'Send test mail'}
              </Button>
            </div>
            {(preview.isError || pdf.isError) && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Preview not available"
                subtitle={(preview.error ?? pdf.error)?.message}
              />
            )}
            {testMail.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Test mail not sent"
                subtitle={testMail.error.message}
              />
            )}
            {testMail.data?.status === 'sent' && (
              <InlineNotification
                kind="success"
                lowContrast
                hideCloseButton
                title="Test mail sent"
                subtitle="Check the inbox of the wiRef address and the CC addresses."
              />
            )}
            {testMail.data?.status === 'failed' && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Test mail not sent"
                subtitle={testFailure[testMail.data.failureCode] ?? 'Sending failed.'}
              />
            )}
            {previewHtml !== null && (
              <Stack gap={3}>
                <p>
                  <strong>Subject:</strong> {previewSubject}
                </p>
                {/* An empty sandbox attribute disables scripts, forms and navigation for the rendered mail. */}
                <iframe
                  title="Mail preview"
                  sandbox=""
                  srcDoc={previewHtml}
                  style={{ width: '100%', height: '32rem', border: '1px solid #e0e0e0' }}
                />
              </Stack>
            )}
          </Stack>
        </Tile>
      </Stack>
    </Form>
  );
}

export function InvoicingSettingsPage() {
  const settings = useQuery(wirefSettingsQuery());
  return (
    <PageShell
      title="Sales & invoicing"
      breadcrumbs={[{ label: 'Settings', to: '/settings' }]}
      description="Once an approver forwards an invoice request, Core mails the invoice data with a PDF to the university accounting office (wiRef)."
    >
      {settings.isPending && <InlineLoadingState label="Loading invoicing settings" />}
      {settings.isError && (
        <ErrorState
          title="Unable to load invoicing settings"
          message="Check your permission and connection."
          onRetry={() => void settings.refetch()}
        />
      )}
      {settings.data && <SettingsForm settings={settings.data} />}
    </PageShell>
  );
}
