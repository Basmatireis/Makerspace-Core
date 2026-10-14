import type { UseFormReturn } from 'react-hook-form';
import type { AdapterKind, DetectedPrinterState, Machine, MachineStatus, PrinterModelId } from '../../types';

export type StepKey = 'machine' | 'connection' | 'spools' | 'review';

export type SetupValues = {
  name: string;
  machineTypeId: string;
  status: MachineStatus;
  modelId: PrinterModelId | '';
  connect: 'now' | 'later';
  connectorId: string;
  adapterKind: AdapterKind;
  ipAddress: string;
  serialNumber: string;
  accessCode: string;
  autoMountRfid: boolean;
};

export type SetupForm = UseFormReturn<SetupValues>;

export type TestState = { status: 'idle' | 'testing' | 'success' | 'error'; error?: 'unreachable' | 'wrong_code' };

/** What the wizard knows about the machine being edited (undefined when creating). */
export type WizardMachine = Machine | undefined;
export type Detection = DetectedPrinterState | null;
