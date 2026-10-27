import type { PayLink } from '@ferry/core';
import { QRCodeSVG } from 'qrcode.react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { Link } from 'react-router';
import { LinkVerificationBadge } from '../components/LinkVerificationBadge';
import { parseBchAddress, type BchAddressInfo } from '../lib/bch/address';
import { BCH_PREFIX } from '../lib/config';
import {
  chunkCashaddr,
  createChallenge,
  payLinkMessage,
  payLinksMessage,
  payLinkUrl,
} from '../lib/paylink/link';
import { useSolver } from '../lib/solver/context';
import { formatPusd, parsePusdAmount } from '../lib/swap';
import { useWallets } from '../lib/wallet/context';

type Kind = 'invoice' | 'open';

function formatExpiry(seconds: number | undefined): string {
  if (!seconds) return 'No expiry';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(seconds * 1000));
}

export function PayLinksPage() {
  const { bch } = useWallets();
  const solver = useSolver();
  const [kind, setKind] = useState<Kind>('invoice');
  const [amount, setAmount] = useState('10.00');
  const [minimum, setMinimum] = useState('1.00');
  const [memo, setMemo] = useState('');
  const [reference, setReference] = useState('');
  const [expiryHours, setExpiryHours] = useState('24');
  const [paste, setPaste] = useState('');
  const [pasted, setPasted] = useState<BchAddressInfo | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [created, setCreated] = useState<PayLink | null>(null);
  const [links, setLinks] = useState<readonly PayLink[]>([]);
  const [listNote, setListNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const recipient = bch.address ?? pasted;
  const canSign = Boolean(
    bch.address &&
    bch.signMessage &&
    recipient?.address === bch.address.address,
  );

  const loadLinks = useCallback(async () => {
    if (!bch.address || !bch.signMessage) {
      setLinks([]);
      setListNote(
        'Connect a BCH wallet that can sign a message to see your links.',
      );
      return;
    }
    try {
      const challenge = createChallenge();
      const sig = await bch.signMessage(
        payLinksMessage(bch.address.address, challenge),
      );
      const next = await solver.listPayLinks({
        owner: bch.address.address,
        challenge,
        sig,
      });
      setLinks(next);
      setListNote(null);
    } catch (cause) {
      setLinks([]);
      setListNote(
        cause instanceof Error ? cause.message : 'Could not load your links',
      );
    }
  }, [bch, solver]);

  useEffect(() => {
    void loadLinks();
  }, [loadLinks]);

  function handlePaste(): void {
    const parsed = parseBchAddress(paste);
    if (!parsed.ok) {
      setPasteError(parsed.error);
      return;
    }
    setPasted(parsed.value);
    setPaste('');
    setPasteError(null);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recipient) {
      setError('Connect a BCH wallet or paste a token-aware address.');
      return;
    }
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const amountOut =
        kind === 'invoice' ? parsePusdAmount(amount) : undefined;
      const minAmountOut =
        kind === 'open' && minimum.trim()
          ? parsePusdAmount(minimum)
          : undefined;
      const hours = Number(expiryHours);
      const expiresAt =
        Number.isFinite(hours) && hours > 0
          ? Math.floor(Date.now() / 1000) + Math.round(hours * 3600)
          : undefined;
      const challenge = createChallenge();
      const signature = canSign
        ? await bch.signMessage?.(
            payLinkMessage(challenge, recipient.lockingBytecode),
          )
        : undefined;
      const link = await solver.createPayLink({
        kind,
        recipientCashaddr: recipient.address,
        recipientLockingBytecode: recipient.lockingBytecode,
        token: 'PUSD',
        ...(amountOut !== undefined ? { amountOut } : {}),
        ...(minAmountOut !== undefined ? { minAmountOut } : {}),
        ...(memo.trim() ? { memo: memo.trim() } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(signature ? { verification: { challenge, signature } } : {}),
      });
      setCreated(link);
      await loadLinks();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not create the link',
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function handleCancel(link: PayLink): Promise<void> {
    if (!bch.address || !bch.signMessage) return;
    try {
      const challenge = createChallenge();
      const sig = await bch.signMessage(
        payLinksMessage(bch.address.address, challenge),
      );
      await solver.cancelPayLink(link.id, {
        owner: bch.address.address,
        challenge,
        sig,
      });
      await loadLinks();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not cancel the link',
      );
    }
  }

  const createdUrl = created ? payLinkUrl(created.id) : null;
  const expiresLabel = useMemo(
    () => formatExpiry(created?.expiresAt),
    [created?.expiresAt],
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-12 pb-20 sm:px-6">
      <p className="text-[10px] font-semibold tracking-[0.2em] text-lime uppercase">
        Pay links
      </p>
      <h1 className="mt-3 max-w-2xl text-3xl font-medium tracking-[-0.04em] text-text sm:text-4xl">
        Get paid in dollars on Bitcoin Cash.
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted">
        Create an invoice or an open tip link. Your payer can use USDC on Base;
        the exact amount lands in your BCH wallet.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <form
          onSubmit={handleCreate}
          className="rounded-card border border-hairline bg-surface-1 p-5 sm:p-6"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">New link</h2>
            <div className="flex rounded-pill bg-surface-2 p-0.5 text-[11px] ring-1 ring-hairline">
              {(['invoice', 'open'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setKind(value)}
                  aria-pressed={kind === value}
                  className={`rounded-pill px-3 py-1.5 capitalize ${
                    kind === value
                      ? 'bg-text font-semibold text-bg'
                      : 'text-text-muted'
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5 space-y-4">
            <div>
              <label
                className="text-xs font-medium text-text-muted"
                htmlFor="link-amount"
              >
                {kind === 'invoice'
                  ? 'Amount they receive'
                  : 'Suggested amount'}
              </label>
              <div className="mt-2 flex items-center gap-2 rounded-well bg-surface-2 px-4 py-3 ring-1 ring-hairline">
                <input
                  id="link-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-2xl font-medium tabular-nums outline-none"
                />
                <span className="text-sm text-text-muted">tPUSD</span>
              </div>
            </div>

            {kind === 'open' ? (
              <div>
                <label
                  className="text-xs font-medium text-text-muted"
                  htmlFor="link-minimum"
                >
                  Minimum (optional)
                </label>
                <input
                  id="link-minimum"
                  inputMode="decimal"
                  value={minimum}
                  onChange={(event) => setMinimum(event.target.value)}
                  className="mt-2 w-full rounded-well bg-surface-2 px-4 py-3 text-sm tabular-nums ring-1 ring-hairline outline-none"
                />
              </div>
            ) : null}

            <div>
              <label
                className="text-xs font-medium text-text-muted"
                htmlFor="link-memo"
              >
                Memo (optional)
              </label>
              <input
                id="link-memo"
                maxLength={140}
                value={memo}
                onChange={(event) => setMemo(event.target.value)}
                placeholder="Kitchen order 1042"
                className="mt-2 w-full rounded-well bg-surface-2 px-4 py-3 text-sm ring-1 ring-hairline outline-none"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  className="text-xs font-medium text-text-muted"
                  htmlFor="link-reference"
                >
                  Reference (optional)
                </label>
                <input
                  id="link-reference"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  className="mt-2 w-full rounded-well bg-surface-2 px-4 py-3 text-sm ring-1 ring-hairline outline-none"
                />
              </div>
              <div>
                <label
                  className="text-xs font-medium text-text-muted"
                  htmlFor="link-expiry"
                >
                  Expires
                </label>
                <select
                  id="link-expiry"
                  value={expiryHours}
                  onChange={(event) => setExpiryHours(event.target.value)}
                  className="mt-2 w-full rounded-well bg-surface-2 px-4 py-3 text-sm ring-1 ring-hairline outline-none"
                >
                  <option value="1">In 1 hour</option>
                  <option value="24">In 24 hours</option>
                  <option value="168">In 7 days</option>
                  <option value="0">Never</option>
                </select>
              </div>
            </div>

            <div className="rounded-well bg-surface-2 p-4 ring-1 ring-hairline">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-text-muted">
                  Recipient BCH address
                </p>
                <button
                  type="button"
                  onClick={() => bch.connect()}
                  className="text-[11px] font-semibold text-lime"
                >
                  {bch.address ? 'Reconnect' : 'Connect BCH wallet'}
                </button>
              </div>
              {recipient ? (
                <p className="mt-2 break-all font-mono text-[11px] leading-5 text-text">
                  {chunkCashaddr(recipient.address)}
                </p>
              ) : (
                <p className="mt-2 text-xs text-text-muted">
                  Connect a WizardConnect wallet or paste a token-aware address.
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <input
                  aria-label="Paste BCH address"
                  value={paste}
                  onChange={(event) => setPaste(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handlePaste();
                    }
                  }}
                  placeholder={`${BCH_PREFIX}:z…`}
                  className="min-w-0 flex-1 rounded-pill bg-surface-1 px-3 py-2 font-mono text-[11px] ring-1 ring-hairline outline-none"
                />
                <button
                  type="button"
                  onClick={handlePaste}
                  className="rounded-pill bg-surface-3 px-3 py-2 text-[11px] font-semibold text-text"
                >
                  Use
                </button>
              </div>
              {pasteError ? (
                <p className="mt-2 text-xs text-danger" role="alert">
                  {pasteError}
                </p>
              ) : null}
              <p className="mt-3 text-[11px] text-text-muted">
                {canSign
                  ? 'This wallet can attach a test-mode signature. It is not a real ownership check yet.'
                  : 'Unverified: this address was pasted or the wallet cannot sign a challenge.'}
              </p>
            </div>

            {error ? (
              <p className="text-sm text-danger" role="alert">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={busy || !recipient}
              className="w-full rounded-pill bg-lime px-4 py-3 text-sm font-semibold text-lime-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create pay link'}
            </button>
          </div>
        </form>

        <div className="space-y-4">
          {created && createdUrl ? (
            <section className="rounded-card border border-lime/25 bg-surface-1 p-5 sm:p-6">
              <div className="flex items-center gap-2">
                <span className="rounded-pill bg-olive-soft px-2 py-0.5 text-[9px] font-semibold tracking-[0.12em] text-lime uppercase">
                  Ready
                </span>
                <LinkVerificationBadge verified={created.verified} />
              </div>
              <h2 className="mt-3 text-lg font-medium">
                {created.kind === 'invoice'
                  ? `${formatPusd(created.amountOut ?? 0n)} tPUSD invoice`
                  : 'Open pay link'}
              </h2>
              <p className="mt-1 text-xs text-text-muted">{expiresLabel}</p>
              <div className="mt-4 rounded-well bg-white p-3">
                <QRCodeSVG value={createdUrl} size={176} marginSize={2} />
              </div>
              <p className="mt-4 break-all font-mono text-[11px] leading-5 text-text">
                {createdUrl}
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopy(createdUrl)}
                  className="rounded-pill bg-text px-3 py-2 text-xs font-semibold text-bg"
                >
                  {copied ? 'Copied' : 'Copy link'}
                </button>
                <Link
                  to={`/p/${created.id}`}
                  className="rounded-pill bg-surface-3 px-3 py-2 text-xs font-semibold text-text"
                >
                  Preview
                </Link>
              </div>
            </section>
          ) : null}

          <section className="rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Your links</h2>
              <button
                type="button"
                onClick={() => void loadLinks()}
                className="text-[11px] font-semibold text-lime"
              >
                Refresh
              </button>
            </div>
            {listNote ? (
              <p className="mt-3 text-xs leading-5 text-text-muted">
                {listNote}
              </p>
            ) : links.length === 0 ? (
              <p className="mt-3 text-xs text-text-muted">No links yet.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {links.map((link) => (
                  <li
                    key={link.id}
                    className="rounded-well bg-surface-2 p-3 ring-1 ring-hairline"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {link.kind === 'invoice'
                            ? `${formatPusd(link.amountOut ?? 0n)} tPUSD`
                            : 'Open link'}
                          {link.memo ? ` · ${link.memo}` : ''}
                        </p>
                        <p className="mt-1 text-[11px] text-text-muted">
                          {link.status} · {formatExpiry(link.expiresAt)}
                        </p>
                      </div>
                      <Link
                        to={`/p/${link.id}`}
                        className="shrink-0 text-[11px] font-semibold text-lime"
                      >
                        Open
                      </Link>
                    </div>
                    {link.status === 'open' ? (
                      <button
                        type="button"
                        onClick={() => void handleCancel(link)}
                        className="mt-2 text-[11px] text-danger"
                      >
                        Cancel
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
