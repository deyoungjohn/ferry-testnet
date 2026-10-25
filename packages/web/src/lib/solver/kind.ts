/** One source of truth for "is the solver real": drives the label, the banner and explorer links. */
export function solverIsLive(): boolean {
  return Boolean(import.meta.env.VITE_SOLVER_URL);
}
