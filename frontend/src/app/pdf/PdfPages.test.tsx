import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PdfPages } from './PdfPages';

vi.mock('./renderPdf', () => ({
  renderPdf: async () => {
    throw new Error('unsupported browser');
  },
}));

describe('PdfPages', () => {
  it('offers the PDF in a new tab when it cannot be rendered inline', async () => {
    render(<PdfPages url="/api/v1/visitor-enrollment/lab-rules.pdf" />);

    expect(await screen.findByText('The Lab Rules could not be displayed.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in new tab' })).toHaveAttribute(
      'href',
      '/api/v1/visitor-enrollment/lab-rules.pdf',
    );
  });
});
