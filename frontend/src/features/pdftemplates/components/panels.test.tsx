import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { server } from '../../../test/server';
import { makeBlock, schemaHints } from '../blocks';
import { createInsertRegistry, InsertContext } from '../insertTarget';
import { find, TYPE_LABELS, type Block, type TemplateDocument, type ToolType } from '../model';
import { counter, sampleDocument, sampleSchema } from '../testFixtures';
import { PropertiesPanel } from './PropertiesPanel';
import { StylesPanel } from './StylesPanel';
import { VariablesPanel } from './VariablesPanel';

const schema = sampleSchema();
const hints = schemaHints(schema);

function withNode(type: ToolType): { doc: TemplateDocument; id: string } {
  const doc = sampleDocument();
  doc.styles.colors.push({ id: 'red', name: 'Red', value: '#d0103a' });
  doc.styles.sizes.push({ id: 'rule', name: 'Rule', value: 0.25, unit: 'mm' });
  const node = makeBlock(type, hints, doc.styles, counter('t'));
  if (node.type === 'layer') doc.layers.push(node);
  else if (['ptext', 'line', 'rect', 'ellipse', 'picture', 'graphic', 'qr', 'barcode'].includes(node.type)) {
    node.x = 20;
    node.y = 30;
    doc.layers[0].elements.push(node as Block);
  } else doc.body.push(node as Block);
  return { doc, id: node.id };
}

function Shell({
  initial,
  selected,
  children,
}: {
  initial: TemplateDocument;
  selected: string | null;
  children?: ReactNode;
}) {
  const [doc, setDoc] = useState(initial);
  const [registry] = useState(() => createInsertRegistry());
  const [sel, setSel] = useState(selected);
  const props = { doc, selectedId: sel, schema, onChange: setDoc, onSelect: setSel };
  return (
    <InsertContext.Provider value={registry}>
      <PropertiesPanel {...props} problems={[]} redacted={[]} />
      <StylesPanel {...props} />
      <VariablesPanel {...props} />
      <output data-testid="doc">{JSON.stringify(doc)}</output>
      {children}
    </InsertContext.Provider>
  );
}

function mount(initial: TemplateDocument, selected: string | null) {
  server.use(http.get('*/api/v1/pdf-templates/assets', () => HttpResponse.json([])));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Shell initial={initial} selected={selected} />
    </QueryClientProvider>,
  );
}
const docOf = (): TemplateDocument => JSON.parse(screen.getByTestId('doc').textContent!) as TemplateDocument;
const panel = () => within(screen.getByTestId('properties-panel'));

/** The key field every block type shows, so a type that renders nothing fails. */
const KEY_FIELD: Record<ToolType, RegExp> = {
  heading: /^Text$/,
  text: /^Text$/,
  ptext: /^x mm$/,
  pagenum: /^Text$/,
  date: /^Text$/,
  value: /^Value$/,
  list: /Text of each entry/,
  fields: /^Label width/,
  table: /Max. rows per page/,
  sheet: /Rows on first page/,
  repeat: /Loop over/,
  if: /Show “Then” when/,
  switch: /Value to compare/,
  columns: /Column 1 width/,
  box: /Border colour/,
  image: /^Height \(mm\)/,
  picture: /^File$/,
  graphic: /^Artwork$/,
  qr: /^Content$/,
  barcode: /^Content$/,
  signatures: /Space above the line/,
  checkbox: /Ticked when/,
  inputline: /Line width/,
  spacer: /^Height \(mm\)/,
  divider: /^Thickness/,
  pagebreak: /Title in the structure/,
  line: /^w mm$/,
  rect: /^Fill/,
  ellipse: /^Fill/,
  layer: /^Show on$/,
};

describe('PropertiesPanel', () => {
  for (const type of Object.keys(KEY_FIELD) as ToolType[]) {
    it(`renders the fields of a ${type} block`, async () => {
      const { doc, id } = withNode(type);
      mount(doc, id);
      const node = find(doc, id)!.node;
      expect(panel().getByRole('heading', { level: 2, name: TYPE_LABELS[node.type] })).toBeInTheDocument();
      expect(panel().getByLabelText('Title in the structure')).toBeInTheDocument();
      expect((await panel().findAllByText(KEY_FIELD[type])).length).toBeGreaterThan(0);
    });
  }

  it('shows the hint when nothing is selected and the page setup for the page', () => {
    mount(sampleDocument(), null);
    expect(panel().getByText(/Select a block in the structure/)).toBeInTheDocument();
  });

  it('edits the page setup: paper, margins and custom size', async () => {
    const user = userEvent.setup();
    mount(sampleDocument(), 'page');
    expect(panel().getByText('Page: 210 × 297 mm')).toBeInTheDocument();
    await user.selectOptions(panel().getByLabelText('Format'), 'A5');
    // The width differs by more than a millimetre, so the margins follow the paper.
    expect(docOf().page).toMatchObject({ size: 'A5', margins: [22, 12, 16, 12] });
    await user.selectOptions(panel().getByLabelText('Format'), 'custom');
    expect(docOf().page).toMatchObject({ size: 'custom', width: 148, height: 210 });
    expect(panel().getByLabelText('Width (mm)')).toHaveValue(148);
    await user.selectOptions(panel().getByLabelText('Orientation'), 'landscape');
    expect(panel().getByText('Page: 210 × 148 mm')).toBeInTheDocument();
    const optgroups = Array.from(panel().getByLabelText('Format').querySelectorAll('optgroup')).map((g) => g.label);
    expect(optgroups).toEqual(['Paper', 'Labels and cards']);
  });

  it('types into a text field and moves, duplicates and deletes the block', async () => {
    const user = userEvent.setup();
    mount(sampleDocument(), 'intro');
    const text = panel().getByLabelText('Text');
    await user.clear(text);
    await user.type(text, 'Hi');
    expect(find(docOf(), 'intro')?.node).toMatchObject({ text: 'Hi' });
    await user.click(panel().getByRole('button', { name: 'Move down' }));
    expect(
      docOf()
        .body.map((b) => b.id)
        .slice(0, 3),
    ).toEqual(['title', 'cond', 'intro']);
    await user.click(panel().getByRole('button', { name: 'Duplicate' }));
    expect(docOf().body).toHaveLength(6);
    await user.click(panel().getByRole('button', { name: 'Delete' }));
    expect(docOf().body).toHaveLength(5);
  });

  it('moves a block into another container with Move to…', async () => {
    const user = userEvent.setup();
    mount(sampleDocument(), 'intro');
    await user.click(panel().getByRole('button', { name: 'Move to…' }));
    // jsdom never positions the floating menu, so its items count as hidden.
    const items = await screen.findAllByRole('menuitem', { hidden: true });
    const choices = items.map((item) => item.textContent);
    expect(choices).toContain('Body');
    expect(choices.some((c) => c?.startsWith('Body › ') && c.endsWith('Then'))).toBe(true);
    expect(choices.some((c) => c?.startsWith('Layer “'))).toBe(true);
    expect(choices).toContain('Header');
    await user.click(items.find((item) => item.textContent === 'Footer')!);
    const doc = docOf();
    expect(doc.body.map((b) => b.id)).not.toContain('intro');
    expect(doc.footer.at(-1)?.id).toBe('intro');
  });

  it('shows errors, warnings and redacted fields of the node', () => {
    const doc = sampleDocument();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PropertiesPanel
          doc={doc}
          selectedId="title"
          schema={schema}
          onChange={() => undefined}
          onSelect={() => undefined}
          problems={[
            { nodeId: 'title', severity: 'error', message: 'Unknown variable request.nope.' },
            { nodeId: 'intro', severity: 'error', message: 'Not for this node.' },
          ]}
          redacted={['request.number']}
        />
      </QueryClientProvider>,
    );
    const notices = screen.getByTestId('node-notices');
    expect(notices).toHaveTextContent('Unknown variable request.nope.');
    expect(notices).not.toHaveTextContent('Not for this node.');
    expect(notices).toHaveTextContent('request.number stays empty');
  });

  it('warns that a form table or page break outside the body does nothing', () => {
    const { doc, id } = withNode('sheet');
    const sheet = doc.body.pop()!;
    doc.footer.push(sheet);
    mount(doc, id);
    expect(panel().getByRole('note')).toHaveTextContent('only takes effect in the body');
  });
});

describe('colour and size links', () => {
  it('changes a table header background with a document colour swatch, and keeps the field in step with the style', async () => {
    const user = userEvent.setup();
    const { doc, id } = withNode('table');
    mount(doc, id);
    await user.click(panel().getByRole('button', { name: /Header background/ }));
    await user.click(await screen.findByLabelText('Red'));
    expect(find(docOf(), id)?.node).toMatchObject({ headerFill: '$c:red' });
    expect(panel().getByRole('button', { name: /Header background/ })).toHaveTextContent('Red');
    // The note names the colour and its uses; "Edit for every use" switches the picker to the document colour.
    expect(screen.getByText(/Linked to/)).toHaveTextContent('Linked to Red (1×)');
    await user.click(screen.getByText('Edit “Red” for every use'));
    expect(screen.getByText(/Editing document colour/)).toBeInTheDocument();
    const hex = screen.getByLabelText('Hex colour');
    await user.clear(hex);
    await user.type(hex, '00ff00');
    expect(docOf().styles.colors.find((c) => c.id === 'red')?.value).toBe('#00ff00');
    expect(panel().getByRole('button', { name: /Header background/ })).toHaveTextContent('#00FF00');
  });

  it('detaches a linked colour and saves a custom colour as a document colour', async () => {
    const user = userEvent.setup();
    const { doc, id } = withNode('table');
    mount(doc, id);
    await user.click(panel().getByRole('button', { name: /Header background/ }));
    await user.click(await screen.findByLabelText('Red'));
    await user.click(panel().getAllByRole('button', { name: 'Detach from the document colour' })[0]);
    expect(find(docOf(), id)?.node).toMatchObject({ headerFill: '#d0103a' });
    await user.click(panel().getByRole('button', { name: /Header background/ }));
    await user.click(await screen.findByText('Save as document colour'));
    const saved = docOf().styles.colors.at(-1)!;
    expect(saved.value).toBe('#d0103a');
    expect(find(docOf(), id)?.node).toMatchObject({ headerFill: `$c:${saved.id}` });
  });

  it('offers None for optional colours', async () => {
    const user = userEvent.setup();
    const { doc, id } = withNode('table');
    mount(doc, id);
    await user.click(panel().getByRole('button', { name: /Every second row/ }));
    await user.click(await within(document.querySelector<HTMLElement>('.pdft-cpick')!).findByText('None'));
    expect(find(docOf(), id)?.node).not.toHaveProperty('zebra');
  });

  it('links a size, shows it as a chip and detaches it', async () => {
    const user = userEvent.setup();
    const { doc, id } = withNode('divider');
    const divider = find(doc, id)!.node;
    if (divider.type === 'divider') divider.stroke = '$s:rule';
    mount(doc, id);
    expect(panel().getByText('Rule · 0.25 mm')).toBeInTheDocument();
    await user.click(panel().getByRole('button', { name: 'Detach from the document size' }));
    expect(find(docOf(), id)?.node).toMatchObject({ stroke: 0.25 });
    expect(panel().getByLabelText('Thickness (mm)')).toHaveValue(0.25);
  });

  it('switches a text style to Custom by copying its values', async () => {
    const user = userEvent.setup();
    mount(sampleDocument(), 'intro');
    expect(panel().getByLabelText('Text style')).toHaveValue('');
    await user.selectOptions(panel().getByLabelText('Text style'), 'body');
    expect(find(docOf(), 'intro')?.node).toMatchObject({ textStyle: 'body' });
    expect(panel().queryByLabelText('Weight')).not.toBeInTheDocument();
    await user.selectOptions(panel().getByLabelText('Text style'), '');
    expect(find(docOf(), 'intro')?.node).toMatchObject({ size: 10, weight: 400, color: '$c:text', lineHeight: 1.4 });
    expect(find(docOf(), 'intro')?.node).not.toHaveProperty('textStyle');
  });
});

describe('condition editor', () => {
  it('offers the values of the export and edits the comparison', async () => {
    const user = userEvent.setup();
    mount(sampleDocument(), 'cond');
    const value = panel().getByLabelText('Value');
    expect(
      within(value)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a value', 'request.note', 'request.number', 'request.total', 'item.description', 'item.amount']);
    expect(panel().queryByLabelText('Compare with')).not.toBeInTheDocument();
    await user.selectOptions(panel().getByLabelText('Comparison'), 'eq');
    await user.type(panel().getByLabelText('Compare with'), 'x');
    await user.selectOptions(value, 'request.total');
    expect(find(docOf(), 'cond')?.node).toMatchObject({ when: { path: 'request.total', op: 'eq', value: 'x' } });
  });
});

describe('StylesPanel', () => {
  it('counts uses, adds styles and deletes a colour keeping its value', async () => {
    const user = userEvent.setup();
    const { doc, id } = withNode('table');
    const table = find(doc, id)!.node;
    if (table.type === 'table') table.headerFill = '$c:red';
    mount(doc, id);
    const styles = within(screen.getByTestId('styles-panel'));
    const red = styles.getByDisplayValue('Red').closest('.pdft-stylerow') as HTMLElement;
    expect(within(red).getByText('1×')).toBeInTheDocument();
    await user.click(within(red).getByRole('button', { name: /Delete Red/ }));
    expect(find(docOf(), id)?.node).toMatchObject({ headerFill: '#d0103a' });
    expect(docOf().styles.colors.map((c) => c.id)).toEqual(['text']);
    await user.click(styles.getAllByRole('button', { name: 'Add' })[0]);
    expect(docOf().styles.colors).toHaveLength(2);
    await user.click(styles.getAllByRole('button', { name: 'Add' })[2]);
    expect(docOf().styles.sizes).toHaveLength(2);
  });

  it('edits a size, and a linked field follows', async () => {
    const user = userEvent.setup();
    const { doc, id } = withNode('divider');
    const divider = find(doc, id)!.node;
    if (divider.type === 'divider') divider.stroke = '$s:rule';
    mount(doc, id);
    const value = within(screen.getByTestId('styles-panel')).getByLabelText('Value');
    await user.clear(value);
    await user.type(value, '0.5');
    expect(panel().getByText('Rule · 0.5 mm')).toBeInTheDocument();
  });
});

describe('VariablesPanel', () => {
  it('lists fields with descriptions, examples and filters, and searches', async () => {
    const user = userEvent.setup();
    mount(sampleDocument(), null);
    const vars = within(screen.getByTestId('variables-panel'));
    expect(vars.getByText('request.number')).toBeInTheDocument();
    expect(vars.getByText('e.g. IR-2026-0042')).toBeInTheDocument();
    expect(vars.getByText('Formats an amount with the currency')).toBeInTheDocument();
    await user.type(vars.getByRole('searchbox'), 'amount');
    expect(vars.queryByText('request.number')).not.toBeInTheDocument();
    expect(vars.getByText('items[].amount')).toBeInTheDocument();
    expect(vars.getByText('Formats an amount with the currency')).toBeInTheDocument();
    await user.clear(vars.getByRole('searchbox'));
    await user.type(vars.getByRole('searchbox'), 'zzz');
    expect(vars.getByText('No variable matches.')).toBeInTheDocument();
  });

  it('inserts at the caret of the field focused last, with the loop name for list fields', async () => {
    const user = userEvent.setup();
    mount(sampleDocument(), 'intro');
    const vars = within(screen.getByTestId('variables-panel'));
    await user.click(vars.getByText('request.number'));
    expect(vars.getByText(/Click into a text field in Properties first/)).toBeInTheDocument();
    const text = panel().getByLabelText('Text') as HTMLTextAreaElement;
    await user.click(text);
    text.setSelectionRange(5, 5);
    await user.click(vars.getByText('request.number'));
    expect(find(docOf(), 'intro')?.node).toMatchObject({ text: 'Hello{{request.number}}' });
    // The caret ends behind the token once the controlled field has taken the value.
    await waitFor(() => expect(text.selectionStart).toBe(5 + '{{request.number}}'.length));
    await user.click(vars.getByText('items[].amount'));
    expect(find(docOf(), 'intro')?.node).toMatchObject({ text: 'Hello{{request.number}}{{item.amount}}' });
  });
});
