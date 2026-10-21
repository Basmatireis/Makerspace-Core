/* eslint-disable react-refresh/only-export-components -- form component and DTO mappers intentionally share one contract */
import { Column, Grid, TextInput } from '@carbon/react';
import { Controller } from 'react-hook-form';
import type { FieldNamesMarkedBoolean, UseFormReturn } from 'react-hook-form';
import { DateInput } from '../../app/DateInput';
import type { CreatePersonRequest, UpdatePersonRequest } from '../../api/generated/models';

export type PersonFormValues = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  matriculationNumber: string;
  /** Day the person joined (YYYY-MM-DD). Only part of the edit form; empty on creation. */
  memberSince: string;
};

type PersonFieldsProps = {
  form: UseFormReturn<PersonFormValues>;
  showMatriculation: boolean;
  editMatriculation: boolean;
  /** The person has an account: the email is the login email and must not be cleared. */
  hasAccount?: boolean;
  /** The email cannot be changed by the current user (account holder without `accounts.login_email.update`). */
  emailLocked?: boolean;
  /** Show the member-since date; `editMemberSince` allows changing it. */
  showMemberSince?: boolean;
  editMemberSince?: boolean;
};

export function PersonFields({
  form,
  showMatriculation,
  editMatriculation,
  hasAccount = false,
  emailLocked = false,
  showMemberSince = false,
  editMemberSince = false,
}: PersonFieldsProps) {
  const {
    register,
    formState: { errors },
  } = form;
  const contactValidation = () =>
    Boolean(form.getValues('email').trim() || form.getValues('phone').trim()) ||
    'Provide an email address or phone number.';

  return (
    <Grid condensed className="form-grid">
      <Column sm={4} md={4} lg={8}>
        <TextInput
          id="person-first-name"
          labelText="First name"
          invalid={Boolean(errors.firstName)}
          invalidText={errors.firstName?.message}
          {...register('firstName', {
            required: 'Enter a first name.',
            maxLength: { value: 100, message: 'Use at most 100 characters.' },
          })}
        />
      </Column>
      <Column sm={4} md={4} lg={8}>
        <TextInput
          id="person-last-name"
          labelText="Last name"
          invalid={Boolean(errors.lastName)}
          invalidText={errors.lastName?.message}
          {...register('lastName', {
            required: 'Enter a last name.',
            maxLength: { value: 100, message: 'Use at most 100 characters.' },
          })}
        />
      </Column>
      <Column sm={4} md={4} lg={8}>
        <TextInput
          id="person-email"
          type="email"
          labelText="Email"
          disabled={emailLocked}
          helperText={
            emailLocked
              ? 'You do not have permission to change the email of an account.'
              : hasAccount
                ? 'Also the address this person logs in with.'
                : undefined
          }
          invalid={Boolean(errors.email)}
          invalidText={errors.email?.message}
          {...register('email', {
            maxLength: { value: 254, message: 'Use at most 254 characters.' },
            validate: hasAccount
              ? (value) => Boolean(value.trim()) || 'An account needs an email address.'
              : contactValidation,
          })}
        />
      </Column>
      <Column sm={4} md={4} lg={8}>
        <TextInput
          id="person-phone"
          type="tel"
          labelText="Phone"
          invalid={Boolean(errors.phone)}
          invalidText={errors.phone?.message}
          {...register('phone', {
            maxLength: { value: 64, message: 'Use at most 64 characters.' },
            validate: contactValidation,
          })}
        />
      </Column>
      {showMemberSince && (
        <Column sm={4} md={4} lg={8}>
          {editMemberSince ? (
            <Controller
              control={form.control}
              name="memberSince"
              rules={{ required: 'Enter the day this person joined.' }}
              render={({ field }) => (
                <DateInput
                  id="person-member-since"
                  labelText="Member since"
                  value={field.value}
                  onChange={field.onChange}
                  invalid={Boolean(errors.memberSince)}
                  invalidText={errors.memberSince?.message}
                  required
                />
              )}
            />
          ) : null}
        </Column>
      )}
      {showMatriculation && (
        <Column sm={4} md={4} lg={8}>
          <TextInput
            id="person-matriculation-number"
            labelText="Matriculation number"
            disabled={!editMatriculation}
            helperText={editMatriculation ? undefined : 'You do not have permission to change this value.'}
            invalid={Boolean(errors.matriculationNumber)}
            invalidText={errors.matriculationNumber?.message}
            {...register('matriculationNumber', {
              maxLength: { value: 64, message: 'Use at most 64 characters.' },
            })}
          />
        </Column>
      )}
    </Grid>
  );
}

function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

export function toPersonCreate(values: PersonFormValues, canWriteMatriculation: boolean): CreatePersonRequest {
  return {
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
    email: optional(values.email),
    phone: optional(values.phone),
    ...(canWriteMatriculation ? { matriculationNumber: optional(values.matriculationNumber) } : {}),
  };
}

export type PersonPatchOptions = {
  /** Include the email: false for account holders, whose email changes through the login-email operation. */
  includeEmail?: boolean;
  canWriteMemberSince?: boolean;
};

export function toPersonPatch(
  values: PersonFormValues,
  dirtyFields: Partial<Readonly<FieldNamesMarkedBoolean<PersonFormValues>>>,
  expectedVersion: number,
  canWriteMatriculation: boolean,
  { includeEmail = true, canWriteMemberSince = false }: PersonPatchOptions = {},
): UpdatePersonRequest {
  const request: UpdatePersonRequest = { expectedVersion };
  if (dirtyFields.firstName) request.firstName = values.firstName.trim();
  if (dirtyFields.lastName) request.lastName = values.lastName.trim();
  if (dirtyFields.email && includeEmail) request.email = optional(values.email);
  if (dirtyFields.phone) request.phone = optional(values.phone);
  if (dirtyFields.matriculationNumber && canWriteMatriculation) {
    request.matriculationNumber = optional(values.matriculationNumber);
  }
  if (dirtyFields.memberSince && canWriteMemberSince && values.memberSince) {
    request.memberSince = values.memberSince;
  }
  return request;
}
