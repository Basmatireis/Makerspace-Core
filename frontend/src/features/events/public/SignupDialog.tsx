import { Copy } from '@carbon/icons-react';
import {
  Button,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Stack,
  TextInput,
  Tile,
} from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  createAuthenticatedEventSignup,
  createPublicEventSignup,
} from '../../../api/generated/public-events/public-events';
import type { PublicEvent, PublicEventRequirement, PublicEventShift } from '../../../api/generated/models';
import { FieldRow } from '../components/FormSection';
import { formatLocalDate, formatTimeRange } from '../format';
import { eventKeys } from '../queries';

type Values = { firstName: string; lastName: string; email: string; phone: string };
type Person = { firstName: string; lastName: string; email?: string | null; phone?: string | null };

/** Signup for one place. Signed-in members sign up themselves or someone else; visitors get a one-time management link. */
export function SignupDialog({
  event,
  shift,
  requirement,
  person,
  onClose,
}: {
  event: PublicEvent;
  shift: PublicEventShift;
  requirement: PublicEventRequirement;
  /** The signed-in member, if any. */
  person?: Person;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [signupFor, setSignupFor] = useState<'self' | 'other'>('self');
  const [managementUrl, setManagementUrl] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const own = Boolean(person) && signupFor === 'self';
  const form = useForm<Values>({
    defaultValues: {
      firstName: person?.firstName ?? '',
      lastName: person?.lastName ?? '',
      email: person?.email ?? '',
      phone: person?.phone ?? '',
    },
  });
  const signup = useMutation({
    mutationFn: (value: Values) => {
      const request = {
        shiftId: shift.id,
        requirementId: requirement.id,
        firstName: value.firstName.trim(),
        lastName: value.lastName.trim(),
        email: value.email.trim() || null,
        phone: value.phone.trim() || null,
      };
      return person
        ? createAuthenticatedEventSignup(event.publicId, { ...request, signupFor })
        : createPublicEventSignup(event.publicId, request);
    },
    onSuccess: async (result) => {
      setManagementUrl(result.managementUrl ? new URL(result.managementUrl, window.location.origin).toString() : null);
      setDone(true);
      await Promise.all([
        client.invalidateQueries({ queryKey: eventKeys.public(event.publicId) }),
        client.invalidateQueries({ queryKey: eventKeys.own(event.publicId) }),
      ]);
    },
  });
  const choose = (next: 'self' | 'other') => {
    setSignupFor(next);
    signup.reset();
    form.reset(
      next === 'self' && person
        ? {
            firstName: person.firstName,
            lastName: person.lastName,
            email: person.email ?? '',
            phone: person.phone ?? '',
          }
        : { firstName: '', lastName: '', email: '', phone: '' },
    );
  };
  const submit = form.handleSubmit((value) => {
    if (!signup.isPending) signup.mutate(value);
  });
  const errors = form.formState.errors;
  const contactRule = (_: string, values: Values) => Boolean(values.email.trim() || values.phone.trim());

  return (
    <Modal
      open
      size="sm"
      modalHeading="Sign up for a shift"
      modalLabel={event.title}
      primaryButtonText={done ? 'Close' : signup.isPending ? 'Signing up…' : 'Confirm signup'}
      secondaryButtonText={done ? undefined : 'Cancel'}
      passiveModal={false}
      primaryButtonDisabled={signup.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!signup.isPending) onClose();
      }}
      onRequestSubmit={() => (done ? onClose() : void submit())}
    >
      <Stack gap={5}>
        <Tile className="ev-public__shift">
          <strong>{shift.name}</strong>
          <span>
            {formatLocalDate(shift.startsAt, event.timeZone)} ·{' '}
            {formatTimeRange(shift.startsAt, shift.endsAt, event.timeZone)}
          </span>
          <span>
            {requirement.name} · {requirement.remainingCount} places left
          </span>
        </Tile>
        {signup.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Signup unavailable"
            subtitle="This place may be full, closed, already taken by you, need a role you do not have, or overlap another event shift."
          />
        )}
        {done ? (
          <>
            <InlineNotification
              kind="success"
              lowContrast
              hideCloseButton
              title="Signup confirmed"
              subtitle={
                managementUrl
                  ? 'Copy the private management link below now. It is shown only once and cannot be recovered later.'
                  : 'Your signup has been added to this event.'
              }
            />
            {managementUrl && (
              <>
                <TextInput
                  id="signup-management-link"
                  labelText="One-time management link"
                  readOnly
                  value={managementUrl}
                />
                <Button
                  type="button"
                  kind="secondary"
                  renderIcon={Copy}
                  onClick={() => void navigator.clipboard.writeText(managementUrl)}
                >
                  Copy management link
                </Button>
              </>
            )}
          </>
        ) : (
          <>
            {person && (
              <RadioButtonGroup
                legendText="Who are you signing up?"
                name="signup-for"
                valueSelected={signupFor}
                onChange={(next) => choose(next as 'self' | 'other')}
              >
                <RadioButton id="signup-self" labelText="Myself" value="self" />
                <RadioButton id="signup-other" labelText="Someone else" value="other" />
              </RadioButtonGroup>
            )}
            <FieldRow>
              <TextInput
                id="signup-first-name"
                labelText="First name"
                disabled={own}
                invalid={Boolean(errors.firstName)}
                invalidText="Enter a first name."
                {...form.register('firstName', { validate: (value) => value.trim().length > 0 })}
              />
              <TextInput
                id="signup-last-name"
                labelText="Last name"
                disabled={own}
                invalid={Boolean(errors.lastName)}
                invalidText="Enter a last name."
                {...form.register('lastName', { validate: (value) => value.trim().length > 0 })}
              />
            </FieldRow>
            <FieldRow>
              <TextInput
                id="signup-email"
                type="email"
                labelText="Email"
                invalid={Boolean(errors.email)}
                invalidText="Enter an email address or a phone number."
                {...form.register('email', { validate: contactRule })}
              />
              <TextInput id="signup-phone" type="tel" labelText="Phone" {...form.register('phone')} />
            </FieldRow>
            <p className="ev-secondary">
              Provide at least one email address or phone number. We use your details only to organize this event.
              External signups receive a private management link to change or cancel the signup.
            </p>
          </>
        )}
      </Stack>
    </Modal>
  );
}
