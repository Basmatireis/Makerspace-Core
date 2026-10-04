import { Calendar, Checkmark, Copy, Download, Login, Location } from '@carbon/icons-react';
import {
  Button, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader, RadioButton, RadioButtonGroup,
  Select, SelectItem, Stack, Tab, TabList, TabPanel, TabPanels, Tabs, Tag, TextInput, Tile,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  cancelOwnPublicEventAssignment, createAuthenticatedEventSignup, createPublicEventSignup,
  downloadPublicEventFile, getGetPublicEventBannerUrl,
} from '../../api/generated/public-events/public-events';
import type { EventSignupRequest } from '../../api/generated/models';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { currentUserQueryOptions } from '../auth/auth';
import { useBranding, usePageTitle } from '../branding/branding';
import { formatInstant, formatLocalDate, formatTimeRange, statusTagType } from './format';
import { eventKeys, ownEventAssignmentsQueryOptions, publicEventQueryOptions } from './queries';

export function PublicEventPage() {
  const { publicId = '' } = useParams();
  const event = useQuery(publicEventQueryOptions(publicId));
  const currentUser = useQuery(currentUserQueryOptions());
  const branding = useBranding();
  const client = useQueryClient();
  const signedIn = currentUser.isSuccess;
  const own = useQuery(ownEventAssignmentsQueryOptions(publicId, signedIn));
  const [signupFor, setSignupFor] = useState<'self'|'other'>('self');
  const [selection, setSelection] = useState('');
  const [details, setDetails] = useState<EventSignupRequest>({ shiftId: '', requirementId: '', firstName: '', lastName: '', email: null, phone: null });
  const [managementUrl, setManagementUrl] = useState<string | null>(null);
  const [signupComplete, setSignupComplete] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);
  usePageTitle(event.data?.title ?? 'Event');
  useEffect(() => {
    if (currentUser.data && signupFor === 'self') setDetails((value) => ({ ...value, firstName: currentUser.data.person.firstName, lastName: currentUser.data.person.lastName, email: currentUser.data.person.email ?? null, phone: currentUser.data.person.phone ?? null }));
  }, [currentUser.data, signupFor]);
  const options = useMemo(() => (event.data?.shifts ?? []).flatMap((shift) => shift.requirements.map((requirement) => ({ shift, requirement, value: `${shift.id}:${requirement.id}` }))), [event.data]);
  const cancel = useMutation({ mutationFn: ({ id, version }: { id: string; version: number }) => cancelOwnPublicEventAssignment(publicId, id, { expectedVersion: version }), onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: eventKeys.public(publicId) }), client.invalidateQueries({ queryKey: eventKeys.own(publicId) })]); } });
  const download = async (id: string, name: string) => { const blob = await downloadPublicEventFile(publicId, id); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); };
  if (event.isPending) return <main className="public-page"><InlineLoadingState label="Loading event"/></main>;
  if (event.isError) return <main className="public-page"><ErrorState title="Event not found" message="This event is not available publicly." onRetry={() => void event.refetch()}/></main>;
  const value = event.data;
  const schedule = value.sessions.length ? value.sessions : value.shifts;
  const rangeStart = schedule.map((item) => item.startsAt).sort()[0];
  const rangeEnd = schedule.map((item) => item.endsAt).sort().at(-1);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setCreating(true); setCreateFailed(false); setSignupComplete(false);
    try {
      const [shiftId, requirementId] = selection.split(':'); const request = { ...details, shiftId, requirementId };
      const result = signedIn ? await createAuthenticatedEventSignup(publicId, { ...request, signupFor }) : await createPublicEventSignup(publicId, request);
      setManagementUrl(result.managementUrl ?? null); setSignupComplete(true);
      await Promise.all([client.invalidateQueries({ queryKey: eventKeys.public(publicId) }), client.invalidateQueries({ queryKey: eventKeys.own(publicId) })]);
    } catch { setCreateFailed(true); } finally { setCreating(false); }
  };
  const openSignup = (optionValue: string) => { setSelection(optionValue); setManagementUrl(null); setSignupComplete(false); setCreateFailed(false); setSignupOpen(true); };
  const selectedOption = options.find((option) => option.value === selection);
  return <main className="public-event-page">
    <header className="public-event-nav"><div className="public-event-brand">{branding.assets.compactLogoUrl && <img src={branding.assets.compactLogoUrl} alt=""/>}<strong>{branding.identity.applicationName}</strong></div>{signedIn ? <Button as={Link} to="/dashboard" kind="ghost" size="sm">Dashboard</Button> : <Button as={Link} to="/login" kind="ghost" size="sm" renderIcon={Login}>Sign in</Button>}</header>
    {value.hasBanner && <div className="public-event-banner"><img src={getGetPublicEventBannerUrl(value.publicId)} alt=""/></div>}
    <section className="public-event-hero"><div className="public-event-hero__inner"><div className="event-record__title"><h1>{value.title}</h1><Tag type={statusTagType(value.status)}>{value.status}</Tag></div><div className="public-event-meta">{rangeStart && rangeEnd && <span><Calendar size={20}/>{formatLocalDate(rangeStart, value.timeZone)} · {formatTimeRange(rangeStart, rangeEnd, value.timeZone)}</span>}{value.location && <span><Location size={20}/>{value.location}</span>}</div>{value.description && <p>{value.description}</p>}</div></section>
    <div className="public-event-content"><Tabs><TabList aria-label="Public event sections" contained><Tab>Volunteer shifts</Tab><Tab>Information</Tab></TabList><TabPanels>
      <TabPanel><section className="public-event-section"><div><h2>Available shifts</h2><p>Choose a role to help make this event happen.</p></div>{value.shifts.length ? <div className="public-shift-list">{value.shifts.map((shift) => <Tile key={shift.id} className="public-shift-card"><div className="public-shift-card__details"><h3>{shift.name}</h3><p><Calendar size={16}/>{formatLocalDate(shift.startsAt, value.timeZone)} · {formatTimeRange(shift.startsAt, shift.endsAt, value.timeZone)}</p>{shift.description && <p>{shift.description}</p>}</div><div className="public-shift-requirements"><div className="public-shift-requirements__header"><span>Role</span><span>Places</span><span>Status</span><span/></div>{shift.requirements.map((requirement) => {
          const available = requirement.availability === 'available' || (requirement.availability === 'authenticated_only' && signedIn);
          const percent = Math.min(100, Math.round((requirement.filledCount / requirement.requiredCount) * 100));
          return <div key={requirement.id} className="public-shift-requirement"><div><strong>{requirement.name}</strong>{requirement.description && <p>{requirement.description}</p>}</div><span>{requirement.filledCount} / {requirement.requiredCount} filled</span><div><progress aria-label={`${requirement.name} availability`} max={100} value={percent}/><small>{requirement.availability.replace('_', ' ')}</small></div><Button size="sm" disabled={!value.publicSignupEnabled || !available} onClick={() => openSignup(`${shift.id}:${requirement.id}`)}>{requirement.availability === 'full' ? 'Full' : requirement.availability === 'authenticated_only' && !signedIn ? 'Sign in required' : 'Sign up'}</Button></div>;
        })}</div></Tile>)}</div> : <div className="empty-state"><h3>No public shifts</h3><p>There are currently no volunteer shifts available.</p></div>}</section></TabPanel>
      <TabPanel><Stack gap={7}><section className="public-event-section"><h2>Programme</h2>{value.sessions.length ? <div className="public-programme-list">{value.sessions.map((session) => <Tile key={session.id}><div className="event-record__title"><h3>{session.name ?? 'Event session'}</h3><strong>{formatTimeRange(session.startsAt, session.endsAt, value.timeZone)}</strong></div><p>{formatLocalDate(session.startsAt, value.timeZone)}</p>{session.location && <p><Location size={16}/>{session.location}</p>}{session.description && <p>{session.description}</p>}</Tile>)}</div> : <p>No programme details are available.</p>}</section>{value.files.length > 0 && <section className="public-event-section"><h2>Downloads</h2><div className="event-record-list">{value.files.map((file) => <Tile key={file.id} className="event-record"><div><strong>{file.originalFilename}</strong>{file.description && <p>{file.description}</p>}</div><Button kind="ghost" size="sm" renderIcon={Download} onClick={() => void download(file.id, file.originalFilename)}>Download</Button></Tile>)}</div></section>}</Stack></TabPanel>
    </TabPanels></Tabs>
    {signedIn && Boolean(own.data?.items.length) && <section className="public-event-section"><h2>Your signups</h2><div className="event-record-list">{own.data?.items.map((assignment) => <Tile key={assignment.id} className="event-record"><div><strong>{assignment.firstName} {assignment.lastName}</strong><p>{assignment.status} · created {formatInstant(assignment.createdAt)}</p></div>{assignment.status === 'active' && <Button kind="danger--tertiary" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: assignment.id, version: assignment.version })}>Cancel signup</Button>}</Tile>)}</div></section>}
    </div>
    {signupOpen && <ComposedModal open onClose={() => setSignupOpen(false)} size="sm" preventCloseOnClickOutside><ModalHeader title="Sign up for a shift" label={selectedOption ? value.title : undefined}/><ModalBody hasScrollingContent><form id="public-event-signup" onSubmit={submit}><Stack gap={5}>
      {selectedOption && <Tile className="public-signup-summary"><strong>{selectedOption.shift.name}</strong><span>{formatLocalDate(selectedOption.shift.startsAt, value.timeZone)} · {formatTimeRange(selectedOption.shift.startsAt, selectedOption.shift.endsAt, value.timeZone)}</span><span>{selectedOption.requirement.name} · {selectedOption.requirement.remainingCount} places left</span></Tile>}
      {createFailed && <InlineNotification kind="error" lowContrast hideCloseButton title="Signup unavailable" subtitle="This place may be full, closed, duplicated, ineligible, or conflict with another event shift."/>}
      {signupComplete && <InlineNotification kind="success" lowContrast hideCloseButton title="Signup confirmed" subtitle={managementUrl ? 'Copy the private management link below now. It cannot be recovered later.' : 'Your signup has been added to this event.'}/>} 
      {managementUrl ? <><TextInput id="signup-management-link" labelText="One-time management link" readOnly value={new URL(managementUrl, window.location.origin).toString()}/><Button type="button" kind="secondary" renderIcon={Copy} onClick={() => void navigator.clipboard.writeText(new URL(managementUrl, window.location.origin).toString())}>Copy management link</Button></> : <>{signedIn && <RadioButtonGroup legendText="Who are you signing up?" name="signup-for" valueSelected={signupFor} onChange={(next) => { setSignupFor(next as 'self'|'other'); setSignupComplete(false); }}><RadioButton id="signup-self" labelText="Myself" value="self"/><RadioButton id="signup-other" labelText="Someone else" value="other"/></RadioButtonGroup>}<Select id="signup-place" labelText="Shift and requirement" required value={selection} onChange={(e) => { setSelection(e.target.value); setSignupComplete(false); }}><SelectItem value="" text="Choose a place"/>{options.map(({ shift, requirement, value: optionValue }) => <SelectItem key={optionValue} value={optionValue} disabled={requirement.availability !== 'available' && !(requirement.availability === 'authenticated_only' && signedIn && signupFor === 'self')} text={`${shift.name} — ${requirement.name} (${requirement.remainingCount} left)`}/>)}</Select><div className="event-form-grid"><TextInput id="signup-first-name" labelText="First name" required disabled={signedIn && signupFor === 'self'} value={details.firstName} onChange={(e) => setDetails({ ...details, firstName:e.target.value })}/><TextInput id="signup-last-name" labelText="Last name" required disabled={signedIn && signupFor === 'self'} value={details.lastName} onChange={(e) => setDetails({ ...details, lastName:e.target.value })}/></div><div className="event-form-grid"><TextInput id="signup-email" type="email" labelText="Email" value={details.email ?? ''} onChange={(e) => setDetails({ ...details, email:e.target.value || null })}/><TextInput id="signup-phone" type="tel" labelText="Phone" value={details.phone ?? ''} onChange={(e) => setDetails({ ...details, phone:e.target.value || null })}/></div><p>Provide at least one email address or phone number. External signups receive a private management link.</p></>}
    </Stack></form></ModalBody><ModalFooter><Button kind="secondary" onClick={() => setSignupOpen(false)}>{signupComplete ? 'Close' : 'Cancel'}</Button>{!managementUrl && <Button type="submit" form="public-event-signup" renderIcon={Checkmark} disabled={!selection || !details.firstName.trim() || !details.lastName.trim() || (!details.email && !details.phone) || creating}>{creating ? 'Signing up…' : 'Confirm signup'}</Button>}</ModalFooter></ComposedModal>}
  </main>;
}
