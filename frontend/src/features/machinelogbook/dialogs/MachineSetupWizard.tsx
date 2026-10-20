import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { Button, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader, ProgressIndicator, ProgressStep } from '@carbon/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Machine, PrinterProfile } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { createMachine, updateMachine } from '../../../api/generated/machines/machines';
import { savePrinterSetup } from '../../../api/generated/printing/printing';
import { ConnectionStep } from '../components/wizard/ConnectionStep';
import { MachineStep } from '../components/wizard/MachineStep';
import { ReviewStep } from '../components/wizard/ReviewStep';
import { SpoolInputsEditor } from '../components/wizard/SpoolInputsEditor';
import { useConnectionTest } from '../components/wizard/useConnectionTest';
import type { SetupValues, StepKey } from '../components/wizard/wizardTypes';
import { connectorKeys, connectorsQuery, type PrinterConnection } from '../connectorQueries';
import {
  draftFromDetected, draftFromProfile, draftFromTemplate, draftToInput, duplicatePairs, isBambuAdapter, modelById, type Detection, type DraftUnit, type PrinterModelId,
} from '../printerSetup';
import { machineLogbookKeys, machineTypesQuery } from '../queries';
import { machineLogbookPaths } from '../shared/paths';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';

const CONNECTION_FIELDS = new Set<string>(['connectorId', 'adapterKind', 'ipAddress', 'serialNumber', 'accessCode', 'autoMountRfid']);
const STEP_LABEL: Record<StepKey, string> = { machine: 'Machine', connection: 'Connection', spools: 'Spool inputs', review: 'Review' };
const EDIT_TITLE: Record<StepKey, string> = { machine: 'Edit machine', connection: 'Edit connection', spools: 'Edit spool inputs', review: 'Review' };

type Props = {
  open: boolean;
  onClose: () => void;
  /** The machine to edit; without it the wizard creates one. */
  machine?: Machine;
  profile?: PrinterProfile;
  connection?: PrinterConnection;
  initialStep?: StepKey;
  /** What the connector last reported, used to map slots when editing. */
  detection?: Detection;
  /** External id of a reported printer unit to add as input unit right away. */
  addDetected?: string;
};

/** Create mode walks through every step and saves each one as it goes. Edit mode shows only `initialStep`. */
export function MachineSetupWizard({ open, ...props }: Props) {
  if (!open) return null;
  return <WizardBody key={props.machine?.id ?? 'new'} {...props} />;
}

function setupErrorText(error: unknown, fallback: string) {
  const code = error instanceof ApiError ? (error.data as { code?: string } | undefined)?.code : undefined;
  if (code === 'slot_occupied') return 'A slot that would be removed still has a spool mounted. Unmount the spool first, then save again.';
  if (code === 'duplicate_external_identifier') return 'Two slots use the same printer slot. Give each slot its own printer slot.';
  if (code === 'version_conflict' || (error instanceof ApiError && error.status === 409)) return 'Someone else changed this machine. Close the dialog and reopen it to continue with the current data.';
  return fallback;
}

function WizardBody({ onClose, machine, profile: initialProfile, connection: initialConnection, initialStep = 'machine', detection: initialDetection = null, addDetected }: Omit<Props, 'open'>) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const notify = useNotify();
  const can = useCan();
  const canConnect = can('printer_connectors.manage');
  const editing = Boolean(machine);
  const [saved, setSaved] = useState<Machine | undefined>(machine);
  const [profile, setProfile] = useState<PrinterProfile | undefined>(initialProfile);
  const [connection, setConnection] = useState<PrinterConnection | undefined>(initialConnection);
  const [detection, setDetection] = useState<Detection>(initialDetection);
  const [stepIndex, setStepIndex] = useState(0);
  const [pending, setPending] = useState(false);
  // Set synchronously so a double click cannot start a second save while the first is still validating.
  const inflight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [completed, setCompleted] = useState(false);
  const test = useConnectionTest();
  const typesQuery = useQuery(machineTypesQuery());
  const connectors = useQuery({ ...connectorsQuery(), enabled: canConnect });
  const [units, setUnits] = useState<DraftUnit[] | null>(() => {
    if (!(editing && initialStep === 'spools')) return null;
    const base = initialProfile ? draftFromProfile(initialProfile) : [];
    const extra = addDetected ? initialDetection?.units.find((unit) => unit.externalId === addDetected) : undefined;
    return extra ? [...base, draftFromDetected(extra)] : base;
  });

  const settings = initialConnection?.assignment.settings;
  const text = (key: string) => typeof settings?.[key] === 'string' ? settings[key] : '';
  const form = useForm<SetupValues>({
    defaultValues: {
      name: machine?.name ?? '', machineTypeId: machine?.machineType.id ?? '', status: machine?.status ?? 'active',
      automaticCollectionEnabled: machine?.automaticCollectionEnabled ?? false, externalIdentifier: machine?.externalIdentifier ?? '',
      modelId: initialProfile?.model ?? '',
      connect: initialConnection || !editing || initialStep === 'connection' ? 'now' : 'later', connectorId: initialConnection?.connector.id ?? '',
      // A printer model with a live adapter always connects through it, also when it was connected through the simulator before.
      adapterKind: modelById(initialProfile?.model)?.adapterKind
        ?? (isBambuAdapter(initialConnection?.assignment.adapterKind) ? initialConnection.assignment.adapterKind : 'simulator'),
      // The machine's external identifier usually is the printer's serial number, so it is offered here instead of being typed twice.
      ipAddress: text('ipAddress'), serialNumber: text('serialNumber') || (machine?.externalIdentifier ?? '').toUpperCase(), accessCode: '', autoMountRfid: settings ? settings.autoDetectSpools === true : true,
    },
  });
  const values = form.watch();
  // Editing a connection field after a test asks for a new test instead of keeping the old result.
  const resetTest = test.reset;
  useEffect(() => {
    const subscription = form.watch((_value, { name, type }) => {
      if (type !== 'change' || !name || !CONNECTION_FIELDS.has(name)) return;
      resetTest();
      setSkipped(false);
      setConnectionFailed(false);
    });
    return () => subscription.unsubscribe();
  }, [form, resetTest]);
  const type = (typesQuery.data?.items ?? []).find((item) => item.id === values.machineTypeId);
  const printer = type?.process === 'fdm_printing';
  const modelId = (values.modelId || null) as PrinterModelId | null;
  const model = modelById(modelId);
  const steps: StepKey[] = editing ? [initialStep] : printer ? ['machine', 'connection', 'spools', 'review'] : ['machine', 'review'];
  const current = steps[Math.min(stepIndex, steps.length - 1)];
  const draft = units ?? (profile ? draftFromProfile(profile) : draftFromTemplate(modelId));
  const draftsValid = draft.every((unit) => unit.name.trim() && unit.slots.length > 0 && unit.slots.every((slot) => slot.name.trim())) && duplicatePairs(draft).size === 0;
  const needsModel = current === 'machine' && printer && !modelId && (!editing || !profile);
  const testBusy = test.state.phase === 'saving' || test.state.phase === 'config' || test.state.phase === 'status';
  const refresh = () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });

  const onModelChange = (id: PrinterModelId) => {
    form.setValue('adapterKind', modelById(id)?.adapterKind ?? 'simulator');
    if (!editing) setUnits(null);
  };

  const stepValid = async (key: StepKey) => {
    if (key === 'machine') return (await form.trigger(['name', 'machineTypeId', 'externalIdentifier'])) && !needsModel;
    if (key === 'connection') return !canConnect || form.getValues('connect') === 'later' || form.trigger(['connectorId', 'ipAddress', 'serialNumber', 'accessCode']);
    if (key === 'spools') return draftsValid;
    return true;
  };

  /** Persists the machine step: the machine itself and, for printer types, its profile with the model's template. */
  const saveMachine = async () => {
    const v = form.getValues();
    const input = {
      name: v.name.trim(), machineTypeId: v.machineTypeId, status: v.status,
      // The database only allows an external identifier together with automatic collection.
      externalIdentifier: v.automaticCollectionEnabled ? v.externalIdentifier.trim() || null : null,
      automaticCollectionEnabled: v.automaticCollectionEnabled,
    };
    let machineNow = saved;
    if (!machineNow) machineNow = await createMachine(input);
    else if (editing || input.name !== machineNow.name || input.machineTypeId !== machineNow.machineType.id || input.status !== machineNow.status
      || input.externalIdentifier !== (machineNow.externalIdentifier ?? null) || input.automaticCollectionEnabled !== machineNow.automaticCollectionEnabled) {
      machineNow = await updateMachine(machineNow.id, { ...input, expectedVersion: machineNow.version });
    }
    setSaved(machineNow);
    if (printer && modelId && (!profile || profile.model !== modelId)) {
      // A model change on an existing machine only labels the profile; its units stay. A fresh setup starts from the template.
      const inputUnits = profile && editing ? draftToInput(draftFromProfile(profile)) : draftToInput(draftFromTemplate(modelId));
      setProfile(await savePrinterSetup(machineNow.id, { expectedVersion: profile?.version ?? null, enabled: profile?.enabled ?? true, model: modelId, inputUnits }));
    }
    await refresh();
    return machineNow;
  };

  const saveConnection = async () => {
    const v = form.getValues();
    const connector = (connectors.data?.items ?? []).find((item) => item.id === v.connectorId);
    if (!connector || !saved) return;
    const live = isBambuAdapter(v.adapterKind);
    const keep = connection?.assignment.adapterKind === 'simulator' ? connection.assignment.settings : undefined;
    setConnectionFailed(false);
    try {
      const result = await test.start({
        machineId: saved.id, connector, existing: connection, adapterKind: v.adapterKind,
        settings: live ? { ipAddress: v.ipAddress.trim(), serialNumber: v.serialNumber.trim().toUpperCase(), autoDetectSpools: v.autoMountRfid }
          : { scenario: typeof keep?.scenario === 'string' ? keep.scenario : 'idle', intervalSeconds: typeof keep?.intervalSeconds === 'number' ? keep.intervalSeconds : 5 },
        secrets: live && v.accessCode ? { lanAccessCode: v.accessCode } : {},
      }, (assignment) => setConnection({ connector, assignment }));
      form.setValue('accessCode', '');
      if (result.live) setDetection(result.live.status);
      await Promise.all([refresh(), client.invalidateQueries({ queryKey: connectorKeys.all })]);
      return result;
    } catch (failure) {
      setConnectionFailed(true);
      setError(setupErrorText(failure, 'The connection could not be saved.'));
      return undefined;
    }
  };

  const saveSpools = async () => {
    if (!saved) return false;
    setProfile(await savePrinterSetup(saved.id, { expectedVersion: profile?.version ?? null, enabled: profile?.enabled ?? true, model: modelId, inputUnits: draftToInput(draft) }));
    setUnits(null);
    await refresh();
    return true;
  };

  const finish = (machineNow: Machine, title: string) => {
    setCompleted(true);
    notify({ kind: 'success', title, subtitle: machineNow.name });
    onClose();
  };

  /** "Test again": saves the connection once more and restarts the test, also after a timeout or a failure. */
  const retest = async () => {
    if (inflight.current || pending || testBusy) return;
    inflight.current = true;
    setPending(true);
    try {
      if (!(await stepValid('connection'))) return;
      setError(null);
      setSkipped(false);
      await saveConnection();
    } finally {
      inflight.current = false;
      setPending(false);
    }
  };

  /** The primary button: validates, persists the current step and moves on (or closes). */
  const advance = async () => {
    if (inflight.current || pending || testBusy) return;
    inflight.current = true;
    setPending(true);
    try {
      if (!(await stepValid(current))) return;
      setError(null);
      if (current === 'machine') {
        const machineNow = await saveMachine();
        if (editing) { finish(machineNow, 'Machine saved'); return; }
        // The serial number follows the external identifier until it is edited, so the same value is not typed twice.
        if (!form.getFieldState('serialNumber').isDirty) form.setValue('serialNumber', (machineNow.externalIdentifier ?? '').toUpperCase());
        setStepIndex((index) => index + 1);
      } else if (current === 'connection') {
        const wantsConnection = canConnect && form.getValues('connect') === 'now';
        const finished = test.state.phase === 'success' || test.state.phase === 'timeout' || skipped;
        if (wantsConnection && !finished) {
          await saveConnection(); // stay on the step: the user reads the result and moves on
          return;
        }
        if (editing) { finish(saved!, 'Connection saved'); return; }
        setStepIndex((index) => index + 1);
      } else if (current === 'spools') {
        await saveSpools();
        if (editing) { finish(saved!, 'Spool inputs saved'); return; }
        setStepIndex((index) => index + 1);
      } else {
        finish(saved!, 'Machine added');
        navigate(machineLogbookPaths.machine(saved!.id));
      }
    } catch (failure) {
      const fallback = current === 'machine' ? 'The machine could not be saved. Check the values and that the name is unique.' : 'The spool inputs could not be saved. Check the values and try again.';
      setError(setupErrorText(failure, fallback));
    } finally {
      inflight.current = false;
      setPending(false);
    }
  };

  const close = () => {
    if (inflight.current) return;
    test.reset();
    if (!editing && saved && !completed) notify({ kind: 'info', title: 'Machine created', subtitle: `${saved.name} was saved. Finish its setup from the machine page.` });
    onClose();
  };

  const back = () => { setError(null); setSkipped(false); if (stepIndex === 0) close(); else setStepIndex((index) => index - 1); };

  const title = editing ? EDIT_TITLE[initialStep] : 'Add machine';
  const connectionDone = test.state.phase === 'success' || test.state.phase === 'timeout' || skipped;
  const wantsConnection = canConnect && values.connect === 'now';
  const primaryLabel = pending || testBusy ? (current === 'connection' ? 'Testing…' : 'Saving…')
    : current === 'machine' ? (editing ? 'Save machine' : saved ? 'Save and continue' : 'Create and continue')
      : current === 'connection' ? (wantsConnection && !connectionDone ? 'Save and test' : editing ? 'Done' : 'Next')
        : current === 'spools' ? (editing ? 'Save spool inputs' : 'Save and continue')
          : 'Done';
  const connectorName = connection?.connector.name ?? (connectors.data?.items ?? []).find((item) => item.id === values.connectorId)?.name ?? null;

  return (
    <ComposedModal open size="lg" preventCloseOnClickOutside onClose={() => { if (inflight.current) return false; close(); return true; }} aria-label={title}>
      <ModalHeader title={title} label={editing ? machine?.name : 'Machines'} />
      <ModalBody hasForm>
        <form onSubmit={(event) => event.preventDefault()} noValidate className="mj-wizard-body">
          {!editing && (
            <ProgressIndicator currentIndex={stepIndex} spaceEqually onChange={(index: number) => { if (index < stepIndex && !pending && !testBusy) setStepIndex(index); }}>
              {steps.map((key) => <ProgressStep key={key} label={STEP_LABEL[key]} />)}
            </ProgressIndicator>
          )}
          {current === 'machine' && <MachineStep form={form} machine={saved} onModelChange={onModelChange} />}
          {current === 'connection' && (
            <ConnectionStep
              form={form} creating={!editing} model={model} connection={connection} test={test.state} saveError={connectionFailed}
              canSkipTest={testBusy || test.state.phase === 'timeout'} onSkipTest={() => { test.reset(); setSkipped(true); }} onNavigate={close}
              canRetest={!pending && !testBusy && (test.state.phase === 'success' || test.state.phase === 'timeout' || test.state.phase === 'failed' || connectionFailed)}
              onRetest={() => { void retest(); }}
            />
          )}
          {current === 'spools' && <SpoolInputsEditor units={draft} onChange={setUnits} detection={detection} model={model} />}
          {current === 'review' && (
            <ReviewStep
              values={values} typeName={type?.name ?? '—'} printer={printer} model={model} units={profile ? draftFromProfile(profile) : []} detection={detection}
              connectorName={values.connect === 'now' ? connectorName : null} connected={test.state.phase === 'success'} hasCode={Boolean(connection)}
            />
          )}
          {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}
        </form>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={pending} onClick={back}>{stepIndex === 0 ? 'Cancel' : 'Back'}</Button>
        <Button kind="primary" disabled={pending || testBusy || (current === 'spools' && !draftsValid) || needsModel || (current === 'machine' && typesQuery.isPending)} onClick={() => { void advance(); }}>{primaryLabel}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}
