import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LabRulesAgreement } from './LabRulesAgreement';

vi.mock('../../../app/pdf/renderPdf', () => ({
  renderPdf: async (url: string, container: HTMLElement, _signal: AbortSignal, onFirstPage: () => void) => {
    container.textContent = `Mock PDF viewer ${url}`;
    onFirstPage();
  },
}));

// jsdom lays nothing out: give the PDF box a 1000 px document in a 300 px window.
const pdfBox = (element: Element) => element.classList.contains('lab-rules-agreement__pdf');
const height = (fallback: PropertyDescriptor | undefined, value: number) => ({
  configurable: true,
  get(this: HTMLElement) {
    return pdfBox(this) ? value : (fallback?.get?.call(this) ?? 0);
  },
});
const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');

afterEach(() => {
  if (scrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', scrollHeight);
  if (clientHeight) Object.defineProperty(Element.prototype, 'clientHeight', clientHeight);
});

describe('Lab Rules agreement', () => {
  it('unlocks the checkbox only once the PDF was scrolled to its end', async () => {
    Object.defineProperty(Element.prototype, 'scrollHeight', height(scrollHeight, 1000));
    Object.defineProperty(Element.prototype, 'clientHeight', height(clientHeight, 300));
    render(
      <LabRulesAgreement id="agree" revision="7" pdfUrl="/rules.pdf" checked={false} onCheckedChange={() => {}} />,
    );
    expect(await screen.findByText('Mock PDF viewer /rules.pdf')).toBeInTheDocument();
    const checkbox = screen.getByLabelText(/I have read the Lab Rules/);
    expect(checkbox).toBeDisabled();
    expect(screen.getByText('Scroll to the end of the Lab Rules to confirm')).toBeInTheDocument();

    const box = screen.getByRole('region', { name: 'Lab Rules, revision 7' });
    box.scrollTop = 400;
    fireEvent.scroll(box);
    expect(checkbox).toBeDisabled();
    box.scrollTop = 700;
    fireEvent.scroll(box);
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(screen.queryByText('Scroll to the end of the Lab Rules to confirm')).not.toBeInTheDocument();
  });

  it('unlocks right away when the whole document fits', async () => {
    render(
      <LabRulesAgreement id="agree" revision="7" pdfUrl="/rules.pdf" checked={false} onCheckedChange={() => {}} />,
    );
    await waitFor(() => expect(screen.getByLabelText(/I have read the Lab Rules/)).toBeEnabled());
  });
});
