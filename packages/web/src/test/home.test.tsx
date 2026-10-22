import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../App';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('home page', () => {
  it('renders the headline', () => {
    renderAt('/');

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /move dollars onto bitcoin cash without a bridge/i,
      }),
    ).toBeInTheDocument();
  });

  it('renders the static swap card with mock values', () => {
    renderAt('/');

    expect(screen.getByRole('region', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.getByText('You send')).toBeInTheDocument();
    expect(screen.getByText('You receive')).toBeInTheDocument();
    expect(screen.getByText('250.00')).toBeInTheDocument();
    expect(screen.getByText('248.80')).toBeInTheDocument();
    expect(screen.getByText('Mock quote')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ferry it/i })).toBeInTheDocument();
  });
});

describe('placeholder routes', () => {
  it('renders the recover page', () => {
    renderAt('/recover');

    expect(screen.getByRole('heading', { level: 1, name: /recover a swap/i })).toBeInTheDocument();
  });

  it('renders the pay link page with the link id', () => {
    renderAt('/p/link_123');

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Link link_123')).toBeInTheDocument();
  });
});
