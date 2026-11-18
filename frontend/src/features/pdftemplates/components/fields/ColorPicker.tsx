import { Button, TextInput } from '@carbon/react';
import { Add } from '../../icons';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { clamp01, hexToHsv, hsvToHex, normalizeHex, type Hsv } from '../../colors';
import type { ChangeKind } from '../../history';
import { colorRef, colorToken, countUsage, resolveColor } from '../../styles';
import { usePanel } from './panelContext';

export interface ColorPickerProps {
  /**
   * Field mode: the property's value (`#rrggbb`, `$c:<id>` or none). Style mode: the document colour's own `#rrggbb`.
   */
  value: string | undefined;
  allowNone?: boolean;
  /** Set when the picker edits a document colour: every use follows, and there are no swatches. */
  editing?: { id: string; name: string };
  /** Field mode: a hex colour, a document colour reference, or undefined for none. Style mode: a hex colour. */
  onPick: (value: string | undefined, kind: ChangeKind) => void;
  /** Field mode: stores the colour as a new document colour and links the field to it. */
  onSave?: (hex: string) => void;
  /** Field mode: switches to editing the document colour a linked field uses. */
  onEditStyle?: (id: string) => void;
  onClose: () => void;
}

const FALLBACK = '#161616';

/**
 * The colour picker: document colours, a saturation/brightness area, a hue slider and a hex field. Carbon has no colour
 * picker (its design system defines swatches only as a theme concept), so this is handwritten; the buttons and the text
 * input are Carbon's. The area and the slider are keyboard operable (arrow keys, Shift = ten times as far).
 */
export function ColorPicker({ value, allowNone, editing, onPick, onSave, onEditStyle, onClose }: ColorPickerProps) {
  const { doc } = usePanel();
  const { styles } = doc;
  const resolved = resolveColor(value, styles);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(resolved || FALLBACK));
  const [seen, setSeen] = useState(resolved);
  // A colour that changed from outside (a swatch, another editor of the same document colour) is taken over.
  if (resolved !== seen) {
    setSeen(resolved);
    if (resolved && resolved !== hsvToHex(...hsv)) setHsv(hexToHsv(resolved));
  }
  const hex = hsvToHex(...hsv);
  const [typed, setTyped] = useState<string | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = root.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? area.current;
    first?.focus();
  }, []);

  // Escape closes the picker (the trigger keeps focus on return); listened for on the window since the dialog itself is no widget.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Only the picker closes: not the modal, popover or editor selection behind it.
      event.stopPropagation();
      event.stopImmediatePropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const custom = (next: Hsv) => {
    setHsv(next);
    onPick(hsvToHex(...next), 'typing');
  };
  const dragArea = (event: ReactPointerEvent<HTMLDivElement>) => {
    const r = event.currentTarget.getBoundingClientRect();
    custom([hsv[0], clamp01((event.clientX - r.left) / r.width), clamp01(1 - (event.clientY - r.top) / r.height)]);
  };
  const dragHue = (event: ReactPointerEvent<HTMLDivElement>) => {
    const r = event.currentTarget.getBoundingClientRect();
    custom([clamp01((event.clientX - r.left) / r.width) * 360, hsv[1], hsv[2]]);
  };
  const start =
    (move: (e: ReactPointerEvent<HTMLDivElement>) => void) => (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      move(event);
    };
  const dragging =
    (move: (e: ReactPointerEvent<HTMLDivElement>) => void) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event);
    };
  const keyArea = (event: ReactKeyboardEvent) => {
    const d = event.shiftKey ? 0.1 : 0.01;
    const move = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[event.key];
    if (!move) return;
    event.preventDefault();
    custom([hsv[0], clamp01(hsv[1] + move[0]), clamp01(hsv[2] + move[1])]);
  };
  const keyHue = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const d = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowLeft' ? -1 : 1);
    custom([(hsv[0] + d + 360) % 360, hsv[1], hsv[2]]);
  };

  const linked = editing ? undefined : colorRef(value, styles);
  const hue = `hsl(${hsv[0]}, 100%, 50%)`;

  return (
    <div ref={root} className="pdft-cpick" role="dialog" aria-label="Colour">
      {editing && (
        <p className="pdft-cpick__link pdft-cpick__link--edit">
          Editing document colour <b>{editing.name}</b> · every use changes
        </p>
      )}
      {linked && (
        <p className="pdft-cpick__link">
          Linked to <b>{linked.name}</b> ({countUsage(doc, colorToken(linked.id))}×). Picking a colour below changes
          only this field.{' '}
          <button type="button" className="pdft-cpick__linkbtn" onClick={() => onEditStyle?.(linked.id)}>
            Edit “{linked.name}” for every use
          </button>
        </p>
      )}
      {!editing && (
        <>
          <span className="cds--label">Document colours</span>
          <div className="pdft-swatches">
            {styles.colors.map((c) => (
              <button
                key={c.id}
                type="button"
                className="pdft-swatch pdft-swatch--button"
                style={{ background: c.value }}
                title={`${c.name} · ${c.value.toUpperCase()}`}
                aria-label={c.name}
                aria-pressed={value === colorToken(c.id)}
                onClick={() => {
                  onPick(colorToken(c.id), 'step');
                  setHsv(hexToHsv(c.value));
                }}
              />
            ))}
            {!styles.colors.length && <span className="pdft-hint">No document colours yet.</span>}
          </div>
        </>
      )}
      <span className="cds--label">{editing ? 'Colour' : 'Custom'}</span>
      <div
        ref={area}
        className="pdft-cpick__area"
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv[2] * 100)}
        aria-valuetext={`saturation ${Math.round(hsv[1] * 100)} %, brightness ${Math.round(hsv[2] * 100)} %`}
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hue}`,
        }}
        onPointerDown={start(dragArea)}
        onPointerMove={dragging(dragArea)}
        onKeyDown={keyArea}
      >
        <span
          className="pdft-cpick__knob"
          style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: hex }}
        />
      </div>
      <div
        className="pdft-cpick__hue"
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv[0])}
        onPointerDown={start(dragHue)}
        onPointerMove={dragging(dragHue)}
        onKeyDown={keyHue}
      >
        <span className="pdft-cpick__knob" style={{ left: `${(hsv[0] / 360) * 100}%`, background: hue }} />
      </div>
      <div className="pdft-cpick__hex">
        <TextInput
          id="pdft-cpick-hex"
          size="sm"
          labelText="Hex colour"
          hideLabel
          maxLength={7}
          value={typed ?? hex.toUpperCase()}
          onChange={(event) => {
            setTyped(event.target.value);
            const parsed = normalizeHex(event.target.value);
            if (parsed) custom(hexToHsv(parsed));
          }}
          onBlur={() => setTyped(null)}
        />
        {allowNone && !editing && (
          <Button
            kind="ghost"
            size="sm"
            onClick={() => {
              onPick(undefined, 'step');
              onClose();
            }}
          >
            None
          </Button>
        )}
      </div>
      {!editing && onSave && (
        <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => onSave(hex)}>
          Save as document colour
        </Button>
      )}
    </div>
  );
}
