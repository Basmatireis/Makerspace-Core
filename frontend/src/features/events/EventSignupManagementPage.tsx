import { Checkmark } from '@carbon/icons-react';
import { Button, InlineNotification, Select, SelectItem, Stack, TextInput, Tile } from '@carbon/react';
import { useEffect, useState, type FormEvent } from 'react';
import { cancelCurrentEventSignup, getCurrentEventSignup, getPublicEvent, updateCurrentEventSignup } from '../../api/generated/public-events/public-events';
import type { EventSignup, PublicEvent } from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useBranding, usePageTitle } from '../branding/branding';
import { formatInstant } from './format';

const header = (token: string) => ({ headers: { 'X-Event-Signup-Token': token } });

export function EventSignupManagementPage() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  const [assignment, setAssignment] = useState<EventSignup | null>(null);
  const [publicEvent, setPublicEvent] = useState<PublicEvent | null>(null);
  const [failed, setFailed] = useState(false);
  const branding = useBranding();
  usePageTitle('Manage event signup');

  useEffect(() => {
    if (!token) return;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    let active = true;
    void getCurrentEventSignup(header(token))
      .then(async (value) => {
        if (!active) return;
        setAssignment(value);
        try {
          const event = await getPublicEvent(value.publicId);
          if (active) setPublicEvent(event);
        } catch {
          // Unpublished Events still allow contact updates and cancellation.
        }
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [token]);

  if (!token) return <main className="public-page"><Stack gap={6}><PageHeader title="Manage event signup" description="Open the complete private management link you received after signup."/><ErrorState title="Management link missing" message="The token belongs in the link fragment and is not recoverable."/></Stack></main>;
  if (failed) return <main className="public-page"><ErrorState title="Signup not found" message="This private link is invalid or its personal data has expired."/></main>;
  if (!assignment) return <main className="public-page"><InlineLoadingState label="Loading signup"/></main>;
  return <main className="public-page"><Stack gap={7}><div className="public-event-brand">{branding.assets.compactLogoUrl && <img src={branding.assets.compactLogoUrl} alt=""/>}<span>{branding.identity.applicationName}</span></div><PageHeader title="Manage event signup" description="This page can access only the signup identified by your private link."/><ManagementForm key={assignment.version} token={token} assignment={assignment} publicEvent={publicEvent} onUpdated={setAssignment}/></Stack></main>;
}

function ManagementForm({ token, assignment, publicEvent, onUpdated }: { token: string; assignment: EventSignup; publicEvent: PublicEvent | null; onUpdated: (value: EventSignup) => void }) {
  const [value, setValue] = useState({ firstName: assignment.firstName ?? '', lastName: assignment.lastName ?? '', email: assignment.email ?? '', phone: assignment.phone ?? '' });
  const [destination, setDestination] = useState('');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const destinations = (publicEvent?.shifts ?? []).flatMap((shift) => shift.requirements
    .filter((requirement) => `${shift.id}:${requirement.id}` !== `${assignment.shiftId}:${assignment.requirementId}`)
    .map((requirement) => ({ shift, requirement, value: `${shift.id}:${requirement.id}` })));
  const update = async (event: FormEvent) => {
    event.preventDefault(); setPending(true); setFailed(false);
    try { onUpdated(await updateCurrentEventSignup({ firstName: value.firstName, lastName: value.lastName, email: value.email || null, phone: value.phone || null, expectedVersion: assignment.version }, header(token))); }
    catch { setFailed(true); }
    finally { setPending(false); }
  };
  const cancel = async () => {
    setPending(true); setFailed(false);
    try { onUpdated(await cancelCurrentEventSignup({ expectedVersion: assignment.version }, header(token))); }
    catch { setFailed(true); }
    finally { setPending(false); }
  };
  const move = async () => {
    const [shiftId, requirementId] = destination.split(':');
    setPending(true); setFailed(false);
    try { onUpdated(await updateCurrentEventSignup({ shiftId, requirementId, expectedVersion: assignment.version }, header(token))); }
    catch { setFailed(true); }
    finally { setPending(false); }
  };
  return <Tile><form onSubmit={update}><Stack gap={5}><div className="event-record__title"><h2>Your signup</h2><span>{assignment.status} · {formatInstant(assignment.createdAt)}</span></div>{failed && <InlineNotification kind="error" lowContrast hideCloseButton title="Change not saved" subtitle="The signup changed or the requested update is unavailable."/>}{assignment.status === 'cancelled' && <InlineNotification kind="info" lowContrast hideCloseButton title="Signup cancelled" subtitle="Cancelled signups cannot be reactivated with this link."/>}<TextInput id="manage-signup-first" labelText="First name" disabled={assignment.status !== 'active'} required value={value.firstName} onChange={(e) => setValue({ ...value, firstName:e.target.value })}/><TextInput id="manage-signup-last" labelText="Last name" disabled={assignment.status !== 'active'} required value={value.lastName} onChange={(e) => setValue({ ...value, lastName:e.target.value })}/><TextInput id="manage-signup-email" type="email" labelText="Email" disabled={assignment.status !== 'active'} value={value.email} onChange={(e) => setValue({ ...value, email:e.target.value })}/><TextInput id="manage-signup-phone" type="tel" labelText="Phone" disabled={assignment.status !== 'active'} value={value.phone} onChange={(e) => setValue({ ...value, phone:e.target.value })}/>{assignment.status === 'active' && destinations.length > 0 && <div className="event-form-grid"><Select id="manage-signup-destination" labelText="Move to another place" value={destination} onChange={(e) => setDestination(e.target.value)}><SelectItem value="" text="Choose a place"/>{destinations.map(({ shift, requirement, value: optionValue }) => <SelectItem key={optionValue} value={optionValue} disabled={requirement.availability !== 'available'} text={`${shift.name} — ${requirement.name} (${requirement.remainingCount} left)`}/>)}</Select><Button type="button" kind="secondary" disabled={!destination || pending} onClick={() => void move()}>Move signup</Button></div>}{assignment.status === 'active' && <div className="form-actions"><Button type="submit" renderIcon={Checkmark} disabled={!value.firstName.trim() || !value.lastName.trim() || (!value.email.trim() && !value.phone.trim()) || pending}>Save</Button><Button type="button" kind="danger--tertiary" disabled={pending} onClick={() => void cancel()}>Cancel signup</Button></div>}</Stack></form></Tile>;
}
