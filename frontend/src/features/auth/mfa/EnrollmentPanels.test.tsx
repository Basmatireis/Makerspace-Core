import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderRoute } from '../../../test/render';
import { server } from '../../../test/server';
import { TotpEnrollmentPanel } from './EnrollmentPanels';

const otpauthUri = 'otpauth://totp/Makerspace:ada?secret=JBSWY3DPEHPK3PXP';

describe('TotpEnrollmentPanel', () => {
  it('shows a scannable QR code of the otpauth URI with the key as fallback', async () => {
    server.use(
      http.post('*/api/v1/auth/second-factors/totp/enrollment', () =>
        HttpResponse.json({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri, expiresAt: '2099-01-01T00:00:00Z' }),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<TotpEnrollmentPanel onEnrolled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Set up authenticator app' }));
    const qr = await screen.findByRole('img', { name: 'QR code for your authenticator app' });
    expect(qr.querySelector('path')?.getAttribute('d')).toBeTruthy();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy setup key' })).toBeInTheDocument();
    expect(screen.queryByText(otpauthUri)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open it in an authenticator app/ })).toHaveAttribute('href', otpauthUri);
  });
});
