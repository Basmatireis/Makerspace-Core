import { ArrowLeft } from '@carbon/icons-react';
import { Button, InlineNotification, Stack, TextArea, TextInput, Tile } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createEvent } from '../../api/generated/events/events';
import type { CreateEventRequest } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { eventKeys } from './queries';

export function EventCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { control, handleSubmit, formState: { errors } } = useForm<CreateEventRequest>({ defaultValues: { name: '', internalDescription: null, location: null, ownerPersonId: null } });
  const mutation = useMutation({ mutationFn: (input: CreateEventRequest) => createEvent(input), onSuccess: async (event) => { await queryClient.invalidateQueries({ queryKey: eventKeys.all }); navigate(`/events/${event.id}`, { replace: true }); } });
  return <PageShell title="Create event" description="Start with the internal details, then add the schedule, staffing, public page, and files." actions={<Button kind="ghost" renderIcon={ArrowLeft} onClick={() => navigate('/events')}>Back to events</Button>} width="wide" className="events-page">
    <div className="event-create-layout"><Tile className="event-create-form"><form onSubmit={handleSubmit((value) => mutation.mutate(value))}><Stack gap={6}>
        <div><h2>Event details</h2><p>These fields are visible only to authorized event staff until you configure and publish the public page.</p></div>
        {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Event not created" subtitle="Review the values and try again." />}
        <Controller name="name" control={control} rules={{ required: 'Name is required', maxLength: 200 }} render={({ field }) => <TextInput {...field} id="event-name" labelText="Internal event name" invalid={Boolean(errors.name)} invalidText={errors.name?.message} />} />
        <Controller name="location" control={control} render={({ field }) => <TextInput id="event-location" labelText="Internal location" value={field.value ?? ''} onChange={(event) => field.onChange(event.target.value || null)} />} />
        <Controller name="internalDescription" control={control} render={({ field }) => <TextArea id="event-description" labelText="Internal description" value={field.value ?? ''} onChange={(event) => field.onChange(event.target.value || null)} rows={7} />} />
        <div className="form-actions"><Button kind="secondary" type="button" onClick={() => navigate('/events')}>Cancel</Button><Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Creating…' : 'Create event'}</Button></div>
      </Stack></form></Tile><aside className="event-create-guide"><h2>What happens next</h2><ol><li><strong>Add sessions and shifts</strong><span>Build the official programme and staffing schedule.</span></li><li><strong>Plan work and staffing</strong><span>Create task lists, requirements, and assignments.</span></li><li><strong>Configure the public page</strong><span>Add public content and enable signup when ready.</span></li><li><strong>Publish</strong><span>Share the random public link with visitors and helpers.</span></li></ol></aside></div>
  </PageShell>;
}
