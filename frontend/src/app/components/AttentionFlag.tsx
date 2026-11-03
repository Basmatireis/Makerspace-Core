/* eslint-disable react-refresh/only-export-components -- the flag and its table column helpers belong together */
import { Tooltip } from '@carbon/react';
import { WarningFilled } from '@carbon/icons-react';
import './blocks.scss';

/** One reason an item needs attention, as the API reports it. */
export interface AttentionItem {
  code: string;
  message: string;
}

type TooltipAlignment = 'top' | 'bottom' | 'left' | 'right' | 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

/**
 * The attention flag of a table row or panel (`.flag`): Carbon's filled warning icon in the warning support colour,
 * with a tooltip listing every reason on hover and keyboard focus. The reasons are also the button's accessible
 * name. Renders nothing when there is nothing to flag.
 */
export function AttentionFlag({
  attention,
  align = 'left',
}: {
  attention: readonly AttentionItem[] | null | undefined;
  align?: TooltipAlignment;
}) {
  if (!attention || attention.length === 0) return null;
  return (
    <Tooltip
      align={align}
      label={
        <ul className="attention-flag__list">
          {attention.map((item) => (
            <li key={item.code}>{item.message}</li>
          ))}
        </ul>
      }
    >
      <button type="button" className="attention-flag">
        <WarningFilled size={16} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/** Header class of the attention column: narrow and end-aligned. Pass it to `TableHeader` and the matching cells. */
export const attentionColumnClassName = 'attention-column';

/**
 * The DataTable header entry of the attention column: a narrow, end-aligned column whose header text is visually
 * hidden but still names the column for screen readers. Render the header with
 * `<TableHeader className={attentionColumnClassName}><span className="cds--visually-hidden">{header}</span></TableHeader>`
 * and the cells with `<TableCell className={attentionColumnClassName}><AttentionFlag … /></TableCell>`.
 */
export const attentionColumn = { key: 'attention', header: 'Needs attention', isSortable: false } as const;
