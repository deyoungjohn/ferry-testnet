import { useSolverHealth } from '../lib/solver/useSolverHealth';
import { solverIsLive } from '../lib/solver/kind';

function age(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds).toString()}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60).toString()}m`;
  return `${Math.floor(seconds / 3_600).toString()}h`;
}

export function SolverHealthLine() {
  const state = useSolverHealth();
  const live = solverIsLive();
  const label = live ? 'Live solver' : 'Mock solver (simulated health)';

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-[11px] text-text-muted">
        Solver health: checking…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <p role="status" className="text-[11px] text-text-muted">
        Solver health: unavailable — cannot reach /v1/health
      </p>
    );
  }

  const { health } = state;
  const base = health.counterTips.base;
  const baseText = base
    ? `Base tip ${base.stale ? 'stale' : 'healthy'} at ${base.height.toLocaleString('en-US')} (${age(base.ageSeconds)} old)`
    : 'Base tip unavailable';

  return (
    <p role="status" className="text-[11px] leading-5 text-text-muted">
      Solver health: {label} · Quoting {health.quoting ? 'on' : 'off'} · BCH tip{' '}
      {health.bchTip.stale ? 'stale' : 'healthy'} at{' '}
      {health.bchTip.height.toLocaleString('en-US')} (
      {age(health.bchTip.ageSeconds)} old) · {baseText}
    </p>
  );
}
