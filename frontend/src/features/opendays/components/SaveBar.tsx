import { Button } from '@carbon/react';
import { plural } from '../model/dates';

/** The bar that appears while the Leitung's working copy has unsaved changes. */
export function SaveBar({
  count,
  saving,
  canUndo,
  error,
  onSave,
  onDiscard,
  onUndo,
}: {
  count: number;
  saving: boolean;
  canUndo: boolean;
  error: string;
  onSave: () => void;
  onDiscard: () => void;
  onUndo: () => void;
}) {
  if (!count) return null;
  return (
    <div className="od-savebar" role="region" aria-label="Unsaved changes">
      <p className="od-savebar__text" aria-live="polite">
        {error ? (
          <span className="od-savebar__error">{error}</span>
        ) : (
          <>{plural(count, 'unsaved change')} in the schedule.</>
        )}
      </p>
      <Button kind="ghost" size="xl" disabled={!canUndo || saving} onClick={onUndo}>
        Undo last change
      </Button>
      <Button kind="secondary" size="xl" disabled={saving} onClick={onDiscard}>
        Discard
      </Button>
      <Button kind="primary" size="xl" disabled={saving} onClick={onSave}>
        {saving ? 'Saving…' : 'Save schedule'}
      </Button>
    </div>
  );
}
