// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LinkVerificationBadge } from '../components/LinkVerificationBadge';

describe('pay-link verification badge', () => {
  it('shows unverified by default and never green', () => {
    render(<LinkVerificationBadge verified={false} />);
    const badge = screen.getByText('Unverified');
    expect(badge).not.toHaveClass('bg-ok/15');
    expect(badge).not.toHaveClass('text-ok');
  });

  it('labels a mock signature as test-mode, not a real check', () => {
    render(<LinkVerificationBadge verified />);
    expect(screen.getByText('Test-mode signature')).toHaveAttribute(
      'title',
      expect.stringMatching(/not a real ownership check/i),
    );
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
  });
});
