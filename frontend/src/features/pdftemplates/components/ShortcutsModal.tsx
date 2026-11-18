import { Modal, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import { KEYS } from '../../signage/editor/useEditorKeys';

const { mod, alt, shift, del } = KEYS;

/** The keyboard of the editor, as the person's platform prints the modifier keys. */
const SHORTCUTS: readonly { group: string; items: readonly { keys: string; what: string }[] }[] = [
  {
    group: 'Blocks (structure or preview focused)',
    items: [
      { keys: del, what: 'Delete the selected block; its neighbour is selected' },
      { keys: `${mod}D`, what: 'Duplicate' },
      {
        keys: `${mod}C / ${mod}X / ${mod}V`,
        what: 'Copy, cut, paste (after the selection or into the selected layer)',
      },
      { keys: `${alt}↑ / ${alt}↓`, what: 'Move up or down within its container; Move to… in Properties for others' },
      { keys: 'F2, Enter', what: 'Rename the selected row in the structure' },
      { keys: '↑ ↓ Home End ← →', what: 'Move through the structure, collapse and expand' },
      { keys: 'Arrows, ' + shift + 'Arrows', what: 'Nudge the selected page element by 0.5 mm, 5 mm' },
    ],
  },
  {
    group: 'Editor',
    items: [
      { keys: `${mod}S`, what: 'Save draft' },
      { keys: `${mod}Z / ${shift}${mod}Z`, what: 'Undo, redo' },
      { keys: 'Esc', what: 'Cancel the tool, then clear the selection' },
      { keys: 'V T H R O L I', what: 'Select tool, text, heading, rectangle, ellipse, line, image' },
      { keys: '?', what: 'Show this list' },
    ],
  },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal open passiveModal size="md" modalHeading="Keyboard shortcuts" onRequestClose={onClose}>
      {SHORTCUTS.map((section) => (
        <StructuredListWrapper key={section.group} isCondensed aria-label={section.group}>
          <StructuredListBody>
            <StructuredListRow head>
              <StructuredListCell head>{section.group}</StructuredListCell>
              <StructuredListCell head> </StructuredListCell>
            </StructuredListRow>
            {section.items.map((item) => (
              <StructuredListRow key={item.keys}>
                <StructuredListCell>
                  <kbd className="pdft-kbd">{item.keys}</kbd>
                </StructuredListCell>
                <StructuredListCell>{item.what}</StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
      ))}
    </Modal>
  );
}
