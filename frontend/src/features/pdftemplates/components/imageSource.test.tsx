import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { PdfTemplateSchema } from '../../../api/generated/models';
import { server } from '../../../test/server';
import { EXPORT_KINDS, EXPORT_LABELS } from '../exports';
import { createInsertRegistry, InsertContext } from '../insertTarget';
import { describe as describeNode, type ImageBlock, type TemplateDocument } from '../model';
import { sampleDocument, sampleSchema } from '../testFixtures';
import { PropertiesPanel } from './PropertiesPanel';

function projektantragSchema(): PdfTemplateSchema {
  const schema = sampleSchema();
  schema.groups.push(
    { name: 'Signature', fields: [{ path: 'signature', type: 'image', description: 'Signature image' }] },
    { name: 'Always available', fields: [{ path: 'makerspace.logo', type: 'image', description: 'Logo' }] },
  );
  return schema;
}

function mount(schema: PdfTemplateSchema) {
  server.use(http.get('*/api/v1/pdf-templates/assets', () => HttpResponse.json([])));
  const initial = sampleDocument();
  initial.body.push({ id: 'sig', type: 'image', title: 'Signature', height: 20 });
  function Shell() {
    const [doc, setDoc] = useState<TemplateDocument>(initial);
    const [registry] = useState(() => createInsertRegistry());
    return (
      <InsertContext.Provider value={registry}>
        <PropertiesPanel
          doc={doc}
          selectedId="sig"
          schema={schema}
          onChange={setDoc}
          onSelect={() => undefined}
          problems={[]}
          redacted={[]}
        />
        <output data-testid="doc">{JSON.stringify(doc)}</output>
      </InsertContext.Provider>
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Shell />
    </QueryClientProvider>,
  );
}

const imageNode = () =>
  (JSON.parse(screen.getByTestId('doc').textContent!) as TemplateDocument).body.find(
    (b) => b.id === 'sig',
  ) as ImageBlock;

describe('image block source', () => {
  it('places an image variable of the export instead of the logo, and back', async () => {
    mount(projektantragSchema());
    const panel = within(screen.getByTestId('properties-panel'));
    const select = panel.getByLabelText('Image');
    // The logo is the empty source; it is never offered as a variable.
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Logo from the branding settings', 'signature']);
    await userEvent.selectOptions(select, 'signature');
    expect(imageNode().source).toBe('signature');
    expect(panel.getByText(/comes with the data of each document/)).toBeInTheDocument();
    await userEvent.selectOptions(select, '');
    expect(imageNode()).not.toHaveProperty('source');
  });

  it('shows no choice where the export has no image variables', () => {
    mount(sampleSchema());
    expect(within(screen.getByTestId('properties-panel')).queryByLabelText('Image')).toBeNull();
  });

  it('names the image in the structure', () => {
    const node: ImageBlock = { id: 'i', type: 'image', height: 20, source: 'signature' };
    expect(describeNode(node, sampleDocument().styles).l2).toMatch(/^Image · signature/);
  });
});

describe('exports', () => {
  it('offers the Projektantrag in the document selector', () => {
    expect(EXPORT_KINDS).toContain('projektantrag');
    expect(EXPORT_LABELS.projektantrag).toBe('Projektantrag (working-group project)');
  });
});
