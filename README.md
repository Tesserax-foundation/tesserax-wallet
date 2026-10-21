# Tesserax Wallet

The web wallet of [Tesserax](https://github.com/Wayleyy/tesserax): post-quantum accounts for
people and AI agents.

- **Accounts**: create an account and its 24-word recovery phrase, import one from a phrase or
  from a keystore file of the command line wallet, back it up, rename, export, remove. Several
  accounts under one wallet password.
- **Send and receive** TESS, with the exact network fee before signing, a QR code of the
  address, and the history of the account.
- **AI agents**: give an agent key a budget per period, a limit per call, an expiry, allowed
  calls and recipients; change or revoke it. Spend the budgets you received. Register your own
  agent in the registry, manage its profile, pause it, confirm the agents you own, discover
  agents by capability, pay and rate them.
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

## Configuration

Copy `.env.example` to `.env`:

| Variable | Meaning |
|---|---|
| `VITE_NODE_URL` | Node used by default, `wss://` in production. Users can change it in the settings. |
| `VITE_NETWORK` | Network name shown in the header: Mainnet, Testnet or Development. |
| `VITE_EXPLORER_URL` | Explorer, for links to blocks, transactions and accounts. |
| `VITE_EXPLORER_SUPABASE_URL`, `VITE_EXPLORER_SUPABASE_KEY` | Optional: the Supabase project of the explorer and its anon key, read-only, for the transaction history. Without them, the history links to the explorer. |

## Development

Node.js 22 or later.

```bash
npm install
npm run dev       # http://localhost:5174
npm test          # keystore compatibility with the command line wallet
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
