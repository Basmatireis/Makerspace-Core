import { Button, Checkbox, Form, InlineNotification, PasswordInput, Stack, TextArea, TextInput, Tile } from '@carbon/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { createOIDCProvider, listOIDCProviders, updateOIDCProvider } from '../../api/generated/oidc/oidc';
import type { AuthenticationAssurance, OIDCProvider } from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useSecretMutation } from '../../api/use-secret-mutation';

type Values = {
  slug: string;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  enabled: boolean;
  jitEnabled: boolean;
  mappings: string;
};

const blank: Values = { slug: '', displayName: '', issuer: '', clientId: '', clientSecret: '', enabled: false, jitEnabled: false, mappings: '' };

export function OIDCProvidersPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['oidc', 'providers'], queryFn: ({ signal }) => listOIDCProviders({ signal }) });
  const [creating, setCreating] = useState(false);
  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['oidc'] });

  return <Stack gap={7}>
    <PageHeader title="OpenID Connect" breadcrumbs={[{ label: 'Settings', to: '/settings' }]} description="Configure external sign-in, trusted assurance mappings, and optional just-in-time provisioning. Client secrets are never returned." actions={<Button onClick={() => setCreating(true)}>Add provider</Button>} />
    {query.isPending && <InlineLoadingState label="Loading identity providers" />}
    {query.isError && <ErrorState title="Unable to load identity providers" message="Check the connection and try again." onRetry={() => void query.refetch()} />}
    {creating && <ProviderForm title="Add provider" initial={blank} onCancel={() => setCreating(false)} onSaved={async () => { setCreating(false); await refresh(); }} />}
    {query.data?.items.length === 0 && !creating && <Tile><p>No OIDC providers are configured. Local password and PIN authentication remain available.</p></Tile>}
    {query.data?.items.map((provider) => <ProviderEditor key={provider.id} provider={provider} onSaved={refresh} />)}
  </Stack>;
}

function ProviderEditor({ provider, onSaved }: { provider: OIDCProvider; onSaved: () => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <ProviderForm title={`Edit ${provider.displayName}`} initial={{ slug: provider.slug, displayName: provider.displayName, issuer: provider.issuer, clientId: provider.clientId, clientSecret: '', enabled: provider.enabled, jitEnabled: provider.jitEnabled, mappings: formatMappings(provider.acrAssuranceMappings) }} provider={provider} onCancel={() => setEditing(false)} onSaved={async () => { setEditing(false); await onSaved(); }} />;
  }
  return <Tile><Stack gap={4}>
    <div className="account-summary"><div><h2>{provider.displayName}</h2><p className="section-description">{provider.issuer}</p></div><Button kind="tertiary" size="sm" onClick={() => setEditing(true)}>Edit</Button></div>
    <p>Slug: <code>{provider.slug}</code> · Client ID: <code>{provider.clientId}</code></p>
    <div className="tag-list"><span>{provider.enabled ? 'Enabled' : 'Disabled'}</span><span>{provider.jitEnabled ? 'JIT enabled' : 'JIT disabled'}</span></div>
    <p className="section-description">Trusted ACR mappings: {Object.keys(provider.acrAssuranceMappings).length || 'none'}</p>
  </Stack></Tile>;
}

function ProviderForm({ title, initial, provider, onCancel, onSaved }: { title: string; initial: Values; provider?: OIDCProvider; onCancel: () => void; onSaved: () => Promise<unknown> }) {
  const [values, setValues] = useState(initial);
  const [mappingError, setMappingError] = useState('');
  const mutation = useSecretMutation(async (input: Values) => {
      const acrAssuranceMappings = parseMappings(input.mappings);
      if (provider) {
        return updateOIDCProvider(provider.id, { expectedVersion: provider.version, displayName: input.displayName, issuer: input.issuer, clientId: input.clientId, ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}), enabled: input.enabled, jitEnabled: input.jitEnabled, acrAssuranceMappings });
      }
      return createOIDCProvider({ slug: input.slug, displayName: input.displayName, issuer: input.issuer, clientId: input.clientId, clientSecret: input.clientSecret, enabled: input.enabled, jitEnabled: input.jitEnabled, acrAssuranceMappings });
    }, {
    gcTime: 0,
    onSuccess: async () => {
      setValues((current) => ({ ...current, clientSecret: '' }));
      await onSaved();
    },
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try { parseMappings(values.mappings); setMappingError(''); } catch (error) { setMappingError(error instanceof Error ? error.message : 'Invalid mappings'); return; }
    try { await mutation.mutateAsync({ ...values }); } catch { /* The mutation renders the transport failure. */ }
  };
  return <Tile><Form onSubmit={submit}><Stack gap={5}>
    <h2>{title}</h2>
    {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Provider not saved" subtitle="Review unique values and encryption configuration, then try again." />}
    {!provider && <TextInput id="oidc-slug" labelText="Stable slug" helperText="Lowercase letters, numbers, and hyphens." value={values.slug} required onChange={(event) => setValues({ ...values, slug: event.target.value })} />}
    <TextInput id={`oidc-display-${provider?.id ?? 'new'}`} labelText="Display name" value={values.displayName} required onChange={(event) => setValues({ ...values, displayName: event.target.value })} />
    <TextInput id={`oidc-issuer-${provider?.id ?? 'new'}`} labelText="Canonical issuer URL" type="url" value={values.issuer} required onChange={(event) => setValues({ ...values, issuer: event.target.value })} />
    <TextInput id={`oidc-client-${provider?.id ?? 'new'}`} labelText="Client ID" value={values.clientId} required onChange={(event) => setValues({ ...values, clientId: event.target.value })} />
    <PasswordInput id={`oidc-secret-${provider?.id ?? 'new'}`} labelText={provider ? 'New client secret (leave blank to retain)' : 'Client secret'} value={values.clientSecret} required={!provider} autoComplete="new-password" onChange={(event) => setValues({ ...values, clientSecret: event.target.value })} />
    <TextArea id={`oidc-acr-${provider?.id ?? 'new'}`} labelText="Trusted ACR mappings" helperText="One exact mapping per line, for example: urn:example:mfa=strong_mfa" value={values.mappings} invalid={Boolean(mappingError)} invalidText={mappingError} onChange={(event) => setValues({ ...values, mappings: event.target.value })} />
    <Checkbox id={`oidc-enabled-${provider?.id ?? 'new'}`} labelText="Enable provider for login" checked={values.enabled} onChange={(_, data) => setValues({ ...values, enabled: data.checked })} />
    <Checkbox id={`oidc-jit-${provider?.id ?? 'new'}`} labelText="Allow JIT Accounts with no Roles" checked={values.jitEnabled} onChange={(_, data) => setValues({ ...values, jitEnabled: data.checked })} />
    <div className="form-actions"><Button type="button" kind="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save provider'}</Button></div>
  </Stack></Form></Tile>;
}

function parseMappings(input: string): Record<string, AuthenticationAssurance> {
  const result: Record<string, AuthenticationAssurance> = {};
  for (const rawLine of input.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.lastIndexOf('=');
    const acr = line.slice(0, separator).trim();
    const assurance = line.slice(separator + 1).trim() as AuthenticationAssurance;
    if (separator < 1 || !['normal', 'strong', 'strong_mfa'].includes(assurance)) throw new Error('Each line must be ACR=normal, ACR=strong, or ACR=strong_mfa.');
    result[acr] = assurance;
  }
  return result;
}

function formatMappings(values: Record<string, AuthenticationAssurance>): string {
  return Object.entries(values).map(([acr, assurance]) => `${acr}=${assurance}`).join('\n');
}
