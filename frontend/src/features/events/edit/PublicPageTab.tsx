import {
  Button,
  Checkbox,
  CheckboxGroup,
  ContentSwitcher,
  InlineNotification,
  Select,
  SelectItem,
  Stack,
  Switch,
  TextArea,
  TextInput,
  Tile,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { getGetEventBannerUrl, updateEvent, updateEventFile } from '../../../api/generated/events/events';
import type { Event, EventFile } from '../../../api/generated/models';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { SectionHeading } from '../components/Layout';
import { eventMutationMessage } from '../errors';
import { closedNotice, isClosed, previewPublicEvent } from '../logic';
import { PublicPageView } from '../public/PublicPageView';
import {
  eventFilesQueryOptions,
  eventSessionsQueryOptions,
  eventShiftsQueryOptions,
  invalidateEvents,
} from '../queries';
import { eventBody } from '../requestBodies';

type Values = { title: string; description: string; location: string };

/** Form on the left, the page as visitors see it on the right. Internal fields are not part of the preview data. */
export function PublicPageTab({ event, now, canManage }: { event: Event; now: number; canManage: boolean }) {
  const client = useQueryClient();
  const [as, setAs] = useState<'visitor' | 'member'>('visitor');
  const sessions = useQuery(eventSessionsQueryOptions(event.id)).data?.items ?? [];
  const shifts = useQuery(eventShiftsQueryOptions(event.id)).data?.items ?? [];
  const files = useQuery(eventFilesQueryOptions(event.id)).data?.items ?? [];
  const form = useForm<Values>({
    defaultValues: {
      title: event.publicTitle ?? '',
      description: event.publicDescription ?? '',
      location: event.publicLocation ?? '',
    },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const live = event.goLive.publicPage.state === 'live';
  const closed = isClosed(event.status);
  const save = useMutation({
    mutationFn: (value: Values) =>
      updateEvent(
        event.id,
        eventBody(event, {
          publicTitle: value.title.trim() || null,
          publicDescription: value.description.trim() || null,
          publicLocation: value.location.trim() || null,
        }),
      ),
    onSuccess: async (_, value) => {
      await invalidateEvents(client);
      form.reset(value);
    },
  });
  const fileChange = useMutation({
    mutationFn: ({
      file,
      visibility,
      isBanner,
    }: {
      file: EventFile;
      visibility: EventFile['visibility'];
      isBanner: boolean;
    }) =>
      updateEventFile(event.id, file.id, {
        description: file.description ?? null,
        visibility,
        isBanner,
        expectedVersion: file.version,
      }),
    onSuccess: () => invalidateEvents(client),
  });
  const values = form.watch();
  const images = files.filter((file) => file.contentType.startsWith('image/'));
  const banner = files.find((file) => file.isBanner);
  const documents = files.filter((file) => !file.isBanner);
  const editable = canManage && !closed;
  const preview = previewPublicEvent(
    { ...event, publicTitle: values.title, publicDescription: values.description, publicLocation: values.location },
    sessions,
    shifts,
    files,
    now,
  );
  const titleMissing = live && values.title.trim() === '';

  return (
    <div className="ev-public-tab ev-tab">
      <div className="ev-stack">
        <Tile>
          <form
            onSubmit={form.handleSubmit((value) => {
              if (!save.isPending) save.mutate(value);
            })}
          >
            <Stack gap={5}>
              <SectionHeading title="Public texts" />
              {!editable && (
                <InlineNotification
                  kind="info"
                  lowContrast
                  hideCloseButton
                  title="Read-only"
                  subtitle={closed ? closedNotice(event.status) : 'You can preview the page but not change it.'}
                />
              )}
              {save.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Texts not saved"
                  subtitle={eventMutationMessage(save.error)}
                />
              )}
              <TextInput
                id="ev-pub-title"
                labelText="Public title"
                helperText="Shown instead of the internal name."
                disabled={!editable}
                invalid={titleMissing}
                invalidText="Required while the public page is live"
                maxLength={200}
                {...form.register('title')}
              />
              <TextArea
                id="ev-pub-description"
                labelText="Public description"
                rows={5}
                disabled={!editable}
                maxLength={10000}
                {...form.register('description')}
              />
              <TextInput
                id="ev-pub-location"
                labelText="Public location"
                disabled={!editable}
                maxLength={500}
                {...form.register('location')}
              />
              {editable && (
                <div className="ev-inline">
                  <Button type="submit" disabled={!form.formState.isDirty || save.isPending || titleMissing}>
                    {save.isPending ? 'Saving…' : 'Save texts'}
                  </Button>
                  <Button kind="ghost" disabled={!form.formState.isDirty} onClick={() => form.reset()}>
                    Discard
                  </Button>
                  {form.formState.isDirty && <span className="ev-secondary">Unsaved changes</span>}
                </div>
              )}
            </Stack>
          </form>
        </Tile>
        <Tile>
          <Stack gap={5}>
            <SectionHeading title="Banner and files" />
            {fileChange.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="File not updated"
                subtitle={eventMutationMessage(fileChange.error)}
              />
            )}
            <Select
              id="ev-pub-banner"
              labelText="Banner image"
              helperText={images.length === 0 ? 'Upload an image in the Files tab first.' : 'Shown on the public page.'}
              disabled={!canManage || images.length === 0 || fileChange.isPending}
              value={banner?.id ?? ''}
              onChange={(e) => {
                const chosen = images.find((file) => file.id === e.target.value);
                if (chosen) fileChange.mutate({ file: chosen, visibility: 'public', isBanner: true });
                else if (banner) fileChange.mutate({ file: banner, visibility: banner.visibility, isBanner: false });
              }}
            >
              <SelectItem value="" text="No banner" />
              {images.map((file) => (
                <SelectItem key={file.id} value={file.id} text={file.originalFilename} />
              ))}
            </Select>
            {documents.length > 0 && (
              <CheckboxGroup legendText="Files visitors can download">
                {documents.map((file) => (
                  <Checkbox
                    key={file.id}
                    id={`ev-pub-file-${file.id}`}
                    labelText={file.originalFilename}
                    checked={file.visibility === 'public'}
                    disabled={!canManage || fileChange.isPending}
                    onChange={(_, { checked }) =>
                      fileChange.mutate({ file, visibility: checked ? 'public' : 'internal', isBanner: false })
                    }
                  />
                ))}
              </CheckboxGroup>
            )}
          </Stack>
        </Tile>
      </div>
      <div className="ev-preview">
        <div className="ev-preview__bar">
          <SectionHeading title="Live preview" />
          <ContentSwitcher
            size="sm"
            selectedIndex={as === 'visitor' ? 0 : 1}
            onChange={({ name }) => setAs(name as 'visitor' | 'member')}
          >
            <Switch name="visitor" text="Visitor" />
            <Switch name="member" text="Signed-in member" />
          </ContentSwitcher>
        </div>
        {!live && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Not live yet"
            subtitle="Visitors cannot see this page until you put it live with Go live."
          />
        )}
        <div className="ev-preview__frame">
          <PublicPageView
            event={preview}
            mode="preview"
            signedIn={as === 'member'}
            bannerUrl={`${getGetEventBannerUrl(event.id)}?v=${encodeURIComponent(banner?.updatedAt ?? '')}`}
          />
        </div>
      </div>
      <UnsavedChangesDialog guard={guard} />
    </div>
  );
}
