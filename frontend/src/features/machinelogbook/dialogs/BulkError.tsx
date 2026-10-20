import { InlineNotification } from '@carbon/react';
import { LinkifiedText, type RefTargets } from '../../../app/RefLink';
import { RichNotification } from '../../../app/RichNotification';
import { blockedItems } from '../bulkWork';
import { saveError } from './jobFormHelpers';

/**
 * Failure of a bulk request. A refused request (409 bulk_blocked) lists every blocking item with a link; the server changed
 * nothing in that case.
 */
export function BulkError({
  error,
  title,
  targets,
  onNavigate,
}: {
  error: unknown;
  title: string;
  targets: RefTargets;
  onNavigate: () => void;
}) {
  if (!error) return null;
  const blocked = blockedItems(error);
  if (blocked) {
    return (
      <RichNotification kind="error" title={`${title}. Nothing was changed`}>
        <ul className="mj-skip-list">
          {blocked.map((item) => (
            <li key={`${item.kind}-${item.id}`}>
              <LinkifiedText text={item.message} targets={targets} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      </RichNotification>
    );
  }
  return (
    <InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title={title}
      subtitle={saveError(error, 'Reload the page and try again.').message}
    />
  );
}
