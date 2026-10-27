import {
  broadcastBchClaim,
  broadcastBchRefund,
  evmRefundCalldata,
  loadRecoverySnapshot,
  parseRecoveryJson,
  sendEvmRefund,
  validateRecoveryFile,
  type Eip1193Provider,
  type ElectrumUtxo,
  type RecoveryEndpoints,
  type RecoverySnapshot,
} from './core';
import type { RecoveryFile } from '../lib/recovery';
import {
  BASE_RPC_URL,
  BCH_ELECTRUM_URL,
  NETWORK_CONFIG_ERRORS,
  NETWORK_LABEL,
} from '../lib/config';

type StatusKind = 'info' | 'error' | 'ok';

const app = document.querySelector<HTMLDivElement>('#recover-app');
if (!app) throw new Error('Missing recovery root');
const root = app;

if (NETWORK_CONFIG_ERRORS.length > 0) {
  root.innerHTML = `
    <main class="shell">
      <p class="eyebrow">Ferry recovery · ${NETWORK_LABEL}</p>
      <h1>${NETWORK_LABEL} profile blocked.</h1>
      <p class="lede">
        No recovery action can run until every value in this network profile is
        verified. No funds can move.
      </p>
      <section class="card" role="alert">
        <h2>Missing or unverified configuration</h2>
        <ul id="blocked-errors"></ul>
      </section>
    </main>
  `;
  const list = document.getElementById('blocked-errors');
  for (const error of NETWORK_CONFIG_ERRORS) {
    const item = document.createElement('li');
    item.textContent = error;
    list?.append(item);
  }
} else {
  startRecoveryPage();
}

function startRecoveryPage(): void {
  root.innerHTML = `
  <main class="shell">
    <p class="eyebrow">Ferry recovery · ${NETWORK_LABEL}</p>
    <h1>Finish without us.</h1>
    <p class="lede">
      Load the recovery file you downloaded before locking. This page runs from
      disk, rebuilds the BCH contract address from the signed terms, and checks
      both chains directly. No Ferry server or solver is involved.
    </p>

    <section class="card" aria-labelledby="load-title">
      <h2 id="load-title">1. Load the recovery file</h2>
      <p>The file is named ferry-&lt;orderId&gt;.json. The secret stays in this tab.</p>
      <div class="grid">
        <div>
          <label for="recovery-file">Recovery file</label>
          <input id="recovery-file" type="file" accept="application/json,.json" />
        </div>
      </div>
      <div id="file-status" class="status" role="status"></div>
    </section>

    <section class="card hidden" id="endpoint-card" aria-labelledby="endpoint-title">
      <h2 id="endpoint-title">2. Choose endpoints</h2>
      <p>Public endpoints are editable. The page never sends the secret to either one.</p>
      <div class="grid">
        <div>
          <label for="electrum-url">BCH Electrum WebSocket</label>
          <input id="electrum-url" type="url" spellcheck="false" />
        </div>
        <div>
          <label for="base-rpc-url">Base RPC</label>
          <input id="base-rpc-url" type="url" spellcheck="false" />
        </div>
      </div>
      <div class="actions">
        <button id="check-chains" class="primary" type="button">Check both chains</button>
      </div>
      <div id="check-status" class="status" role="status"></div>
    </section>

    <section class="card hidden" id="summary-card" aria-labelledby="summary-title">
      <h2 id="summary-title">3. Review the recovered order</h2>
      <dl class="facts" id="summary-facts"></dl>
      <div id="address-warning" class="status error" role="alert"></div>
    </section>

    <section class="card hidden" id="action-card" aria-labelledby="action-title">
      <h2 id="action-title">4. Finish the swap</h2>
      <div id="action-copy"></div>
      <div class="actions" id="action-buttons"></div>
      <div id="action-status" class="status" role="status"></div>
      <div class="notice" id="calldata-box">
        <strong>No injected wallet?</strong>
        <p>Send this calldata from the Base wallet that created the lock. The page never asks for a private key.</p>
        <textarea id="calldata" readonly spellcheck="false"></textarea>
      </div>
    </section>

    <section class="card">
      <h2>What this page will never do</h2>
      <p>
        It never asks for a seed phrase or private key. It never puts the secret
        in a URL, a log, or an analytics event. The only time the secret leaves
        this tab is inside the BCH claim transaction you approve.
      </p>
    </section>
  </main>
`;

  function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing element ${id}`);
    return found as T;
  }

  const fileInput = element<HTMLInputElement>('recovery-file');
  const fileStatus = element<HTMLDivElement>('file-status');
  const endpointCard = element<HTMLElement>('endpoint-card');
  const electrumInput = element<HTMLInputElement>('electrum-url');
  const baseRpcInput = element<HTMLInputElement>('base-rpc-url');
  const checkButton = element<HTMLButtonElement>('check-chains');
  const checkStatus = element<HTMLDivElement>('check-status');
  const summaryCard = element<HTMLElement>('summary-card');
  const summaryFacts = element<HTMLDListElement>('summary-facts');
  const addressWarning = element<HTMLDivElement>('address-warning');
  const actionCard = element<HTMLElement>('action-card');
  const actionCopy = element<HTMLDivElement>('action-copy');
  const actionButtons = element<HTMLDivElement>('action-buttons');
  const actionStatus = element<HTMLDivElement>('action-status');
  const calldataBox = element<HTMLElement>('calldata-box');
  const calldata = element<HTMLTextAreaElement>('calldata');

  let file: RecoveryFile | null = null;
  let snapshot: RecoverySnapshot | null = null;
  let busy = false;

  electrumInput.value = BCH_ELECTRUM_URL;
  baseRpcInput.value = BASE_RPC_URL;

  function setStatus(
    target: HTMLDivElement,
    message: string,
    kind: StatusKind = 'info',
  ): void {
    target.className = `status ${kind}`;
    target.textContent = message;
  }

  function endpoints(): RecoveryEndpoints {
    return {
      electrumUrl: electrumInput.value.trim(),
      baseRpcUrl: baseRpcInput.value.trim(),
    };
  }

  function fact(label: string, value: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'fact';
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    wrapper.append(term, detail);
    return wrapper;
  }

  function short(value: string, left = 10, right = 8): string {
    return value.length <= left + right + 1
      ? value
      : `${value.slice(0, left)}…${value.slice(-right)}`;
  }

  function renderSummary(): void {
    if (!file) return;
    const terms = file.terms;
    summaryFacts.replaceChildren(
      fact('Order', short(file.orderId)),
      fact(
        'Issued by',
        file.solverKind === 'mock' ? 'mock solver (simulation)' : 'live solver',
      ),
      fact(
        'You send',
        `${terms.counterAmount} base units on ${terms.counterChain}`,
      ),
      fact('You receive', `${terms.bchTokenAmount} ${terms.bchToken} on BCH`),
      fact('BCH HTLC address', file.contracts.bch.htlcAddress),
      fact('BCH token address', file.contracts.bch.tokenAddress),
      fact('BCH refund height', String(terms.bchRefundHeight)),
      fact(
        'Counter deadline',
        new Date(terms.counterDeadline * 1000).toLocaleString(),
      ),
      fact('Base contract', file.contracts.evm.address),
    );
    addressWarning.textContent = '';
    summaryCard.classList.remove('hidden');
  }

  function renderActions(): void {
    if (!file || !snapshot) return;
    actionCard.classList.remove('hidden');
    actionButtons.replaceChildren();
    actionCopy.replaceChildren();
    calldataBox.classList.add('hidden');
    calldata.value = evmRefundCalldata(file);

    const copy = document.createElement('p');
    const bch = snapshot.bch;
    const evm = snapshot.evm;
    const utxo = bch.ok ? bch.utxo : null;
    const bchRefundReady = Boolean(
      utxo && bch.ok && bch.tipHeight >= file.terms.bchRefundHeight,
    );
    const evmLock = evm.ok ? evm.lock : null;
    const evmRefundReady = Boolean(
      evmLock &&
      evm.ok &&
      evmLock.state === 1 &&
      evm.blockTimestamp >= Number(evmLock.deadline),
    );

    if (bch.ok) {
      copy.textContent = utxo
        ? `BCH lock found at ${short(utxo.txid)}:${utxo.vout}, ${utxo.satoshis} sats.`
        : 'No BCH lock is visible for this contract address.';
    } else {
      copy.textContent = `BCH check unavailable: ${bch.error}`;
    }
    if (evm.ok) {
      copy.textContent += ` Base lock state: ${evmLock?.state === 1 ? 'locked' : 'not locked'}.`;
    } else {
      copy.textContent += ` Base check unavailable: ${evm.error}`;
    }
    actionCopy.append(copy);

    if (utxo && bch.ok) {
      const claim = document.createElement('button');
      claim.type = 'button';
      claim.className = 'primary';
      claim.textContent = 'Claim BCH';
      claim.disabled = busy;
      claim.addEventListener('click', () => void handleClaim(utxo));
      actionButtons.append(claim);

      if (bchRefundReady) {
        const refund = document.createElement('button');
        refund.type = 'button';
        refund.className = 'secondary';
        refund.textContent = 'Refund BCH';
        refund.disabled = busy;
        refund.addEventListener('click', () => void handleBchRefund(utxo));
        actionButtons.append(refund);
      }
    }

    if (evmRefundReady && evm.ok) {
      const injected = (window as unknown as { ethereum?: Eip1193Provider })
        .ethereum;
      if (injected) {
        const refund = document.createElement('button');
        refund.type = 'button';
        refund.className = 'secondary';
        refund.textContent = 'Refund USDC with wallet';
        refund.disabled = busy;
        refund.addEventListener('click', () => void handleEvmRefund(injected));
        actionButtons.append(refund);
      }
      calldataBox.classList.remove('hidden');
    }

    if (actionButtons.childElementCount === 0) {
      const waiting = document.createElement('p');
      waiting.textContent =
        bchRefundReady || evmRefundReady
          ? 'No action is available from this browser yet.'
          : 'No valid branch yet. Check the deadlines and chain state again.';
      actionButtons.append(waiting);
    }
  }

  async function handleClaim(utxo: ElectrumUtxo): Promise<void> {
    if (!file || busy) return;
    busy = true;
    renderActions();
    setStatus(actionStatus, 'Building and broadcasting the BCH claim…');
    try {
      const txid = await broadcastBchClaim(file, utxo, endpoints().electrumUrl);
      setStatus(actionStatus, `BCH claim broadcast: ${txid}`, 'ok');
    } catch (cause) {
      setStatus(
        actionStatus,
        cause instanceof Error
          ? cause.message
          : 'Could not broadcast the claim',
        'error',
      );
    } finally {
      busy = false;
      renderActions();
    }
  }

  async function handleBchRefund(utxo: ElectrumUtxo): Promise<void> {
    if (!file || busy) return;
    busy = true;
    renderActions();
    setStatus(actionStatus, 'Building and broadcasting the BCH refund…');
    try {
      const txid = await broadcastBchRefund(
        file,
        utxo,
        endpoints().electrumUrl,
      );
      setStatus(actionStatus, `BCH refund broadcast: ${txid}`, 'ok');
    } catch (cause) {
      setStatus(
        actionStatus,
        cause instanceof Error
          ? cause.message
          : 'Could not broadcast the refund',
        'error',
      );
    } finally {
      busy = false;
      renderActions();
    }
  }

  async function handleEvmRefund(provider: Eip1193Provider): Promise<void> {
    if (!file || busy) return;
    busy = true;
    renderActions();
    setStatus(actionStatus, 'Waiting for the Base wallet…');
    try {
      const txHash = await sendEvmRefund(file, provider);
      setStatus(actionStatus, `Base refund submitted: ${txHash}`, 'ok');
    } catch (cause) {
      setStatus(
        actionStatus,
        cause instanceof Error ? cause.message : 'Could not submit the refund',
        'error',
      );
    } finally {
      busy = false;
      renderActions();
    }
  }

  async function checkChains(): Promise<void> {
    if (!file) return;
    checkButton.disabled = true;
    setStatus(checkStatus, 'Reading both chains…');
    try {
      snapshot = await loadRecoverySnapshot(file, endpoints());
      if (snapshot.bch.ok && snapshot.evm.ok) {
        setStatus(
          checkStatus,
          `BCH tip ${snapshot.bch.tipHeight}; Base block ${snapshot.evm.blockTimestamp}.`,
          'ok',
        );
      } else {
        const problems = [
          !snapshot.bch.ok ? `BCH: ${snapshot.bch.error}` : '',
          !snapshot.evm.ok ? `Base: ${snapshot.evm.error}` : '',
        ].filter(Boolean);
        setStatus(checkStatus, problems.join('\n'), 'error');
      }
      renderActions();
    } catch (cause) {
      setStatus(
        checkStatus,
        cause instanceof Error ? cause.message : 'Could not check the chains',
        'error',
      );
    } finally {
      checkButton.disabled = false;
    }
  }

  fileInput.addEventListener('change', () => {
    const selected = fileInput.files?.[0];
    if (!selected) return;
    setStatus(fileStatus, 'Reading the recovery file…');
    selected
      .text()
      .then((text) => {
        const parsed = parseRecoveryJson(text);
        file = validateRecoveryFile(parsed);
        snapshot = null;
        endpointCard.classList.remove('hidden');
        renderSummary();
        actionCard.classList.add('hidden');
        setStatus(
          fileStatus,
          file.solverKind === 'mock'
            ? 'Recovery file loaded. This file was issued by the mock solver and cannot be claimed on chain.'
            : 'Recovery file loaded. The BCH address was recomputed and matches.',
          'ok',
        );
      })
      .catch((cause: unknown) => {
        file = null;
        endpointCard.classList.add('hidden');
        summaryCard.classList.add('hidden');
        actionCard.classList.add('hidden');
        setStatus(
          fileStatus,
          cause instanceof Error ? cause.message : 'Could not read that file',
          'error',
        );
      });
  });

  checkButton.addEventListener('click', () => void checkChains());
}
