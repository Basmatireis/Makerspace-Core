import { createContext, useContext } from 'react';
import { spliceToken } from './variables';

/** A text field of the Properties panel that can receive a variable. */
export interface InsertField {
  element: HTMLInputElement | HTMLTextAreaElement;
  /** Puts new text into the field's property. */
  set: (value: string) => void;
}

/**
 * Remembers which expression field was focused last, so the Variables tab (another pane) can insert at its caret. The
 * object is mutable on purpose: focusing a field must not re-render the editor.
 */
export interface InsertRegistry {
  field: InsertField | null;
  /** Called when a field gets focus. */
  remember: (field: InsertField) => void;
  /** Brings the Properties tab to the front. */
  reveal: () => void;
}

export function createInsertRegistry(reveal: () => void = () => undefined): InsertRegistry {
  const registry: InsertRegistry = {
    field: null,
    remember: (field) => {
      registry.field = field;
    },
    reveal,
  };
  return registry;
}

export const InsertContext = createContext<InsertRegistry | null>(null);

/** The registry of the editor around the panel, or null (panels also work on their own, e.g. in tests). */
export const useInsertRegistry = (): InsertRegistry | null => useContext(InsertContext);

/**
 * Inserts text at the caret (or over the selection) of the field focused last. False when there is none, or it left the
 * page (its block was deselected).
 */
export function insertIntoLastField(registry: InsertRegistry, token: string): boolean {
  const field = registry.field;
  if (!field?.element.isConnected) return false;
  const { element } = field;
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  const { value, caret } = spliceToken(element.value, start, end, token);
  field.set(value);
  registry.reveal();
  // The controlled field takes the new value on the next render; only then the caret can be put behind the token.
  requestAnimationFrame(() => {
    element.focus();
    element.setSelectionRange(caret, caret);
  });
  return true;
}
