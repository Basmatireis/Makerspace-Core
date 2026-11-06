import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { NotificationRuleDryRun, NotificationRuleInput } from '../../../api/generated/models';
import { dryRunQuery, saveProblem } from '../queries';
import { toInput, type Action, type RuleDraft } from '../ruleModel';

/** How long the draft has to rest before the server is asked about it. */
export const DRY_RUN_DELAY_MS = 600;

export type DryRunState = {
  data: NotificationRuleDryRun | undefined;
  /** The server's reason when it could not evaluate the draft (for example a 422 for an unfinished rule). */
  problem: string | null;
  /** The shown answer is for an older draft, or an answer is on its way. */
  updating: boolean;
};

/** The server's dry run of the draft as it was a moment ago. Errors never block editing; they come back as `problem`. */
export function useDryRun(draft: RuleDraft, personal: boolean): DryRunState {
  const key = JSON.stringify(toInput(draft));
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    if (key === settled) return;
    const timer = window.setTimeout(() => setSettled(key), DRY_RUN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [key, settled]);
  const input = useMemo(() => JSON.parse(settled) as NotificationRuleInput, [settled]);
  const query = useQuery(dryRunQuery(personal, input));
  return {
    data: query.data,
    problem: query.isError ? saveProblem(query.error, 'Preview').message : null,
    updating: key !== settled || query.isFetching,
  };
}

/** "→ Mia, Jonas +3": who the server says an action reaches right now. Only in-app and e-mail actions have a preview. */
export function recipientsLine(dry: NotificationRuleDryRun | undefined, actions: Action[], index: number): string {
  if (!dry) return '';
  const previewable = actions
    .map((action, position) => ({ action, position }))
    .filter(({ action }) => action.channel === 'in_app' || action.channel === 'email');
  const slot = previewable.findIndex(({ position }) => position === index);
  const preview = slot >= 0 ? dry.previews[slot] : undefined;
  if (!preview) return '';
  if (preview.recipientCount === 0) return '→ Nobody right now';
  const extra = preview.recipientCount - preview.recipients.length;
  return `→ ${preview.recipients.join(', ')}${extra > 0 ? ` +${extra}` : ''}`;
}
