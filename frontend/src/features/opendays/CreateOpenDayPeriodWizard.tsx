import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Add, Edit, TrashCan } from '@carbon/icons-react';
import {
  Button,
  ComposedModal,
  DatePicker,
  DatePickerInput,
  InlineLoading,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  NumberInput,
  ProgressIndicator,
  ProgressStep,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TextInput,
  TimePicker,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { createOpenDayAcademicBreak, createOpenDayPeriod } from '../../api/generated/open-days/open-days';
import type { EligibilityRole, OpenDayPeriod } from '../../api/generated/models';
import { eligibilityRolesQueryOptions, openDayKeys } from './queries';
import { RoleMultiSelect } from './RoleMultiSelect';
import { standardOpenDayScheduleDefaults, type OpenDayScheduleDefaults } from './scheduleDefaults';

type PeriodForm = { name: string; startsOn: string; endsOn: string };
type BreakDraft = PeriodForm & { clientId: string };
type WizardError = { title: string; subtitle: string };

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (periodId: string, defaults: OpenDayScheduleDefaults) => void;
};

const steps = ['Date range', 'Academic breaks', 'Base timeslot', 'Summary'];

export function CreateOpenDayPeriodWizard({ open, onClose, onCreated }: Props) {
  const queryClient = useQueryClient();
  const rolesQuery = useQuery(eligibilityRolesQueryOptions(open));
  const [step, setStep] = useState(0);
  const [attemptedStep, setAttemptedStep] = useState<number | null>(null);
  const [wizardError, setWizardError] = useState<WizardError | null>(null);
  const [breaks, setBreaks] = useState<BreakDraft[]>([]);
  const [breakDraft, setBreakDraft] = useState<BreakDraft | null>(null);
  const [defaults, setDefaults] = useState<OpenDayScheduleDefaults>(standardOpenDayScheduleDefaults);
  const [periodCreated, setPeriodCreated] = useState(false);
  const periodRef = useRef<OpenDayPeriod | null>(null);
  const createdBreakIds = useRef(new Set<string>());
  const defaultsSeeded = useRef(false);
  const { register, getValues, reset, setError, setValue, trigger, formState: { errors } } = useForm<PeriodForm>({
    defaultValues: { name: '', startsOn: '', endsOn: '' },
  });

  useEffect(() => {
    if (!rolesQuery.data || defaultsSeeded.current) return;
    defaultsSeeded.current = true;
    const supervisor = preferredRole(rolesQuery.data.items, 'supervisor');
    const trainee = preferredRole(rolesQuery.data.items, 'trainee');
    setDefaults((current) => ({
      ...current,
      supervisorRoleIds: supervisor ? [supervisor.id] : [],
      traineeRoleIds: trainee ? [trainee.id] : [],
    }));
  }, [rolesQuery.data]);

  const createMutation = useMutation({
    mutationFn: async () => {
      let period = periodRef.current;
      if (!period) {
        period = await createOpenDayPeriod(getValues());
        periodRef.current = period;
        setPeriodCreated(true);
      }
      for (const item of breaks) {
        if (createdBreakIds.current.has(item.clientId)) continue;
        await createOpenDayAcademicBreak({ name: item.name, startsOn: item.startsOn, endsOn: item.endsOn });
        createdBreakIds.current.add(item.clientId);
      }
      return period;
    },
    onSuccess: async (period) => {
      await queryClient.invalidateQueries({ queryKey: openDayKeys.periods() });
      onCreated(period.id, defaults);
    },
    onError: () => {
      setWizardError(periodRef.current
        ? { title: 'Period created, but setup is incomplete', subtitle: 'Retry to create the remaining academic breaks, or open the schedule editor and add them there.' }
        : { title: 'Period could not be created', subtitle: 'Review the summary and try again.' });
    },
  });

  const clearError = () => setWizardError(null);
  const close = () => {
    if (createMutation.isPending) return;
    if (periodRef.current) {
      void queryClient.invalidateQueries({ queryKey: openDayKeys.periods() });
      onCreated(periodRef.current.id, defaults);
      return;
    }
    reset();
    onClose();
  };
  const goBack = () => {
    clearError();
    setAttemptedStep(null);
    setBreakDraft(null);
    setStep((current) => Math.max(0, current - 1));
  };
  const validatePeriod = async () => {
    setAttemptedStep(0);
    const valid = await trigger(['name', 'startsOn', 'endsOn']);
    const values = getValues();
    if (!valid) {
      setWizardError({ title: 'Missing required information', subtitle: 'Enter a period name and complete date range.' });
      return false;
    }
    if (values.startsOn > values.endsOn) {
      setError('endsOn', { message: 'End date must be on or after the start date.' });
      setWizardError({ title: 'Invalid date range', subtitle: 'Choose an end date on or after the start date.' });
      return false;
    }
    return true;
  };
  const validateDefaults = () => {
    if (!defaults.startTime || !defaults.endTime) {
      setWizardError({ title: 'Missing default time', subtitle: 'Enter both the standard start and end time.' });
      return false;
    }
    if ((defaults.supervisors > 0 && defaults.supervisorRoleIds.length === 0) || (defaults.trainees > 0 && defaults.traineeRoleIds.length === 0)) {
      setWizardError({ title: 'Missing eligible roles', subtitle: 'Every enabled position type needs at least one eligible role.' });
      return false;
    }
    return true;
  };
  const handlePrimary = async () => {
    clearError();
    if (periodCreated || step === 3) {
      createMutation.mutate();
      return;
    }
    if (step === 0 && !(await validatePeriod())) return;
    if (step === 1 && breakDraft) {
      setWizardError({ title: 'Academic break not saved', subtitle: 'Save or cancel the break being edited before continuing.' });
      return;
    }
    if (step === 2 && !validateDefaults()) return;
    setAttemptedStep(null);
    setStep((current) => current + 1);
  };
  const saveBreak = () => {
    if (!breakDraft?.name.trim() || !breakDraft.startsOn || !breakDraft.endsOn) {
      setWizardError({ title: 'Missing academic-break information', subtitle: 'Enter a name and complete date range.' });
      return;
    }
    if (breakDraft.startsOn > breakDraft.endsOn) {
      setWizardError({ title: 'Invalid academic-break range', subtitle: 'Choose an end date on or after the start date.' });
      return;
    }
    setBreaks((current) => [...current.filter((item) => item.clientId !== breakDraft.clientId), { ...breakDraft, name: breakDraft.name.trim() }]);
    setBreakDraft(null);
    clearError();
  };
  const period = getValues();
  const roles = rolesQuery.data?.items ?? [];

  return (
    <ComposedModal open={open} size="lg" onClose={() => { close(); return false; }} preventCloseOnClickOutside>
      <ModalHeader title="Create Open Day period" buttonOnClick={() => close()} />
      <ModalBody hasScrollingContent className="period-wizard__body">
        <ProgressIndicator currentIndex={step} spaceEqually className="period-wizard__progress">
          {steps.map((label, index) => (
            <ProgressStep key={label} label={label} complete={index < step} current={index === step} disabled={index > step || periodCreated} />
          ))}
        </ProgressIndicator>

        <div className="period-wizard__content">
          {step === 0 && (
            <Stack gap={5}>
              <div><h3>Period and date range</h3><p>Name the period and choose the dates shown in its planning calendar.</p></div>
              <TextInput id="period-name" labelText="Name" invalid={attemptedStep === 0 && Boolean(errors.name)} invalidText="Enter a name." {...register('name', { required: true, onChange: clearError })} />
              <input type="hidden" {...register('startsOn', { required: true })} />
              <input type="hidden" {...register('endsOn', { required: true })} />
              <DatePicker
                datePickerType="range"
                dateFormat="Y-m-d"
                onChange={(dates) => {
                  setValue('startsOn', dateValue(dates[0]), { shouldDirty: true, shouldValidate: attemptedStep === 0 });
                  setValue('endsOn', dateValue(dates[1]), { shouldDirty: true, shouldValidate: attemptedStep === 0 });
                  clearError();
                }}
              >
                <DatePickerInput
                  id="period-start"
                  labelText="Start date"
                  placeholder="yyyy-mm-dd"
                  invalid={attemptedStep === 0 && Boolean(errors.startsOn)}
                  invalidText="Choose a start date."
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    setValue('startsOn', event.target.value, { shouldDirty: true, shouldValidate: attemptedStep === 0 });
                    clearError();
                  }}
                />
                <DatePickerInput
                  id="period-end"
                  labelText="End date"
                  placeholder="yyyy-mm-dd"
                  invalid={attemptedStep === 0 && Boolean(errors.endsOn)}
                  invalidText={errors.endsOn?.message ?? 'Choose an end date.'}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    setValue('endsOn', event.target.value, { shouldDirty: true, shouldValidate: attemptedStep === 0 });
                    clearError();
                  }}
                />
              </DatePicker>
            </Stack>
          )}

          {step === 1 && (
            <Stack gap={5}>
              <div><h3>Academic breaks</h3><p>Add optional lecture-free ranges. They remain informational and do not prevent scheduling.</p></div>
              {!breakDraft && <Button renderIcon={Add} onClick={() => setBreakDraft({ clientId: crypto.randomUUID(), name: '', startsOn: period.startsOn, endsOn: period.startsOn })}>Add academic break</Button>}
              {breakDraft && (
                <Stack gap={4} className="period-wizard__break-editor">
                  <TextInput id="wizard-break-name" labelText="Name" value={breakDraft.name} onChange={(event) => { setBreakDraft({ ...breakDraft, name: event.target.value }); clearError(); }} />
                  <div className="period-wizard__break-dates">
                    <TextInput id="wizard-break-start" type="date" labelText="Start date" value={breakDraft.startsOn} onChange={(event) => { setBreakDraft({ ...breakDraft, startsOn: event.target.value }); clearError(); }} />
                    <TextInput id="wizard-break-end" type="date" labelText="End date" value={breakDraft.endsOn} onChange={(event) => { setBreakDraft({ ...breakDraft, endsOn: event.target.value }); clearError(); }} />
                  </div>
                  <div className="period-wizard__inline-actions"><Button kind="secondary" onClick={() => { setBreakDraft(null); clearError(); }}>Cancel</Button><Button onClick={saveBreak}>{breaks.some((item) => item.clientId === breakDraft.clientId) ? 'Update break' : 'Add break'}</Button></div>
                </Stack>
              )}
              <TableContainer title="Breaks to create">
                <Table size="sm">
                  <TableHead><TableRow><TableHeader>Name</TableHeader><TableHeader>Start</TableHeader><TableHeader>End</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
                  <TableBody>
                    {breaks.map((item) => (
                      <TableRow key={item.clientId}>
                        <TableCell>{item.name}</TableCell><TableCell>{item.startsOn}</TableCell><TableCell>{item.endsOn}</TableCell>
                        <TableCell><div className="table-actions"><Button hasIconOnly kind="ghost" size="sm" renderIcon={Edit} iconDescription={`Edit ${item.name}`} onClick={() => setBreakDraft(item)} /><Button hasIconOnly kind="danger--ghost" size="sm" renderIcon={TrashCan} iconDescription={`Remove ${item.name}`} onClick={() => setBreaks((current) => current.filter((candidate) => candidate.clientId !== item.clientId))} /></div></TableCell>
                      </TableRow>
                    ))}
                    {breaks.length === 0 && <TableRow><TableCell colSpan={4}>No academic breaks added.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </TableContainer>
            </Stack>
          )}

          {step === 2 && (
            <Stack gap={5}>
              <div><h3>Base timeslot</h3><p>Configure the time and staffing used when a new Open Day is added. A count of zero disables that position type.</p></div>
              <div className="period-wizard__times"><TimePicker id="wizard-default-start" labelText="Standard start time" value={defaults.startTime} onChange={(event) => { setDefaults({ ...defaults, startTime: event.target.value }); clearError(); }} /><TimePicker id="wizard-default-end" labelText="Standard end time" value={defaults.endTime} onChange={(event) => { setDefaults({ ...defaults, endTime: event.target.value }); clearError(); }} /></div>
              {rolesQuery.isPending && <InlineLoading description="Loading eligible roles" />}
              {rolesQuery.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Eligible roles could not be loaded" subtitle="Close the wizard and try again." />}
              {!rolesQuery.isPending && !rolesQuery.isError && (
                <div className="period-wizard__requirements">
                  <Stack gap={4}><NumberInput id="wizard-supervisor-count" label="Supervisor positions" min={0} max={100} value={defaults.supervisors} onChange={(_, value) => { setDefaults({ ...defaults, supervisors: Number(value.value) }); clearError(); }} /><RoleMultiSelect id="wizard-supervisor-roles" titleText="Eligible supervisor roles" roles={roles} selectedRoleIds={defaults.supervisorRoleIds} onChange={(supervisorRoleIds) => { setDefaults({ ...defaults, supervisorRoleIds }); clearError(); }} /></Stack>
                  <Stack gap={4}><NumberInput id="wizard-trainee-count" label="Trainee positions" min={0} max={100} value={defaults.trainees} onChange={(_, value) => { setDefaults({ ...defaults, trainees: Number(value.value) }); clearError(); }} /><RoleMultiSelect id="wizard-trainee-roles" titleText="Eligible trainee roles" roles={roles} selectedRoleIds={defaults.traineeRoleIds} onChange={(traineeRoleIds) => { setDefaults({ ...defaults, traineeRoleIds }); clearError(); }} /></Stack>
                </div>
              )}
            </Stack>
          )}

          {step === 3 && (
            <Stack gap={5}>
              <div><h3>Summary</h3><p>Review the setup. The period will be created as a draft.</p></div>
              <dl className="period-wizard__summary">
                <SummaryItem label="Period" value={period.name} />
                <SummaryItem label="Date range" value={`${period.startsOn} – ${period.endsOn}`} />
                <SummaryItem label="Academic breaks" value={breaks.length ? breaks.map((item) => `${item.name} (${item.startsOn} – ${item.endsOn})`).join(', ') : 'None'} />
                <SummaryItem label="Standard time" value={`${defaults.startTime}–${defaults.endTime}`} />
                <SummaryItem label="Supervisors" value={requirementSummary(defaults.supervisors, defaults.supervisorRoleIds, roles)} />
                <SummaryItem label="Trainees" value={requirementSummary(defaults.trainees, defaults.traineeRoleIds, roles)} />
                <SummaryItem label="Initial state" value="Draft" />
              </dl>
            </Stack>
          )}
        </div>

        {wizardError && <InlineNotification className="period-wizard__error" kind="error" lowContrast hideCloseButton title={wizardError.title} subtitle={wizardError.subtitle} />}
      </ModalBody>
      <ModalFooter
        primaryButtonText={createMutation.isPending ? 'Creating…' : periodCreated ? 'Retry setup' : step === 3 ? 'Create period' : 'Next'}
        primaryButtonDisabled={createMutation.isPending || (step === 2 && rolesQuery.isPending)}
        onRequestSubmit={() => void handlePrimary()}
        onRequestClose={close}
        secondaryButtonText={step === 0 || periodCreated ? (periodCreated ? 'Open schedule editor' : 'Cancel') : undefined}
        secondaryButtons={step > 0 && !periodCreated ? [{ buttonText: 'Cancel', onClick: close }, { buttonText: 'Previous', onClick: goBack }] : undefined}
      >{null}</ModalFooter>
    </ComposedModal>
  );
}

function preferredRole(roles: EligibilityRole[], kind: 'supervisor' | 'trainee') {
  return roles.find((role) => role.name.toLocaleLowerCase().includes(kind)) ?? roles[0];
}

function requirementSummary(count: number, roleIds: string[], roles: EligibilityRole[]) {
  if (count === 0) return 'Not used';
  const names = roles.filter((role) => roleIds.includes(role.id)).map((role) => role.name);
  return `${count} position${count === 1 ? '' : 's'} · ${names.join(', ')}`;
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function dateValue(date?: Date) {
  if (!date) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
