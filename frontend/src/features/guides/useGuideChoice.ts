import { useEffect, useState } from 'react';
import type { GuideChoice } from './types';

const OPTION = '[role="option"], [role="menuitem"], li';
const DISABLED_CLASS = 'guide-option-disabled';

function matches(text: string | RegExp, option: Element): boolean {
  const visible = (option.textContent ?? '').replace(/\s+/g, ' ').trim();
  return typeof text === 'string' ? visible.toLowerCase().includes(text.toLowerCase()) : text.test(visible);
}

/**
 * The options of the step's field, wherever Carbon renders them: in the list the field controls (possibly a
 * floating layer), in the field's own wrapper, or inside the field when it is a list itself.
 */
function optionsOf(field: Element): HTMLElement[] {
  const found = new Set<HTMLElement>();
  const collect = (root: Element | null) =>
    root?.querySelectorAll<HTMLElement>(OPTION).forEach((option) => found.add(option));
  for (const attribute of ['aria-controls', 'aria-owns']) {
    for (const id of field.getAttribute(attribute)?.split(/\s+/) ?? []) collect(document.getElementById(id));
  }
  collect(field.closest('.cds--list-box__wrapper, .cds--list-box, .cds--dropdown, .cds--combo-box'));
  collect(field);
  // An open menu rendered elsewhere (a floating layer) while this field has it expanded.
  const expanded = field.getAttribute('aria-expanded') === 'true' || field.querySelector('[aria-expanded="true"]');
  if (expanded && found.size === 0) {
    document.querySelectorAll<HTMLElement>('.cds--list-box__menu [role="option"]').forEach((o) => found.add(o));
  }
  // A list's own container is not an option.
  found.delete(field as HTMLElement);
  return [...found].filter((option) => option.getAttribute('role') !== 'listbox');
}

function optionAt(field: Element, node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const option = node.closest<HTMLElement>(OPTION);
  return option && optionsOf(field).includes(option) ? option : null;
}

/**
 * While a step restricts a choice (`allowOnly`), the other options of its dropdown, combo box or list look disabled
 * and cannot be picked by mouse or keyboard. Returns the open menu so the spotlight can leave it usable.
 */
export function useGuideChoice(choice: GuideChoice | undefined): HTMLElement | null {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const field = choice?.field;
  const text = choice?.text;

  useEffect(() => {
    if (!field || text === undefined) return;
    const find = () => document.querySelector(field);

    const apply = () => {
      const root = find();
      const options = root ? optionsOf(root) : [];
      for (const option of options) {
        const blocked = !matches(text, option);
        if (blocked && option.getAttribute('aria-disabled') !== 'true') option.setAttribute('aria-disabled', 'true');
        if (blocked && !option.classList.contains(DISABLED_CLASS)) option.classList.add(DISABLED_CLASS);
        if (!blocked && option.classList.contains(DISABLED_CLASS)) option.classList.remove(DISABLED_CLASS);
      }
      const container = options[0]?.closest<HTMLElement>('[role="listbox"], .cds--list-box__menu') ?? null;
      setMenu((previous) => (previous === container ? previous : container));
    };

    const block = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onPointer = (event: Event) => {
      const root = find();
      const option = root ? optionAt(root, event.target) : null;
      if (option && !matches(text, option)) block(event);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Tab') return;
      const root = find();
      if (!root) return;
      const highlighted = optionsOf(root).find((option) => option.matches('[class*="--highlighted"]'));
      if (highlighted && !matches(text, highlighted)) block(event);
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-disabled', 'aria-expanded'],
    });
    const pointerEvents = ['click', 'mousedown', 'pointerdown', 'mouseup', 'pointerup'] as const;
    pointerEvents.forEach((name) => document.addEventListener(name, onPointer, true));
    document.addEventListener('keydown', onKey, true);
    return () => {
      observer.disconnect();
      pointerEvents.forEach((name) => document.removeEventListener(name, onPointer, true));
      document.removeEventListener('keydown', onKey, true);
      document.querySelectorAll(`.${DISABLED_CLASS}`).forEach((option) => {
        option.classList.remove(DISABLED_CLASS);
        option.removeAttribute('aria-disabled');
      });
      setMenu(null);
    };
  }, [field, text]);

  return menu;
}
