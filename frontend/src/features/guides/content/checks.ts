/** Checks for `advance: { kind: 'when' }` steps. They read the DOM, so they work for any form library. */

const matches = (value: string, text: string | RegExp) =>
  typeof text === 'string' ? value.trim() === text : text.test(value);

/** True once the input or select at `selector` holds a value that matches `text`. */
export const fieldHolds = (selector: string, text: string | RegExp) => (): boolean => {
  const element = document.querySelector<HTMLInputElement>(selector);
  return Boolean(element) && matches(element!.value ?? '', text);
};

/** True once the radio button at `selector` is selected. */
export const radioSelected = (selector: string) => (): boolean =>
  document.querySelector<HTMLInputElement>(selector)?.checked === true;

/**
 * True once the modal at `selector` is closed. A submit step uses it instead of a click so the tour only moves on
 * after the save succeeded; a rejected save keeps the modal and its error open.
 */
export const modalClosed = (selector: string) => (): boolean => {
  const element = document.querySelector(selector);
  return !element || !(element.matches('.is-visible') || element.closest('.is-visible'));
};
