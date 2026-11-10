import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, IconButton } from '@carbon/react';
import { ListBulleted, TextBold, TextItalic } from '@carbon/icons-react';
import { loadRichText, loadedRichText, type RichTextLibrary } from '../render/loadRichText';

type Command = 'h1' | 'h2' | 'p' | 'bold' | 'italic' | 'list';

/** Runs a formatting command on the focused editable text (no-op where the browser lacks execCommand). */
function format(command: Command) {
  if (typeof document.execCommand !== 'function') return;
  if (command === 'bold' || command === 'italic') document.execCommand(command);
  else if (command === 'list') document.execCommand('insertUnorderedList');
  else document.execCommand('formatBlock', false, command);
}

/** Formatting bar above a text block being edited on the canvas. Buttons keep the focus in the text. */
export function TextFormatBar({ onDone }: { onDone: () => void }) {
  return (
    // Pressing a button must not move the focus (and the text selection) out of the editable text.
    <div
      className="sg-toolbar sg-toolbar--format"
      role="toolbar"
      aria-label="Text formatting"
      data-canvas-ui
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button kind="ghost" size="sm" onClick={() => format('h1')}>
        H1
      </Button>
      <Button kind="ghost" size="sm" onClick={() => format('h2')}>
        H2
      </Button>
      <Button kind="ghost" size="sm" onClick={() => format('p')}>
        ¶
      </Button>
      <span className="sg-toolbar__sep" aria-hidden="true" />
      <IconButton label="Bold" kind="ghost" size="sm" align="top" onClick={() => format('bold')}>
        <TextBold />
      </IconButton>
      <IconButton label="Italic" kind="ghost" size="sm" align="top" onClick={() => format('italic')}>
        <TextItalic />
      </IconButton>
      <IconButton label="Bulleted list" kind="ghost" size="sm" align="top" onClick={() => format('list')}>
        <ListBulleted />
      </IconButton>
      <span className="sg-toolbar__sep" aria-hidden="true" />
      <Button kind="primary" size="sm" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

/**
 * The HTML of a text block made editable in place, at grid size (the caller scales it with the stage). The text is
 * sanitized before it is shown and again when it is committed; Esc, Done or clicking elsewhere commits.
 */
export function InlineTextEditor({
  html,
  boxStyle,
  innerStyle,
  onCommit,
}: {
  html: string;
  boxStyle: CSSProperties;
  innerStyle: CSSProperties;
  onCommit: (html: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The text when editing started; later changes come from the person typing here.
  const initial = useRef(html);
  const committed = useRef(false);
  const [library, setLibrary] = useState<RichTextLibrary | null>(loadedRichText);
  useEffect(() => {
    if (library) return;
    let active = true;
    loadRichText().then(
      (module) => {
        if (active) setLibrary(module);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [library]);
  // Filled once: React must not touch the children while the person types.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !library) return;
    element.innerHTML = library.sanitizeHtml(initial.current, { allowStyle: false });
    if (typeof document.execCommand === 'function') document.execCommand('defaultParagraphSeparator', false, 'p');
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [library]);
  const commit = () => {
    const element = ref.current;
    if (!element || !library || committed.current) return;
    committed.current = true;
    onCommit(library.sanitizeHtml(element.innerHTML, { allowStyle: false }));
  };
  return (
    <div className="sg-block sg-inline-text" style={boxStyle} data-canvas-ui>
      <div className="sg-block__in" style={innerStyle}>
        <div
          ref={ref}
          className="sg-text sg-text--rich sg-inline-text__body"
          contentEditable={library !== null}
          suppressContentEditableWarning
          role="textbox"
          tabIndex={0}
          aria-multiline="true"
          aria-label="Block text"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            commit();
          }}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Element && next.closest('.sg-toolbar--format')) return;
            commit();
          }}
        />
      </div>
    </div>
  );
}
