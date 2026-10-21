import type { ReactNode } from 'react';
import {
  FormGroup,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
} from '@carbon/react';

/** Stack of titled sections: the shared skeleton of every event dialog (Basics, When, Who, Visibility). */
export function FormSections({ children }: { children: ReactNode }) {
  return <Stack gap={7}>{children}</Stack>;
}

/** One titled block of a dialog. The title is a fieldset legend so assistive technology announces the group. */
export function FormSection({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <FormGroup legendText={title} className="evf-section">
      <Stack gap={5}>
        {hint && <p className="ev-secondary evf-hint">{hint}</p>}
        {children}
      </Stack>
    </FormGroup>
  );
}

/** Fields side by side on desktop, stacked on narrow screens. */
export function FieldRow({ cols = 2, children }: { cols?: 2 | 3; children: ReactNode }) {
  return <div className={cols === 3 ? 'evf-grid evf-grid--3' : 'evf-grid'}>{children}</div>;
}

/** Read-only label/value pairs, for example the place a signup currently sits in. */
export function KeyValueList({ label, rows }: { label: string; rows: Array<[string, ReactNode]> }) {
  return (
    <StructuredListWrapper isFlush isCondensed aria-label={label}>
      <StructuredListBody>
        {rows.map(([key, value]) => (
          <StructuredListRow key={key}>
            <StructuredListCell noWrap className="evf-kv__key">
              {key}
            </StructuredListCell>
            <StructuredListCell>{value}</StructuredListCell>
          </StructuredListRow>
        ))}
      </StructuredListBody>
    </StructuredListWrapper>
  );
}
