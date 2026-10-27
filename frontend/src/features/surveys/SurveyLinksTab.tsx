import { useState } from 'react';
import {
  Button,
  CopyButton,
  InlineNotification,
  Modal,
  NumberInput,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  TextInput,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import {
  createSurveyShareLink,
  deleteSurveyShareLink,
  updateSurveyShareLink,
} from '../../api/generated/surveys/surveys';
import type { Survey, SurveyShareLink } from '../../api/generated/models';
import { DateInput } from '../../app/DateInput';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { dateInAppTimeZone, formatDate, zonedDateTimeToISO } from '../../app/dateTime';
import { EmptyState } from '../../app/PageState';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { SettingsSection } from '../settings/SettingsPageLayout';
import { linkStateLabels, linkStateTagTypes, shareLinkUrl } from './presentation';
import { surveyKeys, surveyLinksQuery } from './queries';

type LinkValues = { label: string; expiresOn: string; maxResponses: number | string };

export function SurveyLinksTab({ survey }: { survey: Survey }) {
  const queryClient = useQueryClient();
  const query = useQuery(surveyLinksQuery(survey.id));
  const [editing, setEditing] = useState<SurveyShareLink | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SurveyShareLink | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: surveyKeys.all });
  const toggle = useMutation({
    mutationFn: (link: SurveyShareLink) =>
      updateSurveyShareLink(survey.id, link.id, {
        label: link.label,
        expiresAt: link.expiresAt,
        maxResponses: link.maxResponses,
        active: !link.active,
        expectedVersion: link.version,
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (link: SurveyShareLink) => deleteSurveyShareLink(survey.id, link.id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });
  return (
    <SettingsSection
      title="Share links"
      description="Anonymous public links for open days, flyers or QR codes. Answers through a link are never linked to a person."
      actions={
        <Button kind="primary" renderIcon={Add} onClick={() => setEditing('new')}>
          New link
        </Button>
      }
    >
      <Stack gap={5}>
        {survey.status !== 'published' && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Not accepting answers"
            subtitle="Links only answer while the survey is published."
          />
        )}
        {toggle.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            title="Link not changed"
            subtitle={toggle.error.message}
            onCloseButtonClick={() => toggle.reset()}
          />
        )}
        <QueryBoundary query={query} errorMessage="The share links could not be loaded.">
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState title="No share links yet" description="Create a link to collect anonymous answers." />
            ) : (
              <TableContainer>
                <Table aria-label="Share links">
                  <TableHead>
                    <TableRow>
                      <TableHeader>Label</TableHeader>
                      <TableHeader>Link</TableHeader>
                      <TableHeader>Status</TableHeader>
                      <TableHeader>Responses</TableHeader>
                      <TableHeader>Expires</TableHeader>
                      <TableHeader>Maximum</TableHeader>
                      <TableHeader>Actions</TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.items.map((link) => {
                      const url = shareLinkUrl(link.token);
                      return (
                        <TableRow key={link.id}>
                          <TableCell>{link.label ?? <span className="mj-secondary">Unnamed</span>}</TableCell>
                          <TableCell>
                            <div className="survey-link-url">
                              <code>{url}</code>
                              <CopyButton
                                align="top"
                                feedback="Copied"
                                iconDescription={`Copy link ${link.label ?? ''}`.trim()}
                                onClick={() => {
                                  void navigator.clipboard?.writeText(url);
                                }}
                              />
                            </div>
                          </TableCell>
                          <TableCell>
                            <Tag size="sm" type={linkStateTagTypes[link.state]}>
                              {linkStateLabels[link.state]}
                            </Tag>
                          </TableCell>
                          <TableCell>{link.responseCount}</TableCell>
                          <TableCell>{link.expiresAt ? formatDate(link.expiresAt) : 'Never'}</TableCell>
                          <TableCell>{link.maxResponses ?? 'Unlimited'}</TableCell>
                          <TableCell>
                            <div className="button-cluster">
                              <Button size="sm" kind="ghost" onClick={() => setEditing(link)}>
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                kind="ghost"
                                disabled={toggle.isPending}
                                onClick={() => toggle.mutate(link)}
                              >
                                {link.active ? 'Deactivate' : 'Reactivate'}
                              </Button>
                              <Button size="sm" kind="danger--ghost" onClick={() => setDeleting(link)}>
                                Delete
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )
          }
        </QueryBoundary>
      </Stack>
      {editing && (
        <LinkModal
          key={editing === 'new' ? 'new' : editing.id}
          surveyId={survey.id}
          link={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
      <DestructiveActionDialog
        open={deleting !== null}
        title="Delete this share link?"
        confirmLabel="Delete link"
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => setDeleting(null)}
      >
        The link stops working immediately. Responses already collected through it are kept.
      </DestructiveActionDialog>
    </SettingsSection>
  );
}

function LinkModal({
  surveyId,
  link,
  onClose,
  onSaved,
}: {
  surveyId: string;
  link?: SurveyShareLink;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const { register, control, handleSubmit } = useForm<LinkValues>({
    defaultValues: {
      label: link?.label ?? '',
      expiresOn: link?.expiresAt ? dateInAppTimeZone(link.expiresAt) : '',
      maxResponses: link?.maxResponses ?? '',
    },
  });
  const save = useMutation({
    mutationFn: (values: LinkValues) => {
      const body = {
        label: values.label.trim() || null,
        // The expiry is a calendar day; the link works until the end of that day.
        expiresAt: values.expiresOn ? zonedDateTimeToISO(values.expiresOn, '23:59') : null,
        maxResponses: values.maxResponses === '' ? null : Number(values.maxResponses),
      };
      return link
        ? updateSurveyShareLink(surveyId, link.id, { ...body, active: link.active, expectedVersion: link.version })
        : createSurveyShareLink(surveyId, body);
    },
    onSuccess: onSaved,
  });
  return (
    <Modal
      open
      modalHeading={link ? 'Edit share link' : 'New share link'}
      primaryButtonText="Save link"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={save.isPending}
      onRequestSubmit={() => void handleSubmit((values) => save.mutate(values))()}
      onRequestClose={onClose}
    >
      <Stack gap={5}>
        <TextInput id="link-label" labelText="Label (optional)" maxLength={120} {...register('label')} />
        <Controller
          name="expiresOn"
          control={control}
          render={({ field }) => (
            <DateInput
              id="link-expires"
              labelText="Expires after (optional)"
              helperText="The link works until the end of this day."
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        <Controller
          name="maxResponses"
          control={control}
          render={({ field }) => (
            <NumberInput
              id="link-max"
              label="Maximum responses (optional)"
              min={1}
              max={1000000}
              allowEmpty
              value={field.value}
              onChange={(_event, state) => field.onChange(state.value)}
            />
          )}
        />
        {save.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Link not saved"
            subtitle={save.error.message}
          />
        )}
      </Stack>
    </Modal>
  );
}
