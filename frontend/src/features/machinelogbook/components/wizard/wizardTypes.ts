import type { UseFormReturn } from 'react-hook-form';
import type { Machine, MachineStatus } from '../../../../api/generated/models';
import type { PrinterModelId } from '../../printerSetup';

export type StepKey = 'machine' | 'connection' | 'spools' | 'review';

export type AdapterKind = 'simulator' | 'bambu_h2d' | 'bambu_x1c';

export type SetupValues = {
  name: string;
  machineTypeId: string;
  status: MachineStatus;
  automaticCollectionEnabled: boolean;
  externalIdentifier: string;
  modelId: PrinterModelId | '';
  connect: 'now' | 'later';
  connectorId: string;
  adapterKind: AdapterKind;
  ipAddress: string;
  serialNumber: string;
  /** Write-only: the API never returns the LAN access code, so this is empty unless the user types a new one. */
  accessCode: string;
  autoMountRfid: boolean;
};

export type SetupForm = UseFormReturn<SetupValues>;

/** What the wizard knows about the machine being edited or created (undefined before the first save). */
export type WizardMachine = Machine | undefined;
