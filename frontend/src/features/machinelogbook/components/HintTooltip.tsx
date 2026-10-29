import type { ReactNode } from 'react';
import { IconButton } from '@carbon/react';
import { Information, WarningAltFilled } from '@carbon/icons-react';
import type { MachineRunConsumptionStatus } from '../../../api/generated/models';
import { consumptionNotice, internalStorageShortMessage, isOnInternalStorage } from '../recording/recordingText';
import '../recording/recording.scss';

/** An info or warning icon whose sentence shows in a Carbon tooltip on hover and keyboard focus; for table cells. */
export function HintTooltip({ text, kind = 'info' }: { text: string; kind?: 'info' | 'warning' }) {
  const icon: ReactNode = kind === 'warning' ? <WarningAltFilled /> : <Information />;
  return (
    <span className={kind === 'warning' ? 'recording-hint' : 'recording-hint recording-hint--info'}>
      <IconButton kind="ghost" size="xs" align="bottom-start" label={text}>
        {icon}
      </IconButton>
    </span>
  );
}

/** Why a run's consumption is not recorded, as a warning icon with tooltip; nothing when it is recorded. */
export function ConsumptionTooltip({ status }: { status: MachineRunConsumptionStatus | null | undefined }) {
  const notice = consumptionNotice(status);
  if (!notice) return null;
  const message = isOnInternalStorage(status) ? internalStorageShortMessage : notice.message;
  return <HintTooltip kind="warning" text={`${notice.title}. ${message}`} />;
}
