import { IconButton, OverflowMenu, OverflowMenuItem, Tag } from '@carbon/react';
import { Link, Unlink } from '../../icons';
import type { Length } from '../../model';
import { sizeRef, sizeToken } from '../../styles';
import { NumField, type Change } from './Inputs';
import { usePanel } from './panelContext';

/**
 * A length that is a number or a document size. Linked, it shows the size as a purple chip (and follows it); the token
 * button picks a document size, the detach button turns the chip back into its number. Derived from the document at
 * every render.
 */
export function SizeField({
  label,
  value,
  onChange,
  unit,
  step = 0.1,
  min,
  helper,
}: {
  label: string;
  value: Length | undefined;
  onChange: Change<Length | undefined>;
  unit: 'mm' | 'pt';
  step?: number;
  min?: number;
  helper?: string;
}) {
  const { doc } = usePanel();
  const ref = sizeRef(value, doc.styles);
  const sizes = doc.styles.sizes.filter((s) => s.unit === unit);

  if (ref) {
    return (
      <div className="pdft-field">
        <span className="cds--label">{label}</span>
        <div className="pdft-sizefield">
          <Tag type="purple" size="md" renderIcon={Link} className="pdft-sizechip" title="Document size">
            {`${ref.name} · ${ref.value} ${ref.unit}`}
          </Tag>
          <IconButton
            label="Detach from the document size"
            kind="ghost"
            size="sm"
            align="bottom-end"
            onClick={() => onChange(ref.value, 'step')}
          >
            <Unlink />
          </IconButton>
        </div>
      </div>
    );
  }
  return (
    <div className="pdft-sizefield pdft-sizefield--input">
      <NumField
        label={label}
        value={typeof value === 'number' ? value : undefined}
        onChange={onChange}
        step={step}
        min={min}
        helper={helper}
      />
      {sizes.length ? (
        <OverflowMenu
          size="sm"
          flipped
          renderIcon={Link}
          iconDescription="Use a document size"
          aria-label="Use a document size"
        >
          {sizes.map((s) => (
            <OverflowMenuItem
              key={s.id}
              itemText={`${s.name} · ${s.value} ${s.unit}`}
              onClick={() => onChange(sizeToken(s.id), 'step')}
            />
          ))}
        </OverflowMenu>
      ) : (
        <IconButton label={`No document sizes in ${unit} yet (Styles tab)`} kind="ghost" size="sm" disabled>
          <Link />
        </IconButton>
      )}
    </div>
  );
}
