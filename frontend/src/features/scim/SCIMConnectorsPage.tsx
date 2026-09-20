import {
  Button,
  Checkbox,
  CodeSnippet,
  Form,
  InlineNotification,
  Stack,
  TextInput,
  Tile,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  createSCIMConnector,
  listSCIMConnectors,
  preflightSCIMReconciliation,
  reconcileSCIMAccount,
  revokeSCIMConnectorToken,
  rotateSCIMConnectorToken,
  updateSCIMConnector,
} from '../../api/generated/scim-administration/scim-administration';
import type {
  SCIMConnector,
  SCIMConnectorTokenIssue,
  SCIMReconciliationReport,
} from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';

const defaultExpiry = () => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + 90);
  return value.toISOString().slice(0, 16);
};

const toISO = (value: string) => new Date(value).toISOString();

export function SCIMConnectorsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['scim', 'connectors'],
    queryFn: ({ signal }) => listSCIMConnectors({ signal }),
  });
  const [creating, setCreating] = useState(false);
  const [issuedToken, setIssuedToken] = useState<SCIMConnectorTokenIssue>();
  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['scim'] });

  return (
    <Stack gap={7}>
      <PageHeader
        title="SCIM provisioning"
        breadcrumbs={[{ label: 'Settings', to: '/settings' }]}
        description="Manage connector credentials and safely reconcile provisional SCIM Accounts. Groups, Roles, and entitlements are not supported."
        actions={<Button onClick={() => setCreating(true)}>Add connector</Button>}
      />
      {issuedToken && (
        <Tile>
          <Stack gap={4}>
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Copy this bearer token now"
              subtitle="It is shown once and cannot be recovered. Store it in the SCIM provider, then dismiss it from this screen."
            />
            <CodeSnippet type="multi">{issuedToken.bearerToken}</CodeSnippet>
            <div><Button kind="secondary" onClick={() => setIssuedToken(undefined)}>I have stored the token</Button></div>
          </Stack>
        </Tile>
      )}
      {creating && (
        <CreateConnectorForm
          onCancel={() => setCreating(false)}
          onCreated={async (issue) => {
            setIssuedToken(issue);
            setCreating(false);
            await refresh();
          }}
        />
      )}
      {query.isPending && <InlineLoadingState label="Loading SCIM connectors" />}
      {query.isError && <ErrorState title="Unable to load SCIM connectors" message="Check the connection and try again." onRetry={() => void query.refetch()} />}
      {query.data?.items.length === 0 && !creating && <Tile><p>No SCIM connectors are configured.</p></Tile>}
      {query.data?.items.map((connector) => (
        <ConnectorEditor
          key={connector.id}
          connector={connector}
          onTokenIssued={(issue) => setIssuedToken(issue)}
          onChanged={refresh}
        />
      ))}
      <ReconciliationPanel />
    </Stack>
  );
}

function CreateConnectorForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (issue: SCIMConnectorTokenIssue) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const mutation = useMutation({
    mutationFn: () => createSCIMConnector({
      name: name.trim(),
      oidcProviderId: providerId.trim() || null,
      enabled,
      tokenExpiresAt: toISO(expiresAt),
    }),
    onSuccess: onCreated,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <Tile>
      <Form onSubmit={submit}>
        <Stack gap={5}>
          <h2>Add connector</h2>
          {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Connector not created" subtitle="Review the values and try again." />}
          <TextInput id="scim-name-new" labelText="Connector name" value={name} required onChange={(event) => setName(event.target.value)} />
          <TextInput id="scim-provider-new" labelText="Bound OIDC provider ID (optional)" helperText="When set, externalId is interpreted only as this provider's OIDC subject." value={providerId} onChange={(event) => setProviderId(event.target.value)} />
          <TextInput id="scim-expiry-new" type="datetime-local" labelText="Bearer token expires" value={expiresAt} required onChange={(event) => setExpiresAt(event.target.value)} />
          <Checkbox id="scim-enabled-new" labelText="Enable connector" checked={enabled} onChange={(_, data) => setEnabled(data.checked)} />
          <div className="form-actions"><Button type="button" kind="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={mutation.isPending || !name.trim() || !expiresAt}>{mutation.isPending ? 'Creating…' : 'Create connector'}</Button></div>
        </Stack>
      </Form>
    </Tile>
  );
}

function ConnectorEditor({ connector, onChanged, onTokenIssued }: { connector: SCIMConnector; onChanged: () => Promise<unknown>; onTokenIssued: (issue: SCIMConnectorTokenIssue) => void }) {
  const [name, setName] = useState(connector.name);
  const [providerId, setProviderId] = useState(connector.oidcProviderId ?? '');
  const [enabled, setEnabled] = useState(connector.enabled);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const save = useMutation({
    mutationFn: () => updateSCIMConnector(connector.id, { name: name.trim(), oidcProviderId: providerId.trim() || null, enabled, expectedVersion: connector.version }),
    onSuccess: onChanged,
  });
  const rotate = useMutation({
    mutationFn: () => rotateSCIMConnectorToken(connector.id, { expiresAt: toISO(expiresAt), expectedVersion: connector.version }),
    onSuccess: async (issue) => { onTokenIssued(issue); await onChanged(); },
  });
  const revoke = useMutation({
    mutationFn: () => revokeSCIMConnectorToken(connector.id, { expectedVersion: connector.version }),
    onSuccess: onChanged,
  });
  const failed = save.isError || rotate.isError || revoke.isError;

  return (
    <Tile>
      <Stack gap={5}>
        <div><h2>{connector.name}</h2><p className="section-description">SCIM base URL: <code>/api/v1/scim/v2</code></p></div>
        {failed && <InlineNotification kind="error" lowContrast hideCloseButton title="Connector operation failed" subtitle="Reload the connector and try again. Its version may have changed." />}
        <TextInput id={`scim-name-${connector.id}`} labelText="Connector name" value={name} onChange={(event) => setName(event.target.value)} />
        <TextInput id={`scim-provider-${connector.id}`} labelText="Bound OIDC provider ID (optional)" value={providerId} onChange={(event) => setProviderId(event.target.value)} />
        <Checkbox id={`scim-enabled-${connector.id}`} labelText="Enable connector" checked={enabled} onChange={(_, data) => setEnabled(data.checked)} />
        <p>Active token: {connector.tokenExpiresAt ? `expires ${new Date(connector.tokenExpiresAt).toLocaleString()}` : 'none'}</p>
        <div className="form-actions"><Button kind="tertiary" disabled={save.isPending || !name.trim()} onClick={() => save.mutate()}>Save settings</Button><Button kind="danger--tertiary" disabled={revoke.isPending || !connector.tokenExpiresAt} onClick={() => revoke.mutate()}>Revoke token</Button></div>
        <TextInput id={`scim-expiry-${connector.id}`} type="datetime-local" labelText="New token expires" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        <div><Button kind="secondary" disabled={rotate.isPending || !expiresAt} onClick={() => rotate.mutate()}>Rotate token</Button></div>
      </Stack>
    </Tile>
  );
}

function ReconciliationPanel() {
  const queryClient = useQueryClient();
  const [provisionalAccountId, setProvisionalAccountId] = useState('');
  const [targetAccountId, setTargetAccountId] = useState('');
  const [report, setReport] = useState<SCIMReconciliationReport>();
  const request = { provisionalAccountId, targetAccountId };
  const preflight = useMutation({
    mutationFn: () => preflightSCIMReconciliation(request),
    onSuccess: setReport,
  });
  const reconcile = useMutation({
    mutationFn: () => reconcileSCIMAccount(request),
    onSuccess: async (result) => {
      setReport(result);
      await queryClient.invalidateQueries({ queryKey: ['scim'] });
    },
  });
  const changed = report && (report.provisionalAccountId !== provisionalAccountId || report.targetAccountId !== targetAccountId);
  const canExecute = Boolean(report?.canReconcile && !report.completed && !changed);

  return (
    <Tile>
      <Stack gap={5}>
        <div><h2>Account reconciliation</h2><p className="section-description">Keep the established local Account and transfer a conflict-free provisional SCIM Account into it. Preflight never changes data.</p></div>
        {(preflight.isError || reconcile.isError) && <InlineNotification kind="error" lowContrast hideCloseButton title="Reconciliation check failed" subtitle="Verify both Account IDs and try again." />}
        <TextInput id="scim-provisional-account" labelText="Provisional SCIM Account ID" value={provisionalAccountId} onChange={(event) => { setProvisionalAccountId(event.target.value.trim()); setReport(undefined); }} />
        <TextInput id="scim-target-account" labelText="Established target Account ID" value={targetAccountId} onChange={(event) => { setTargetAccountId(event.target.value.trim()); setReport(undefined); }} />
        <div className="form-actions"><Button kind="secondary" disabled={preflight.isPending || !provisionalAccountId || !targetAccountId || provisionalAccountId === targetAccountId} onClick={() => preflight.mutate()}>Run preflight</Button><Button disabled={!canExecute || reconcile.isPending} onClick={() => reconcile.mutate()}>Reconcile Accounts</Button></div>
        {report?.completed && <InlineNotification kind="success" lowContrast hideCloseButton title="Accounts reconciled" subtitle="The provisional Account was removed after its identities and relations were transferred." />}
        {report && !report.completed && report.canReconcile && <InlineNotification kind="success" lowContrast hideCloseButton title="No conflicts found" subtitle="Review the Account IDs, then run the atomic reconciliation." />}
        {report && !report.canReconcile && <InlineNotification kind="warning" lowContrast hideCloseButton title="Conflicts must be resolved first" subtitle="No data was changed." />}
        {report?.conflicts.map((conflict) => <div key={`${conflict.code}-${conflict.resourceId ?? ''}`}><strong>{conflict.code}</strong><p>{conflict.message}</p>{conflict.resourceId && <p><code>{conflict.resourceId}</code></p>}</div>)}
      </Stack>
    </Tile>
  );
}
