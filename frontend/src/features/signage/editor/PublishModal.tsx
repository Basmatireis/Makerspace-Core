import { useState } from 'react';
import { Checkbox, InlineLoading, InlineNotification, Modal } from '@carbon/react';
import { useQueryClient } from '@tanstack/react-query';
import { publishSignageDisplay, publishSignageDisplayGroup } from '../../../api/generated/signage/signage';
import { useNotify } from '../../../app/toasts';
import { errorMessage, pluralize } from '../helpers';
import { signageKeys } from '../queries';
import type { PublishTarget } from './publishTargets';

/**
 * Publishes the displays and groups that show the screen (the existing per-display and per-group publication), after
 * saving the draft. Warns when blocks cut off their content, as displays cut it off the same way.
 */
export function PublishModal({
  sceneName,
  targets,
  loading,
  overflowCount,
  saveFirst,
  onClose,
}: {
  sceneName: string;
  targets: readonly PublishTarget[];
  loading: boolean;
  overflowCount: number;
  saveFirst: () => Promise<boolean>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const notify = useNotify();
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const chosen = targets.filter((target) => !excluded.has(target.id));
  const displayCount = chosen.reduce((sum, target) => sum + target.displayCount, 0);

  const publish = async () => {
    setBusy(true);
    setFailure(null);
    if (!(await saveFirst())) {
      setBusy(false);
      setFailure('The screen could not be saved, so nothing was published. Fix the problem shown in the editor first.');
      return;
    }
    const results = await Promise.allSettled(
      chosen.map((target) =>
        target.kind === 'display' ? publishSignageDisplay(target.id) : publishSignageDisplayGroup(target.id),
      ),
    );
    void queryClient.invalidateQueries({ queryKey: signageKeys.displays() });
    void queryClient.invalidateQueries({ queryKey: signageKeys.groups() });
    setBusy(false);
    const failed = chosen.filter((_, index) => results[index].status === 'rejected');
    if (failed.length > 0) {
      const first = results.find((result) => result.status === 'rejected');
      setFailure(
        `${failed.map((target) => target.name).join(', ')} could not be published. ${errorMessage(first?.status === 'rejected' ? first.reason : null)}`,
      );
      return;
    }
    notify({ kind: 'success', title: `Published to ${chosen.map((target) => target.name).join(' and ')}` });
    onClose();
  };

  const hasTargets = targets.length > 0;
  return (
    <Modal
      open
      modalLabel={sceneName}
      modalHeading="Publish screen"
      primaryButtonText={displayCount > 0 ? `Publish to ${pluralize(displayCount, 'display')}` : 'Publish'}
      secondaryButtonText={hasTargets ? 'Cancel' : 'Close'}
      primaryButtonDisabled={busy || chosen.length === 0}
      passiveModal={!loading && !hasTargets}
      onRequestClose={onClose}
      onRequestSubmit={() => void publish()}
      className="sg-publish"
    >
      <div className="sg-publish__body">
        {loading ? (
          <InlineLoading description="Finding the displays that show this screen" />
        ) : hasTargets ? (
          <fieldset className="sg-fieldset">
            <legend className="cds--label">
              These show this screen and get the new version within about 10 seconds:
            </legend>
            {targets.map((target) => (
              <Checkbox
                key={target.id}
                id={`sg-publish-${target.id}`}
                labelText={`${target.name} · ${target.detail}`}
                checked={!excluded.has(target.id)}
                onChange={(_event, { checked }) =>
                  setExcluded((current) => {
                    const next = new Set(current);
                    if (checked) next.delete(target.id);
                    else next.add(target.id);
                    return next;
                  })
                }
              />
            ))}
          </fieldset>
        ) : (
          <p>
            No display shows this screen yet. Your changes are saved; add the screen to a display or group under
            Displays, then publish there.
          </p>
        )}
        {overflowCount > 0 && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title={`${pluralize(overflowCount, 'block')} ${overflowCount === 1 ? 'does' : 'do'} not fit their content.`}
            subtitle="The displays cut it off the same way."
          />
        )}
        {failure && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Not published" subtitle={failure} />
        )}
        {busy && <InlineLoading description="Publishing…" />}
      </div>
    </Modal>
  );
}
