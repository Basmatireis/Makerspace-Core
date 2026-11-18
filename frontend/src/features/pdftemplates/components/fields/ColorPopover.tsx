import { Popover, PopoverContent } from '@carbon/react';
import type { ReactNode } from 'react';
import { ColorPicker, type ColorPickerProps } from './ColorPicker';

/**
 * A Carbon popover around the picker, anchored at `trigger`. The popover aligns itself to stay inside the window; the
 * panels scroll, so the content must not be clipped by them.
 */
export function ColorPopover({
  open,
  trigger,
  ...picker
}: ColorPickerProps & {
  open: boolean;
  trigger: ReactNode;
}) {
  return (
    <Popover open={open} align="bottom-start" autoAlign caret={false} onRequestClose={picker.onClose}>
      {trigger}
      <PopoverContent>{open && <ColorPicker {...picker} />}</PopoverContent>
    </Popover>
  );
}
