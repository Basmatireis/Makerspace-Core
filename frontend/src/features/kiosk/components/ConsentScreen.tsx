import { Button, InlineNotification, Toggle } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { terminalAnswerConsents } from '../../../api/generated/attendance/attendance';
import type { TerminalConsentCategory } from '../../../api/generated/models';
import { firstName } from './format';
import { useIdleCountdown } from './useIdleCountdown';

/**
 * Shown once after a check-in whose answer lists consent categories the person has not answered yet. It cannot be
 * skipped and nothing is preselected, but "Continue" works with everything off: the check-in counts either way.
 */
export function ConsentScreen({
  visitId,
  displayName,
  categories,
  resetSeconds,
  onDone,
  onIdle,
}: {
  visitId: string;
  displayName: string;
  categories: TerminalConsentCategory[];
  resetSeconds: number;
  onDone: () => void;
  /** No touch for the whole reset time: back to the start screen. The categories are asked again next time. */
  onIdle: () => void;
}) {
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  useIdleCountdown(onIdle, resetSeconds);
  const save = useMutation({
    mutationFn: () =>
      terminalAnswerConsents({
        visitId,
        answers: categories.map((category) => ({ categoryId: category.id, granted: granted[category.id] === true })),
      }),
    onSuccess: onDone,
  });
  return (
    <div className="tablet-consent">
      <h1 className="tablet-consent__title">One question before you go in</h1>
      <p className="tablet-consent__lead">
        {firstName(displayName)}, which messages may we send you? Nothing is preselected, and your check-in counts
        whatever you choose.
      </p>
      <div className="tablet-consent__list">
        {categories.map((category) => (
          <div key={category.id} className="tablet-consent__item">
            <div>
              <p className="tablet-consent__name" id={`kiosk-consent-name-${category.id}`}>
                {category.name}
              </p>
              <p className="tablet-consent__description">{category.description}</p>
            </div>
            <Toggle
              id={`kiosk-consent-${category.id}`}
              size="md"
              // Labelled by the name beside it, so the switch itself shows "No" or "Yes".
              aria-labelledby={`kiosk-consent-name-${category.id}`}
              labelA="No"
              labelB="Yes"
              toggled={granted[category.id] === true}
              onToggle={(checked) => setGranted((current) => ({ ...current, [category.id]: checked }))}
            />
          </div>
        ))}
      </div>
      {save.isError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle="Please try again." />
      )}
      <Button size="2xl" className="tablet-submit" disabled={save.isPending} onClick={() => save.mutate()}>
        Continue
      </Button>
    </div>
  );
}
