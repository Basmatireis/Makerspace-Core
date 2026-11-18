import { Document } from '../../icons';
import { useNotify } from '../../../../app/toasts';
import { PAPER, pageSize, type PageSetup, type PaperSize } from '../../model';
import { setName, setPage } from '../../propertyOps';
import { ColorField } from '../fields/ColorField';
import { CheckField, ExprField, NumField, SelectField, TextField, type OptionGroup } from '../fields/Inputs';
import { FONT_OPTIONS } from '../fields/options';
import { PAPER_MARGINS } from '../../pageMargins';
import { usePanel } from '../fields/panelContext';
import { Hint, Row2, Row4 } from './shared';

const paper = (keys: Exclude<PaperSize, 'custom'>[]) =>
  keys.map((k) => ({ value: k, label: `${PAPER[k].label} · ${PAPER[k].size[0]} × ${PAPER[k].size[1]} mm` }));
const FORMATS: (OptionGroup | { value: string; label: string })[] = [
  { group: 'Paper', options: paper(['A3', 'A4', 'A5', 'A6', 'Letter', 'Legal', 'DL']) },
  { group: 'Labels and cards', options: paper(['L62', 'L102', 'L54']) },
  { value: 'custom', label: 'Custom size…' },
];

/** The page setup: name, paper, margins, font, number format, accent and file name. */
export function PagePanel() {
  const { doc, edit } = usePanel();
  const notify = useNotify();
  const { page } = doc;
  const patch = (props: Partial<PageSetup>, kind: 'typing' | 'step' = 'typing') => edit((d) => setPage(d, props), kind);
  const [pw, ph] = pageSize(page);

  const changeSize = (size: PaperSize) => {
    const before = pageSize(page);
    if (size === 'custom') {
      patch({ size, width: page.width ?? +before[0].toFixed(1), height: page.height ?? +before[1].toFixed(1) }, 'step');
      return;
    }
    const [width] = pageSize({ ...page, size });
    if (Math.abs(width - before[0]) > 1) {
      patch({ size, margins: [...PAPER_MARGINS[size]] }, 'step');
      notify({
        kind: 'info',
        title: 'Margins adjusted',
        subtitle: `Margins set to ${PAPER_MARGINS[size].join(' / ')} mm for ${PAPER[size].label}. Positioned elements keep their place.`,
      });
    } else patch({ size }, 'step');
  };
  const margin = (i: number, label: string) => (
    <NumField
      key={label}
      label={label}
      value={page.margins[i]}
      step={0.5}
      min={0}
      max={200}
      onChange={(v, kind) => {
        const margins = [...page.margins] as PageSetup['margins'];
        margins[i] = v ?? 0;
        patch({ margins }, kind);
      }}
    />
  );

  return (
    <div className="pdft-props">
      <h2 className="pdft-nodehead__title">
        <Document size={20} />
        Page setup
      </h2>
      <TextField
        label="Template name"
        value={doc.name}
        maxLength={120}
        onChange={(v, kind) => edit((d) => setName(d, v), kind)}
      />
      <SelectField label="Format" value={page.size} options={FORMATS} onChange={(v) => changeSize(v as PaperSize)} />
      {page.size === 'custom' && (
        <Row2>
          <NumField
            label="Width (mm)"
            value={page.width}
            step={0.5}
            min={20}
            max={1000}
            onChange={(v, k) => patch({ width: v }, k)}
          />
          <NumField
            label="Height (mm)"
            value={page.height}
            step={0.5}
            min={20}
            max={1000}
            onChange={(v, k) => patch({ height: v }, k)}
          />
        </Row2>
      )}
      <SelectField
        label="Orientation"
        value={page.orientation}
        options={[
          { value: 'portrait', label: 'Portrait' },
          { value: 'landscape', label: 'Landscape' },
        ]}
        onChange={(v) => patch({ orientation: v as PageSetup['orientation'] }, 'step')}
      />
      <Hint>
        Page: {+pw.toFixed(1)} × {+ph.toFixed(1)} mm
      </Hint>
      <span className="cds--label">Body margins (mm): top · right · bottom · left</span>
      <Row4>
        {margin(0, 'Top')}
        {margin(1, 'Right')}
        {margin(2, 'Bottom')}
        {margin(3, 'Left')}
      </Row4>
      <Row2>
        <SelectField
          label="Font"
          value={page.font}
          options={FONT_OPTIONS}
          onChange={(v) => patch({ font: v as PageSetup['font'] }, 'step')}
        />
        <NumField
          label="Base size (pt)"
          value={page.baseSize}
          step={0.5}
          min={4}
          max={72}
          onChange={(v, k) => patch({ baseSize: v ?? 10 }, k)}
        />
      </Row2>
      <SelectField
        label="Number format"
        value={page.locale}
        options={[
          { value: 'de', label: 'German 1.234,50 €' },
          { value: 'en', label: 'English EUR 1,234.50' },
        ]}
        onChange={(v) => patch({ locale: v as PageSetup['locale'] }, 'step')}
      />
      <ColorField
        label="Accent colour"
        value={page.accent}
        onChange={(v, k) => patch({ accent: v ?? page.accent }, k)}
      />
      <CheckField
        label="Accent bar at the top of each page"
        checked={page.accentBar}
        onChange={(v, k) => patch({ accentBar: v }, k)}
      />
      <ExprField
        label="File name"
        value={page.filename}
        maxLength={200}
        helper="Variables allowed; “/” and control characters are removed."
        onChange={(v, k) => patch({ filename: v }, k)}
      />
      <Hint>
        Limits: 500 blocks, 16 nesting levels, 300 pages and 10 seconds per document. A template only reads the data of
        its document type; it cannot load files or web addresses.
      </Hint>
    </div>
  );
}
