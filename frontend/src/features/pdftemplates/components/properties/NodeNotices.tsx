import { InlineNotification } from '@carbon/react';
import type { PdfTemplateProblem } from '../../../../api/generated/models';
import type { TemplateDocument, TemplateNode } from '../../model';
import { redactedIn } from '../../variables';

const unique = (messages: string[]) => [...new Set(messages)];

/** Errors and warnings of the latest preview for this node, and fields that stay empty for this reader. */
export function NodeNotices({
  doc,
  node,
  problems,
  redacted,
}: {
  doc: TemplateDocument;
  node: TemplateNode;
  problems: readonly PdfTemplateProblem[];
  redacted: readonly string[];
}) {
  const own = problems.filter((p) => p.nodeId === node.id);
  const errors = unique(own.filter((p) => p.severity === 'error').map((p) => p.message));
  const warnings = unique(own.filter((p) => p.severity !== 'error').map((p) => p.message));
  const hidden = redactedIn(doc, node, redacted);
  if (!errors.length && !warnings.length && !hidden.length) return null;
  return (
    <div className="pdft-notices" data-testid="node-notices">
      {errors.length > 0 && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Problem"
          subtitle={`${errors.join(' · ')} Publishing is refused until this is fixed.`}
        />
      )}
      {warnings.length > 0 && (
        <InlineNotification kind="warning" lowContrast hideCloseButton title="Note" subtitle={warnings.join(' · ')} />
      )}
      {hidden.length > 0 && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Empty for this reader"
          subtitle={`${hidden.join(', ')} stays empty: it needs a permission the reader does not hold.`}
        />
      )}
    </div>
  );
}
