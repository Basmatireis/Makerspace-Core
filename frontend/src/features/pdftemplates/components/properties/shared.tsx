import { Button, IconButton } from '@carbon/react';
import { Add, TrashCan } from '../../icons';
import type { ReactNode } from 'react';
import type { ChangeKind } from '../../history';
import type { Area, TemplateNode } from '../../model';

/** What every block-type section of the Properties panel gets. `set` merges properties (undefined removes one). */
export interface NodeSectionProps<N extends TemplateNode = TemplateNode> {
  node: N;
  /** Where the node sits: the body, a header/footer, or a page layer. */
  area: Area;
  set: (props: Record<string, unknown>, kind?: ChangeKind) => void;
}

export const Row2 = ({ children }: { children: ReactNode }) => <div className="pdft-row2">{children}</div>;
export const Row4 = ({ children }: { children: ReactNode }) => <div className="pdft-row4">{children}</div>;
export const Hint = ({ children }: { children: ReactNode }) => <p className="pdft-hint">{children}</p>;

/** A grouped list of repeated items (columns, rows, cases) with a heading and an add button below. */
export function ItemsEditor({
  title,
  addLabel,
  onAdd,
  children,
}: {
  title: string;
  addLabel?: string;
  onAdd?: () => void;
  children: ReactNode;
}) {
  return (
    <fieldset className="pdft-items">
      <legend className="cds--label">{title}</legend>
      {children}
      {onAdd && (
        <Button kind="ghost" size="sm" renderIcon={Add} onClick={onAdd}>
          {addLabel}
        </Button>
      )}
    </fieldset>
  );
}

/** One item of an `ItemsEditor`: its fields and a remove button. */
export function ItemCard({
  removeLabel,
  onRemove,
  children,
}: {
  removeLabel: string;
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="pdft-item">
      <div className="pdft-item__fields">{children}</div>
      {onRemove && (
        <IconButton label={removeLabel} kind="ghost" size="sm" align="left" onClick={onRemove}>
          <TrashCan />
        </IconButton>
      )}
    </div>
  );
}
