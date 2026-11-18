import { IconButton } from '@carbon/react';
import { Link, Unlink } from '../../icons';
import { useState } from 'react';
import { useNotify } from '../../../../app/toasts';
import { addColor, colorRef, colorToken, resolveColor, updateColor } from '../../styles';
import type { Change } from './Inputs';
import { ColorPopover } from './ColorPopover';
import { usePanel } from './panelContext';

/**
 * A colour property: a swatch button that opens the picker. A document colour shows its name and can be detached; the
 * picker can edit that colour for every use. `undefined` means "none" (only offered with `allowNone`); `transparent`
 * is shown as none as well. The shown colour is derived from the document at every render, never copied.
 */
export function ColorField({
  label,
  value,
  onChange,
  allowNone,
}: {
  label: string;
  value: string | undefined;
  onChange: Change<string | undefined>;
  allowNone?: boolean;
}) {
  const { doc, edit } = usePanel();
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  // The id of the document colour the picker edits instead of this field.
  const [editing, setEditing] = useState<string | null>(null);
  const { styles } = doc;
  const ref = colorRef(value, styles);
  const hex = resolveColor(value, styles);
  const editedStyle = editing ? styles.colors.find((c) => c.id === editing) : undefined;
  const close = () => {
    setOpen(false);
    setEditing(null);
  };

  const trigger = (
    <button
      type="button"
      className="pdft-colorbtn"
      aria-label={`${label}: choose colour`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => (open ? close() : setOpen(true))}
    >
      <span className={`pdft-swatch${hex ? '' : ' pdft-swatch--none'}`} style={hex ? { background: hex } : undefined} />
      <span className="pdft-colorbtn__text">{ref ? ref.name : hex ? hex.toUpperCase() : 'None'}</span>
      {ref && <span className="pdft-colorbtn__hex">{hex.toUpperCase()}</span>}
      {ref && <Link size={16} className="pdft-linkicon" aria-hidden />}
    </button>
  );

  return (
    <div className="pdft-field">
      <span className="cds--label">{label}</span>
      <div className="pdft-colorfield">
        <ColorPopover
          open={open}
          trigger={trigger}
          allowNone={allowNone}
          value={editedStyle ? editedStyle.value : value}
          editing={editedStyle ? { id: editedStyle.id, name: editedStyle.name } : undefined}
          onPick={(picked, kind) =>
            editedStyle
              ? edit((d) => updateColor(d, editedStyle.id, { value: picked ?? editedStyle.value }), kind)
              : onChange(picked, kind)
          }
          onSave={(saved) => {
            let id = '';
            edit((d) => {
              const made = addColor(d, saved);
              id = made.id;
              return made.doc;
            }, 'typing');
            onChange(colorToken(id), 'typing');
            notify({ kind: 'success', title: 'Saved as a document colour', subtitle: 'Rename it on the Styles tab.' });
          }}
          onEditStyle={setEditing}
          onClose={close}
        />
        {ref && (
          <IconButton
            label="Detach from the document colour"
            kind="ghost"
            size="sm"
            align="bottom-end"
            onClick={() => onChange(ref.value, 'step')}
          >
            <Unlink />
          </IconButton>
        )}
      </div>
    </div>
  );
}
