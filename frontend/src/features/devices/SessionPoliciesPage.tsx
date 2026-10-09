import { Button, Checkbox, Form, InlineNotification, NumberInput, Select, SelectItem, Stack, TextInput, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createSessionPolicy, listSessionPolicies, updateSessionPolicy } from '../../api/generated/managed-devices/managed-devices';
import type { PostSessionDestination, SessionPolicy, SessionPolicyInput } from '../../api/generated/models';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';

const key = ['session-policies'] as const;

export function SessionPoliciesPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => listSessionPolicies({ signal }) });
  const [editing, setEditing] = useState<SessionPolicy | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  return <PageShell title="Session policies" breadcrumbs={[{ label: 'Settings', to: '/settings' }]} description="Control idle and absolute session limits for private and registered devices."><Stack gap={6}>
    {query.isPending && <InlineLoadingState label="Loading session policies" />}
    {query.isError && <ErrorState title="Unable to load session policies" message="Check the connection and try again." onRetry={() => void query.refetch()} />}
    {query.data?.items.map((policy) => <Tile key={policy.id}><div className="section-heading"><div><h2>{policy.name}</h2><p>Idle {duration(policy.idleTimeoutSeconds)} · absolute {duration(policy.absoluteLifetimeSeconds)} · after expiry: {policy.postSessionDestination === 'visitor_terminal' ? 'Public terminal' : 'Sign in'}</p>{policy.isDefault && <strong>Default for private devices</strong>}</div><Button kind="ghost" onClick={() => setEditing(policy)}>Edit</Button></div></Tile>)}
    <PolicyForm key={editing?.id ?? 'new'} policy={editing} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); }} />
  </Stack></PageShell>;
}

function PolicyForm({ policy, onCancel, onSaved }: { policy: SessionPolicy | null; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(policy?.name ?? '');
  const [idle, setIdle] = useState(policy?.idleTimeoutSeconds ?? 2700);
  const [absolute, setAbsolute] = useState(policy?.absoluteLifetimeSeconds ?? 43200);
  const [destination, setDestination] = useState<PostSessionDestination>(policy?.postSessionDestination ?? 'login');
  const [isDefault, setDefault] = useState(policy?.isDefault ?? false);
  const mutation = useMutation({ mutationFn: (input: SessionPolicyInput) => policy ? updateSessionPolicy(policy.id, { ...input, expectedVersion: policy.version }) : createSessionPolicy(input), onSuccess: onSaved });
  const submit = () => mutation.mutate({ name: name.trim(), idleTimeoutSeconds: idle, absoluteLifetimeSeconds: absolute, postSessionDestination: destination, isDefault });
  return <Tile><Form onSubmit={(event) => { event.preventDefault(); submit(); }}><Stack gap={4}><h2>{policy ? 'Edit policy' : 'Create policy'}</h2>
    <TextInput id="policy-name" labelText="Name" value={name} onChange={(event) => setName(event.target.value)} />
    <NumberInput id="policy-idle" label="Idle timeout in seconds" min={60} max={2592000} value={idle} onChange={(_event, state) => setIdle(Number(state.value))} />
    <NumberInput id="policy-absolute" label="Absolute lifetime in seconds" min={300} max={7776000} value={absolute} onChange={(_event, state) => setAbsolute(Number(state.value))} />
    <Select id="policy-destination" labelText="After session expiry" value={destination} onChange={(event) => setDestination(event.target.value as PostSessionDestination)}><SelectItem value="login" text="Sign in" /><SelectItem value="visitor_terminal" text="Public visitor terminal" /></Select>
    <Checkbox id="policy-default" labelText="Default for unregistered/private devices" checked={isDefault} onChange={(_, data) => setDefault(data.checked)} />
    {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Policy not saved" subtitle={mutation.error.message} />}
    <div className="button-cluster"><Button type="submit" disabled={!name.trim() || idle > absolute || mutation.isPending}>{policy ? 'Save policy' : 'Create policy'}</Button>{policy && <Button kind="secondary" onClick={onCancel}>Cancel</Button>}</div>
  </Stack></Form></Tile>;
}

function duration(seconds: number) { if (seconds % 86400 === 0) return `${seconds / 86400}d`; if (seconds % 3600 === 0) return `${seconds / 3600}h`; return `${Math.round(seconds / 60)}m`; }
