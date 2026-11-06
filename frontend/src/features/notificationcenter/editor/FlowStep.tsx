import { Tile } from '@carbon/react';
import type { ComponentType, ReactNode } from 'react';
import type { NotificationCatalog } from '../../../api/generated/models';
import type { Definition } from '../ruleModel';
import type { NameLookup } from '../ruleText';

/** What every step of the editor receives; `edit` clones the definition, applies the recipe and stores the result. */
export type StepProps = {
  catalog: NotificationCatalog;
  definition: Definition;
  lookup: NameLookup;
  edit: (recipe: (draft: Definition) => void, options?: { prune?: boolean }) => void;
};

type FlowStepProps = {
  icon: ComponentType<{ size?: number | string }>;
  eyebrow: string;
  title: string;
  /** Controls in the heading row (a toggle or the trigger switcher). */
  right?: ReactNode;
  /** Draws the step muted: it is switched off or empty. */
  off?: boolean;
  children: ReactNode;
};

/** One step of the vertical flow: a node on the rail and a Carbon tile holding the step's controls. */
export function FlowStep({ icon: Icon, eyebrow, title, right, off, children }: FlowStepProps) {
  return (
    <section className={`nc-step${off ? ' nc-step--off' : ''}`} aria-label={`${eyebrow}: ${title}`}>
      <div className="nc-step__rail">
        <span className="nc-step__node">
          <Icon size={16} />
        </span>
      </div>
      <Tile className="nc-step__tile">
        <div className="nc-step__head">
          <div>
            <span className="nc-step__eyebrow">{eyebrow}</span>
            <h3>{title}</h3>
          </div>
          {right}
        </div>
        {children}
      </Tile>
    </section>
  );
}
