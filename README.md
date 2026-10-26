# Tesserax Wallet

The wallet of [Tesserax](https://github.com/Tesserax-labs/tesserax), on the web, as a browser
extension and as a desktop application: post-quantum accounts for people and AI agents.

- **Accounts**: create an account and its 24-word recovery phrase, import one from a phrase or
  from a keystore file of the command line wallet, back it up, rename, export, remove. Several
  accounts under one wallet password.
- **Networks**: the mainnet, the testnet or a chain of one's own, chosen in the settings, each
  with its node and explorer.
- **Send and receive** TESS, with the exact network fee before signing, a QR code of the
  address, and the history of the account.
- **AI agents**: give an agent key a budget per period, a limit per call, an expiry, allowed
  calls and recipients; change or revoke it. Spend the budgets you received. Register your own
  agent in the registry, manage its profile, pause it, confirm the agents you own, discover
  agents by capability, pay and rate them.
- **Private balance**: move TESS in and out of the shielded pool, and send privately to shielded
  addresses, with proofs generated in the browser.
- **Contracts**: deploy Solidity contracts compiled for PolkaVM, add deployed ones from their
  address and ABI, read them, call them through the review of every transaction, and follow
  their events.
- **Market**: buy TESS from offers paid in BTC, or in ETH, USDC or USDT on Ethereum, Base or Arbitrum, by
  atomic swaps. The browser wallet locks the payment: the EVM wallet (MetaMask, Rabby or any
  EIP-1193 wallet) or the Bitcoin one (the Bitcoin account of MetaMask, or a wallet of the Bitcoin
  wallet standard, such as Xverse or Unisat). The wallet claims the TESS without fee as soon as
  the maker fills it, and takes the payment back if the maker never does, a payment in BTC with a
  key of the account. Sell TESS: offer them, and run the maker, which fills
  the offers while the wallet is open and lists the payments to collect.
- **Payment channels**: open, top up, close and finalize channels; sign vouchers by hand; claim
  vouchers and close channels as the payee.
- **Task market**: create tasks with the reward in escrow, an arbiter and a worker bond; accept,
  deliver, approve, dispute, resolve and finalize them.

Every operation can be paid from an owner's budget when the account holds a delegation, as the
`--owner` option of the command line wallet does.

## Security

- Keys are generated, encrypted and used in the browser. Nothing secret leaves it: the node
  receives signed transactions only.
- Accounts are stored in IndexedDB as keystore files of the command line wallet: Argon2id
  (64 MiB, 3 passes) and ChaCha20-Poly1305, bound to the address. A file exported from the
  wallet opens with `tesserax-wallet`, and the other way round.
- Once unlocked, the password and the keys stay in memory only, never in storage. The wallet
  locks on demand, on reload, and after some minutes without activity. The settings can ask for
  the password before every transaction.
- Every transaction is shown before signing, with its exact fee: the wallet signs it and asks
  the node for its fee without submitting it.
- Signatures are ML-DSA-87 (FIPS 204), on Tesserax as on the command line wallet.
- The production build carries a strict content security policy: scripts, styles, fonts and
  workers from the wallet itself only, no inline code, no external resource, no framing.
  `vercel.json` adds the same policy as a header, with HSTS, `X-Frame-Options` and a
  cross-origin opener policy.
- Dependencies are pinned. Cryptography comes from the audited `@noble` libraries and the
  Tesserax SDK.

## Browser extension

The same wallet, in the toolbar of Chromium browsers (Chrome, Brave, Edge, Arc) and Firefox,
with a provider for web applications: `window.tesserax`.

```bash
npm run build:extension   # dist-extension/chrome, dist-extension/firefox and their zips
```

- Chrome: `chrome://extensions`, enable the developer mode, Load unpacked, `dist-extension/chrome`.
- Firefox: `about:debugging`, This Firefox, Load Temporary Add-on, `dist-extension/firefox/manifest.json`.

What the extension adds:

- **Popup** of 360 by 600 pixels, and the full wallet in a tab. Creating or importing a wallet
  opens a tab: the popup closes at the first click elsewhere.
- **Session**: the popup closes often, so once unlocked the wallet password and the secrets used
  stay in the session storage of the extension, in memory, readable only by its own pages and
  background, never by web pages or content scripts, and cleared when the browser quits. The
  background locks the wallet after the inactivity set in the settings; locking in one page
  locks them all.
- **Connected sites**: a site sees nothing until the user connects it, then only the accounts
  chosen. Settings list the sites and disconnect them.
- **Approval window** for every signature a site asks for: its origin, what will be signed and,
  for transactions, the same review with the exact fee as in the wallet.
- Permissions: `storage` and `alarms`. The content script runs on HTTPS pages, and on
  `localhost` for development, to provide `window.tesserax`; it carries messages only.

### Provider API

```ts
const [account] = await window.tesserax.request({ method: "tesserax_requestAccounts" });
const { txHash, blockNumber } = await window.tesserax.request({
  method: "tesserax_transfer",
  params: { from: account.address, to: "te…", amount: "1.5" },
});
window.tesserax.on("accountsChanged", (accounts) => {});
```

Amounts are decimal strings of TESS. Transactions resolve once a block includes them, with
`txHash`, `blockHash` and `blockNumber`. `owner` makes the account pay through the delegation it
holds from that owner, as `--owner` in the command line wallet.

| Method | Parameters | Result |
|---|---|---|
| `tesserax_requestAccounts` | | Connected accounts `{ address, name }[]`, after the user's approval the first time |
| `tesserax_accounts` | | Connected accounts, `[]` if none |
| `tesserax_disconnect` | | `null` |
| `tesserax_transfer` | `from`, `to`, `amount`, `owner?` | Inclusion |
| `tesserax_payAgent` | `from`, `agent`, `amount`, `owner?` | Inclusion |
| `tesserax_openChannel` | `from`, `payee`, `deposit`, `owner?` | Inclusion and `channel`, the id |
| `tesserax_signVoucher` | `from`, `channel`, `amount` (total owed) | `{ voucher }`, the value of a `Tesserax-Voucher` header |
| `tesserax_signMessage` | `from`, `message` (text, 4096 characters at most) | `{ address, publicKey, signature }`, hexadecimal |

A message is signed with ML-DSA-87 over its UTF-8 bytes in the context `tesserax-message`, so a
message signature is never valid as a transaction or a voucher. A server checks it with the SDK:
`verify(publicKey, message, signature, new TextEncoder().encode("tesserax-message"))`, and that
the address is the one of the public key.

Errors carry a `code`: 4001 rejected by the user, 4100 site or account not connected, 4200
unknown method, -32602 invalid parameters, -32002 another request of the site waits for
approval.

## Desktop application

The same wallet in a window of its own, for macOS, Windows and Linux, built with
[Tauri](https://tauri.app): the system web view shows the pages of the wallet, a small Rust
program holds the window.

```bash
npm run desktop          # development, with the pages served on http://localhost:5175
npm run build:desktop    # installers in src-tauri/target/release/bundle
```

It needs Rust, and on Linux the WebKitGTK libraries (`libwebkit2gtk-4.1-dev`). Pushing a tag
`v*` builds the installers of every system in GitHub Actions and attaches them to a draft
release.

- Keys stay in the pages, as in the browser: encrypted in the storage of the web view, in memory
  once unlocked, gone when the window closes or locks. The Rust side never sees them.
- The window shows the wallet only: it cannot navigate elsewhere, and links, such as to the
  explorer, open in the browser of the system.
- Keystore files are saved where the user chooses, readable by their owner only, as the command
  line wallet writes them.
- The same strict content security policy as on the web, set by Tauri; the pages can only open
  links in the browser and save keystore files, through the native side.
- One instance at a time; the window remembers its size and position.

## Configuration

Copy `.env.example` to `.env`.

The wallet knows three networks: the **mainnet**, offered once its genesis is known, the
**testnet** and **development**, a chain of one's own. Users choose one in the settings, and
for each a node and an explorer. A node whose genesis hash is not that of the network is
refused, and the private balance of an account is stored per chain. The public endpoints of the
mainnet and the testnet are built in, in `src/lib/networks.ts`.

| Variable | Meaning |
|---|---|
| `VITE_NETWORK` | Network the wallet opens on: Mainnet, Testnet or Development. |
| `VITE_NODE_URL` | Node of that network, `wss://` in production. |
| `VITE_EXPLORER_URL` | Explorer, for links to blocks, transactions and accounts. |
| `VITE_FAUCET_URL` | Optional: faucet of a testnet, for the Get test TESS button. |
| `VITE_EXPLORER_SUPABASE_URL`, `VITE_EXPLORER_SUPABASE_KEY` | Optional: the Supabase project of the explorer and its anon key, read-only, for the transaction history and a fast synchronization of the private balance. Without them, the history links to the explorer. |
| `VITE_GENESIS` | Genesis hash the node must have. |
| `VITE_ESPLORA_URL` | Optional: Esplora API of the Bitcoin network of the market (Bitcoin for the mainnet, testnet4 otherwise), instead of the one of mempool.space. |
| `VITE_DEVELOPMENT_BITCOIN_NETWORK` | Development only: `regtest`, a Bitcoin node of one's own, with `VITE_ESPLORA_URL` (`swaps/bitcoin/esplora-regtest.mjs` of the chain). |
| `VITE_EVM_LOCAL_URL` | Development only: one local EVM chain, such as anvil with the swap contract deployed, standing for Ethereum, Base and Arbitrum in the market. |

These variables apply to the network the wallet opens on. Those of another network take its
name as prefix: `VITE_TESTNET_EXPLORER_SUPABASE_URL`, `VITE_MAINNET_NODE_URL`,
`VITE_MAINNET_GENESIS`, and so on.

## Development

Node.js 22 or later.

```bash
npm install
npm run dev       # http://localhost:5174
npm test          # keystore compatibility with the command line wallet, extension background
npm run build     # type check and production build in dist/
npm run preview   # serve the production build, with its security policy
```

The wallet uses the TypeScript SDK of Tesserax from `vendor/`, built from the `sdk-ts`
directory of the Tesserax repository with `npm pack`.

## Deployment

`dist/` is a static site. On Vercel, import the repository, keep the Vite preset and set the
variables above; `vercel.json` serves every route from `index.html` and sets the security
headers. Elsewhere, serve `dist/` with the same headers and the same rewrite.

## License

Apache-2.0.
