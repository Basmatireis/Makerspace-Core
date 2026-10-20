import { Tag } from '@carbon/react';
import type { LaborordnungStatus } from '../../../api/generated/models';
import { formatLabRulesStatus } from './peopleList';

export function LabRulesStatusTag({
  status,
  pending,
  failed,
}: {
  status?: LaborordnungStatus;
  pending: boolean;
  failed: boolean;
}) {
  if (pending) return <span className="section-description">Loading…</span>;
  const presentation = formatLabRulesStatus(failed ? undefined : status);
  return <Tag type={presentation.type}>{presentation.label}</Tag>;
}
