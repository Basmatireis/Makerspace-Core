import { Button, InlineNotification, RadioTile, TileGroup } from '@carbon/react';
import { ArrowLeft, Logout } from '@carbon/icons-react';
import { useState } from 'react';
import type { PublicPresence } from '../../../api/generated/models';
import { formatTime, initials } from './format';
import { useIdleCountdown } from './useIdleCountdown';

// Public-tap checkout needs no credentials: pick your name from the people who are here and confirm.
export function CheckOutScreen({
  presence,
  preselected,
  pending,
  error,
  onCheckOut,
  onCancel,
}: {
  presence: PublicPresence[];
  preselected: string | null;
  pending: boolean;
  error: string;
  onCheckOut: (visit: PublicPresence) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(preselected);
  useIdleCountdown(onCancel);
  const sorted = [...presence].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const visit = presence.find((item) => item.visitId === selected);

  return (
    <div className="tablet-identify">
      <div className="tablet-identify__header">
        <Button kind="ghost" size="lg" renderIcon={ArrowLeft} onClick={onCancel}>
          Back
        </Button>
      </div>

      <h1 className="tablet-identify__title">Who is leaving?</h1>

      {sorted.length === 0 ? (
        <p className="tablet-home__lead">Nobody is checked in.</p>
      ) : (
        <TileGroup
          className="tablet-checkout"
          legend="Tap your name"
          name="tablet-checkout"
          valueSelected={selected ?? undefined}
          onChange={(value) => setSelected(String(value))}
        >
          {sorted.map((item) => (
            <RadioTile key={item.visitId} id={`checkout-${item.visitId}`} value={item.visitId}>
              <span className="tablet-person__row">
                <span className="tablet-person__avatar" aria-hidden="true">
                  {initials(item.displayName)}
                </span>
                <span className="tablet-person__name">{item.displayName}</span>
                <span className="tablet-person__since">since {formatTime(item.checkedInAt)}</span>
              </span>
            </RadioTile>
          ))}
        </TileGroup>
      )}

      {error && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Check-out failed" subtitle={error} />
      )}

      <Button
        size="2xl"
        className="tablet-submit"
        renderIcon={Logout}
        disabled={!visit || pending}
        onClick={() => visit && onCheckOut(visit)}
      >
        {visit ? `Check out ${visit.displayName}` : 'Check out'}
      </Button>
    </div>
  );
}
