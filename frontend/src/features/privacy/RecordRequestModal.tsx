import {
  ComboBox,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import type { Person, SubjectRequestChannel, SubjectRequestKind } from '../../api/generated/models';
import { createSubjectRequest } from '../../api/generated/privacy/privacy';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../app/dateTime';
import { peopleListOptions } from '../users/queries';
import { privacyErrorMessage, privacyQueryKey } from './privacy';
import { requestPath } from './privacyNavigation';
import { channelLabels, oneMonthLater } from './privacyRequests';
import './privacyRequests.scss';

type RequestFormValues = {
  kind: SubjectRequestKind;
  person: Person | null;
  channel: SubjectRequestChannel;
  receivedAt: string;
  reference: string;
  notes: string;
};

function personName(person: Person): string {
  return `${person.firstName} ${person.lastName}`;
}

/** Records a request and opens its page, where the guided steps start. */
export function RecordRequestModal({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const candidates = useQuery({ ...peopleListOptions({ search, pageSize: 25 }), placeholderData: keepPreviousData });
  const form = useForm<RequestFormValues>({
    defaultValues: {
      kind: 'access',
      person: null,
      channel: 'email',
      receivedAt: instantToZonedDateTimeValue(new Date()),
      reference: '',
      notes: '',
    },
  });
  const { control, register, setValue, watch, formState } = form;
  const kind = watch('kind');
  const receivedAt = watch('receivedAt');
  const mutation = useMutation({
    mutationFn: (values: RequestFormValues) =>
      createSubjectRequest({
        kind: values.kind,
        personId: values.person!.id,
        channel: values.channel,
        receivedAt: zonedDateTimeValueToISO(values.receivedAt),
        ...(values.reference.trim() ? { reference: values.reference.trim() } : {}),
        ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
      }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: privacyQueryKey });
      onClose();
      void navigate(requestPath(created.id));
    },
  });
  const submit = form.handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync(values);
    } catch {
      /* rendered in the dialog */
    }
  });
  const dueDate = isZonedDateTimeValue(receivedAt) ? oneMonthLater(receivedAt) : '';

  return (
    <Modal
      open
      size="md"
      modalLabel="Data request"
      modalHeading="Record a request"
      primaryButtonText={mutation.isPending ? 'Recording…' : 'Record and open'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={onClose}
      onSecondarySubmit={onClose}
      onRequestSubmit={() => void submit()}
    >
      <Stack gap={6}>
        {mutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Request not recorded"
            subtitle={privacyErrorMessage(mutation.error)}
          />
        )}
        <Controller
          control={control}
          name="person"
          rules={{ validate: (value) => value !== null || 'Choose the person.' }}
          render={({ field }) => (
            <ComboBox
              id="request-person"
              titleText="Who is asking?"
              helperText="Search by name or e-mail. The person must exist in the app; a stranger has no data here."
              placeholder="Search people"
              items={candidates.data?.items ?? []}
              itemToString={(item) => (item ? personName(item) : '')}
              itemToElement={(item) => (
                <span>
                  {personName(item)}
                  {item.email ? <span className="privacy-requests__secondary"> · {item.email}</span> : null}
                </span>
              )}
              shouldFilterItem={() => true}
              selectedItem={field.value}
              invalid={Boolean(formState.errors.person)}
              invalidText={formState.errors.person?.message}
              onInputChange={setSearch}
              onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)}
            />
          )}
        />
        <RadioButtonGroup
          legendText="What do they ask for?"
          name="request-kind"
          orientation="vertical"
          valueSelected={kind}
          onChange={(value) => setValue('kind', value as SubjectRequestKind)}
        >
          <RadioButton
            id="request-kind-access"
            value="access"
            labelText={
              <>
                <span className="privacy-choice__title">A copy of their data</span>
                <span className="privacy-choice__detail">
                  You build a ZIP with everything we hold about them and hand it over.
                </span>
              </>
            }
          />
          <RadioButton
            id="request-kind-erasure"
            value="erasure"
            labelText={
              <>
                <span className="privacy-choice__title">Erasure</span>
                <span className="privacy-choice__detail">
                  Their person record and everything linked to it is deleted; legally required records stay without the
                  name.
                </span>
              </>
            }
          />
        </RadioButtonGroup>
        <Select id="request-channel" labelText="How did it reach you?" {...register('channel')}>
          {(Object.keys(channelLabels) as SubjectRequestChannel[]).map((channel) => (
            <SelectItem key={channel} value={channel} text={channelLabels[channel]} />
          ))}
        </Select>
        <TextInput
          id="request-received-at"
          type="datetime-local"
          labelText="Received on"
          helperText={dueDate ? `Due one month later: ${dueDate}` : undefined}
          invalid={Boolean(formState.errors.receivedAt)}
          invalidText={formState.errors.receivedAt?.message}
          {...register('receivedAt', {
            validate: (value) => isZonedDateTimeValue(value) || 'Enter the date and time of receipt.',
          })}
        />
        <TextInput
          id="request-reference"
          labelText="Your reference"
          placeholder="e.g. DSR-2026-015"
          helperText="A ticket number is fine. Never the person's name."
          maxLength={100}
          {...register('reference')}
        />
        <TextArea
          id="request-notes"
          labelText="Notes (optional)"
          placeholder="What exactly was asked, anything the person mentioned"
          maxLength={2000}
          rows={3}
          {...register('notes')}
        />
      </Stack>
    </Modal>
  );
}
