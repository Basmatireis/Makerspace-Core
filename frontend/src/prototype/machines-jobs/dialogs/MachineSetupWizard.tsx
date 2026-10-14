import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { Button, ComposedModal, ModalBody, ModalFooter, ModalHeader, ProgressIndicator, ProgressStep } from '@carbon/react';
import { ConnectionStep } from '../components/wizard/ConnectionStep';
import { MachineStep } from '../components/wizard/MachineStep';
import { ReviewStep } from '../components/wizard/ReviewStep';
import { SpoolInputsEditor } from '../components/wizard/SpoolInputsEditor';
import type { Detection, SetupValues, StepKey, TestState } from '../components/wizard/wizardTypes';
import { modelById } from '../mockData';
import { draftFromDetected, draftFromProfile, draftFromTemplate, draftToInput, duplicatePairs, isPrinterType, type DraftUnit } from '../printerSetup';
import { useSimulatedMutation, useStore, type MachineSetupInput } from '../store';
import type { Machine, PrinterModelId } from '../types';

const STEP_LABEL: Record<StepKey, string> = { machine: 'Machine', connection: 'Connection', spools: 'Spool inputs', review: 'Review' };
const EDIT_TITLE: Record<StepKey, string> = { machine: 'Edit machine', connection: 'Edit connection', spools: 'Edit spool inputs', review: 'Review' };

type Props = { open: boolean; onClose: () => void; machine?: Machine; initialStep?: StepKey; /** External id of a detected printer unit to add as input unit right away. */ addDetected?: string };

/** Create mode walks through every step. Edit mode (a machine is given) shows only `initialStep`, without progress indicator. */
export function MachineSetupWizard({ open, onClose, machine, initialStep = 'machine', addDetected }: Props) {
  if (!open) return null;
  return <WizardBody key={machine?.id ?? 'new'} onClose={onClose} machine={machine} initialStep={initialStep} addDetected={addDetected} />;
}

function WizardBody({ onClose, machine, initialStep, addDetected }: Omit<Props, 'open'> & { initialStep: StepKey }) {
  const store = useStore();
  const navigate = useNavigate();
  const editing = Boolean(machine);
  const profile = store.printerProfiles.find((p) => p.machineId === machine?.id);
  const firstHost = store.connectorHosts.find((host) => host.lifecycle === 'active');
  const form = useForm<SetupValues>({
    defaultValues: {
      name: machine?.name ?? '', machineTypeId: machine?.machineTypeId ?? '', status: machine?.status ?? 'active', modelId: machine?.modelId ?? '',
      connect: machine ? (machine.connection ? 'now' : 'later') : firstHost ? 'now' : 'later',
      connectorId: machine?.connection?.connectorId ?? firstHost?.id ?? '', adapterKind: machine?.connection?.adapterKind ?? 'simulator',
      ipAddress: machine?.connection?.ipAddress ?? '', serialNumber: machine?.connection?.serialNumber ?? '', accessCode: '', autoMountRfid: machine?.connection?.autoMountRfid ?? true,
    },
  });
  const { mutate, pending } = useSimulatedMutation(store.saveMachineSetup);
  const [stepIndex, setStepIndex] = useState(0);
  const [detection, setDetection] = useState<Detection>(() => (machine ? store.detected[machine.id] ?? null : null));
  const [units, setUnits] = useState<DraftUnit[] | null>(() => {
    if (!editing) return null;
    const base = profile ? draftFromProfile(profile) : draftFromTemplate(machine?.modelId ?? null);
    const extra = addDetected ? detection?.units.find((unit) => unit.externalId === addDetected) : undefined;
    return extra ? [...base, draftFromDetected(extra)] : base;
  });
  const [test, setTest] = useState<TestState>({ status: 'idle' });

  const values = form.watch();
  const type = store.machineTypes.find((item) => item.id === values.machineTypeId);
  const printer = isPrinterType(type);
  const modelId = (values.modelId || null) as PrinterModelId | null;
  const model = modelById(modelId);
  const steps: StepKey[] = editing ? [initialStep] : printer ? ['machine', 'connection', 'spools', 'review'] : ['machine', 'review'];
  const current = steps[Math.min(stepIndex, steps.length - 1)] as StepKey;
  const last = stepIndex >= steps.length - 1;
  const draft = units ?? draftFromTemplate(modelId);
  const draftsValid = draft.every((unit) => unit.name.trim() && unit.slots.length > 0 && unit.slots.every((slot) => slot.name.trim())) && duplicatePairs(draft).size === 0;

  const onModelChange = (id: PrinterModelId) => {
    const next = modelById(id);
    form.setValue('adapterKind', next?.adapterKind ?? 'simulator');
    setDetection(null);
    setTest({ status: 'idle' });
    if (!editing) setUnits(null);
  };

  const runTest = async () => {
    const ok = await form.trigger(['connectorId', 'ipAddress', 'serialNumber', 'accessCode']);
    if (!ok) return;
    setTest({ status: 'testing' });
    try {
      setDetection(await store.detectPrinter({ adapterKind: form.getValues('adapterKind') }, modelId));
      setTest({ status: 'success' });
    } catch (error) {
      setTest({ status: 'error', error: error instanceof Error && error.message === 'wrong_code' ? 'wrong_code' : 'unreachable' });
    }
  };

  const stepFields = (key: StepKey): (keyof SetupValues)[] => key === 'machine' ? ['name', 'machineTypeId'] : key === 'connection' ? ['connectorId', 'ipAddress', 'serialNumber', 'accessCode'] : [];
  const stepValid = async (key: StepKey) => {
    if (key === 'machine') return (await form.trigger(stepFields(key))) && (!printer || Boolean(modelId));
    if (key === 'connection') return form.trigger(stepFields(key));
    if (key === 'spools') return draftsValid;
    return true;
  };

  const next = async () => {
    if (!(await stepValid(current))) return;
    if (steps[stepIndex + 1] === 'spools' && units === null) setUnits(draftFromTemplate(modelId));
    setStepIndex((index) => index + 1);
  };

  const save = async () => {
    if (!(await stepValid(current))) return;
    const v = form.getValues();
    const connect = printer && v.connect === 'now';
    const live = v.adapterKind === 'bambu_h2d';
    const connection = { connectorId: v.connectorId, adapterKind: v.adapterKind, ipAddress: live ? v.ipAddress.trim() : null, serialNumber: live ? v.serialNumber.trim() : null, autoMountRfid: live && v.autoMountRfid };
    const input: MachineSetupInput = { id: machine?.id, name: v.name.trim(), machineTypeId: v.machineTypeId, status: v.status, modelId: printer ? modelId : null };
    if (!editing || initialStep === 'connection') {
      if (printer) { input.connection = connect ? connection : null; input.accessCode = connect && live ? v.accessCode : undefined; input.detected = connect ? detection : null; }
    }
    if (printer && (!editing || initialStep === 'spools')) { input.inputUnits = draftToInput(draft); if (detection) input.detected = detection; }
    const saved = await mutate(input);
    store.notify({ kind: 'success', title: editing ? 'Machine saved' : 'Machine added', subtitle: saved.name });
    onClose();
    if (!editing) navigate(`/machines/${saved.id}`);
  };

  const title = editing ? EDIT_TITLE[initialStep] : 'Add machine';
  const primaryLabel = pending ? 'Saving…' : last ? (editing ? 'Save changes' : 'Create machine') : 'Next';
  const needsModel = current === 'machine' && printer && !modelId;

  return (
    <ComposedModal open size="lg" preventCloseOnClickOutside onClose={() => { if (pending) return false; onClose(); return true; }} aria-label={title}>
      <ModalHeader title={title} label={editing ? machine?.name : 'Machines'} />
      <ModalBody hasForm>
        <form onSubmit={(event) => event.preventDefault()} noValidate className="mj-wizard-body">
          {!editing && (
            <ProgressIndicator currentIndex={stepIndex} spaceEqually onChange={(index: number) => { if (index < stepIndex) setStepIndex(index); }}>
              {steps.map((key) => <ProgressStep key={key} label={STEP_LABEL[key]} />)}
            </ProgressIndicator>
          )}
          {current === 'machine' && <MachineStep form={form} machine={machine} onModelChange={onModelChange} />}
          {current === 'connection' && <ConnectionStep form={form} machine={machine} model={model} test={test} detection={detection} onTest={() => { void runTest(); }} onNavigate={onClose} />}
          {current === 'spools' && <SpoolInputsEditor units={draft} onChange={setUnits} detection={detection} model={model} />}
          {current === 'review' && <ReviewStep values={values} printer={printer} model={model} units={draft} detection={detection} hasCode={Boolean(machine?.connection?.accessCodeSet)} />}
        </form>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={pending} onClick={() => { if (stepIndex === 0) onClose(); else setStepIndex((index) => index - 1); }}>{stepIndex === 0 ? 'Cancel' : 'Back'}</Button>
        <Button kind="primary" disabled={pending || (current === 'spools' && !draftsValid) || needsModel} onClick={() => { void (last ? save() : next()); }}>{primaryLabel}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}
