import { useEffect, useState, type ChangeEvent } from 'react';
import { useLatestCallback } from '../../app/useLatestCallback';
import {
  ComposedModal,
  DatePicker,
  DatePickerInput,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  TextInput,
} from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { createOpenDayPeriod } from '../../api/generated/open-days/open-days';
import { DateInput } from '../../app/DateInput';
import { usePickerDateRange } from '../../app/usePickerDateRange';
import { APP_DATE_PLACEHOLDER, parseDisplayDate, pickerDateToDateOnly } from '../../app/dateTime';
import { openDayKeys } from './queries';

type PeriodForm = { name: string; startsOn: string; endsOn: string; signUpDeadline: string };
const SIGN_UP_DEADLINE_HELP =
  "Supervisors see this date on their dashboard as the deadline for their open-day minimum. Empty uses the period's end date.";
type WizardError = { title: string; subtitle: string };

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (periodId: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export function CreateOpenDayPeriodWizard({ open, onClose, onCreated, onDirtyChange }: Props) {
  const queryClient = useQueryClient();
  const [discardOpen, setDiscardOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [wizardError, setWizardError] = useState<WizardError | null>(null);
  const {
    control,
    register,
    getValues,
    reset,
    setError,
    clearErrors,
    setValue,
    trigger,
    formState: { errors, isDirty },
  } = useForm<PeriodForm>({
    defaultValues: { name: '', startsOn: '', endsOn: '', signUpDeadline: '' },
  });

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const createMutation = useMutation({
    mutationFn: () => {
      const { signUpDeadline, ...values } = getValues();
      return createOpenDayPeriod({ ...values, signUpDeadline: signUpDeadline || null });
    },
    onSuccess: async (period) => {
      await queryClient.invalidateQueries({ queryKey: openDayKeys.periods() });
      reset();
      onCreated(period.id);
    },
    onError: () =>
      setWizardError({
        title: 'Period could not be created',
        subtitle: 'Check the information and try again.',
      }),
  });

  const clearError = () => setWizardError(null);
  const close = () => {
    if (createMutation.isPending) return;
    if (isDirty && !discardOpen) {
      setDiscardOpen(true);
      return;
    }
    setDiscardOpen(false);
    reset();
    setAttempted(false);
    setWizardError(null);
    onClose();
  };
  const createPeriod = async () => {
    clearError();
    setAttempted(true);
    const valid = await trigger(['name', 'startsOn', 'endsOn']);
    const values = getValues();
    if (!valid) {
      setWizardError({
        title: 'Missing required information',
        subtitle: 'Enter a period name and complete date range.',
      });
      return;
    }
    if (values.startsOn > values.endsOn) {
      setError('endsOn', { message: 'End date must be on or after the start date.' });
      setWizardError({ title: 'Invalid date range', subtitle: 'Choose an end date on or after the start date.' });
      return;
    }
    if (values.signUpDeadline && (values.signUpDeadline < values.startsOn || values.signUpDeadline > values.endsOn)) {
      setError('signUpDeadline', { message: 'Sign-up deadline must lie within the period.' });
      setWizardError({
        title: 'Invalid sign-up deadline',
        subtitle: 'Choose a date within the period or leave it empty.',
      });
      return;
    }
    createMutation.mutate();
  };
  const requestClose = useLatestCallback(() => {
    if (discardOpen) setDiscardOpen(false);
    else close();
    return false;
  });
  // Watched, not read with getValues: picking a date must re-render the picker.
  const [startsOn, endsOn, signUpDeadline] = useWatch({ control, name: ['startsOn', 'endsOn', 'signUpDeadline'] });
  const range = usePickerDateRange(startsOn, endsOn);

  return (
    <ComposedModal
      aria-label={discardOpen ? 'Discard period inputs?' : 'Create Period'}
      open={open}
      size="xs"
      danger={discardOpen}
      selectorPrimaryFocus={discardOpen ? '.cds--btn--secondary' : undefined}
      onClose={requestClose}
      preventCloseOnClickOutside
    >
      <ModalHeader title={discardOpen ? 'Discard period inputs?' : 'Create Period'} buttonOnClick={requestClose} />
      <ModalBody>
        {discardOpen ? (
          <p>The period has not been created. Your inputs will be discarded.</p>
        ) : (
          <Stack gap={5}>
            <TextInput
              id="period-name"
              labelText="Name"
              invalid={attempted && Boolean(errors.name)}
              invalidText="Enter a name."
              {...register('name', { required: true, onChange: clearError })}
            />
            <input type="hidden" {...register('startsOn', { required: true })} />
            <input type="hidden" {...register('endsOn', { required: true })} />
            <DatePicker
              allowInput
              datePickerType="range"
              dateFormat="d.m.Y"
              locale="en"
              value={range}
              onChange={(dates) => {
                setValue('startsOn', dates[0] ? pickerDateToDateOnly(dates[0]) : '', {
                  shouldDirty: true,
                  shouldValidate: attempted,
                });
                setValue('endsOn', dates[1] ? pickerDateToDateOnly(dates[1]) : '', {
                  shouldDirty: true,
                  shouldValidate: attempted,
                });
                clearError();
              }}
            >
              <DatePickerInput
                id="period-start"
                labelText="Start date"
                placeholder={APP_DATE_PLACEHOLDER}
                pattern="\d{2}\.\d{2}\.\d{4}"
                invalid={attempted && Boolean(errors.startsOn)}
                invalidText="Choose a start date."
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setValue('startsOn', parseDisplayDate(event.target.value) ?? '', {
                    shouldDirty: true,
                    shouldValidate: attempted,
                  });
                  clearError();
                }}
              />
              <DatePickerInput
                id="period-end"
                labelText="End date"
                placeholder={APP_DATE_PLACEHOLDER}
                pattern="\d{2}\.\d{2}\.\d{4}"
                invalid={attempted && Boolean(errors.endsOn)}
                invalidText={errors.endsOn?.message ?? 'Choose an end date.'}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setValue('endsOn', parseDisplayDate(event.target.value) ?? '', {
                    shouldDirty: true,
                    shouldValidate: attempted,
                  });
                  clearError();
                }}
              />
            </DatePicker>
            <DateInput
              id="period-sign-up-deadline"
              labelText="Sign-up deadline (optional)"
              helperText={SIGN_UP_DEADLINE_HELP}
              value={signUpDeadline}
              invalid={Boolean(errors.signUpDeadline)}
              invalidText={errors.signUpDeadline?.message}
              onChange={(value) => {
                setValue('signUpDeadline', value, { shouldDirty: true });
                clearErrors('signUpDeadline');
                clearError();
              }}
            />
          </Stack>
        )}
        {!discardOpen && wizardError && (
          <InlineNotification
            className="period-wizard__error"
            kind="error"
            lowContrast
            hideCloseButton
            title={wizardError.title}
            subtitle={wizardError.subtitle}
          />
        )}
      </ModalBody>
      <ModalFooter
        primaryButtonText={discardOpen ? 'Discard inputs' : createMutation.isPending ? 'Creating…' : 'Create Period'}
        primaryButtonDisabled={createMutation.isPending}
        onRequestSubmit={() => {
          if (discardOpen) close();
          else void createPeriod();
        }}
        onRequestClose={() => {
          if (discardOpen) setDiscardOpen(false);
          else close();
        }}
        secondaryButtonText={discardOpen ? 'Keep editing' : 'Cancel'}
      >
        {null}
      </ModalFooter>
    </ComposedModal>
  );
}
