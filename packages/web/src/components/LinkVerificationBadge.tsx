export function LinkVerificationBadge({
  verified,
}: {
  readonly verified: boolean;
}) {
  if (!verified) {
    return (
      <span
        className="inline-flex items-center rounded-pill border border-hairline bg-surface-2 px-2 py-0.5 text-[9px] font-semibold tracking-[0.12em] text-text-muted uppercase"
        title="The recipient's ownership of this address has not been verified."
      >
        Unverified
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center rounded-pill border border-warn/30 bg-warn/10 px-2 py-0.5 text-[9px] font-semibold tracking-[0.12em] text-warn uppercase"
      title="Test-mode signature only; this is not a real ownership check."
    >
      Test-mode signature
    </span>
  );
}
