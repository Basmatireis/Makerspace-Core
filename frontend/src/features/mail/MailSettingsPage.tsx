import { Button, Checkbox, Form, InlineNotification, PasswordInput, Select, SelectItem, Stack, TextInput, Tile } from '@carbon/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { getMailConfiguration, updateMailConfiguration } from '../../api/generated/mail/mail';
import type { UpdateMailConfigurationRequest } from '../../api/generated/models';
import { useSecretMutation } from '../../api/use-secret-mutation';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';

type FormValues = Omit<UpdateMailConfigurationRequest, 'expectedVersion'>;

export function MailSettingsPage() {
  const client = useQueryClient();
  const configuration = useQuery({ queryKey: ['mail', 'configuration'], queryFn: ({ signal }) => getMailConfiguration({ signal }) });
  const form = useForm<FormValues>({ defaultValues: { enabled: false, host: '', port: 587, tlsMode: 'starttls', username: '', password: '', fromAddress: '', fromName: '', baseUrl: window.location.origin } });
  useEffect(() => {
    if (!configuration.data) return;
    form.reset({ enabled: configuration.data.enabled, host: configuration.data.host, port: configuration.data.port, tlsMode: configuration.data.tlsMode, username: configuration.data.username, password: '', fromAddress: configuration.data.fromAddress, fromName: configuration.data.fromName, baseUrl: configuration.data.baseUrl || window.location.origin });
  }, [configuration.data, form]);
  const mutation = useSecretMutation((values: FormValues) => updateMailConfiguration({ ...values, port: Number(values.port), expectedVersion: configuration.data!.version }), { onSuccess: async (updated) => { form.reset({ enabled: updated.enabled, host: updated.host, port: updated.port, tlsMode: updated.tlsMode, username: updated.username, password: '', fromAddress: updated.fromAddress, fromName: updated.fromName, baseUrl: updated.baseUrl }); await client.invalidateQueries({ queryKey: ['mail', 'configuration'] }); } });
  const submit = form.handleSubmit(async (values) => { try { await mutation.mutateAsync(values); } catch { /* rendered below */ } });
  return <Stack gap={7}>
    <PageHeader title="Email delivery" breadcrumbs={[{ label: 'Settings', to: '/settings' }]} description="Configure transactional SMTP delivery. Passwords are encrypted and never returned by the API." />
    {configuration.isPending && <InlineLoadingState label="Loading email configuration" />}
    {configuration.isError && <ErrorState title="Unable to load email configuration" message="Check your permission and connection." onRetry={() => void configuration.refetch()} />}
    {configuration.data && <Tile><Form onSubmit={submit}><Stack gap={5}>
      {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Configuration not saved" subtitle="Review the SMTP and sender values, then try again." />}
      {mutation.isSuccess && <InlineNotification kind="success" lowContrast hideCloseButton title="Email configuration saved" subtitle="New invitations and recovery messages use this configuration immediately." />}
      <Checkbox id="mail-enabled" labelText="Enable email delivery" checked={form.watch('enabled')} onChange={(_, data) => form.setValue('enabled', data.checked, { shouldDirty: true })} />
      <Select id="mail-provider" labelText="Provider" value="smtp" disabled><SelectItem value="smtp" text="SMTP" /></Select>
      <TextInput id="mail-host" labelText="SMTP host" {...form.register('host')} />
      <TextInput id="mail-port" type="number" min={1} max={65535} labelText="SMTP port" {...form.register('port', { valueAsNumber: true })} />
      <Select id="mail-tls" labelText="TLS mode" {...form.register('tlsMode')}><SelectItem value="starttls" text="STARTTLS" /><SelectItem value="tls" text="Implicit TLS" /><SelectItem value="none" text="None (development only)" /></Select>
      <TextInput id="mail-username" labelText="SMTP username" {...form.register('username')} />
      <PasswordInput id="mail-password" labelText="SMTP password" helperText={configuration.data.passwordConfigured ? 'Leave empty to retain the stored password.' : 'No password is currently configured.'} autoComplete="new-password" {...form.register('password')} />
      <TextInput id="mail-from-address" type="email" labelText="From address" {...form.register('fromAddress')} />
      <TextInput id="mail-from-name" labelText="From name" {...form.register('fromName')} />
      <TextInput id="mail-base-url" type="url" labelText="Public application URL" helperText="Used in invitation and recovery links, without a trailing path." {...form.register('baseUrl')} />
      {!form.watch('enabled') && <InlineNotification kind="info" lowContrast hideCloseButton title="Manual-link mode" subtitle="Authorized administrators can generate one-time invitation, password-reset, and PIN-setup links from a person’s authentication actions." />}
      <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save email configuration'}</Button>
    </Stack></Form></Tile>}
  </Stack>;
}
