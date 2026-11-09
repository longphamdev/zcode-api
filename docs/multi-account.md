# Multi-Account Guide

## Adding / removing accounts

```bash
zcode-proxy auth login zai --add --label "Work"   # add (or update, deduped by userId)
zcode-proxy auth list                              # id, label, masked user, quota per account
zcode-proxy auth remove <id|label>                 # remove (last account needs --yes)
zcode-proxy auth logout                            # clears the PRIMARY only
```

- `--add` goes through the account store directly (never the single-credential facade).
- Re-login with the same account UPDATES its entry (dedupe key = userId / JWT subject).
- The running proxy hot-reloads the store (~5s sync timer + freshness check before each
  request) — no restart needed after a CLI login/remove.
- Credentials are AES-GCM encrypted (`ZCODE_PROXY_CREDENTIAL_SECRET`), file mode 0600,
  cross-process writes via lockfile.

## Account selection

- **1 account**: pass-through — no inflight cap, no queue, no cooling/exhaust marking on
  429/401/1005. Behavior matches the pre-multi-account proxy exactly.
- **2+ accounts**: round-robin over healthy accounts (skip cooling/exhausted/expired),
  per-account `maxInFlightPerAccount` cap (default 4), short queue (`queueTimeoutMs`,
  default 5s, woken by release) → over-limit requests get 429 + `Retry-After`.
- Optional strategy: `most-remaining-quota` (uses poller data).

## Account states

| State | Meaning | Recovery |
|---|---|---|
| `healthy` | pickable | — |
| `cooling` | 429 rate-limited (Retry-After honored) | auto after deadline |
| `exhausted` | quota gone (biz 1005, arrives as **HTTP 200** + body `{code:1005}`) | poller sees balances > 0, or `quotaExpiresAt`, or half-open probe after 30 min |
| `expired` | upstream rejected the credential (401) — **no programmatic refresh exists** (JWTs carry `iat` only; re-login is interactive) | half-open probe after 10 min (401 re-arms, 2xx heals), or poller success, or a re-login (credential change resets state) |

## Error → action matrix

| Upstream signal | Action |
|---|---|
| 429 + `Retry-After` | cool that account, failover to another (headers not yet sent) |
| 429 without `Retry-After` | cool 30s, failover |
| ≥2 distinct accounts 429 within 30s | GLOBAL rate limit → pool-wide cooldown (Retry-After), no per-account cooling |
| HTTP 200 + `{code:1005}` | mark exhausted (peek ≤2KB, JSON top-level only, never SSE), failover |
| 401 (no highspeed card) | mark expired (unless global-401 guard active), failover; message names the re-login command |
| ≥2 distinct accounts 401 within 30s | GLOBAL auth incident → do not mark expired; suppression lifts after repeated bursts (real per-account death) |
| Timeout/network after body sent | NO retry, NO rotation (upstream may have processed — duplicate risk) |
| 5xx / connect errors | existing proxy retry policy, no rotation |
| Unknown 4xx | logged with status + redacted headers + body preview (evidence for matchers); no rotation |

## Accepted limitations

- **Async jobs do not failover mid-job**: the job runs on a copied credential; if the
  account dies mid-job the job errors — new jobs pick a healthy account.
- **Single-account pass-through**: 429/401/1005 on the only account reach the client
  untouched (legacy behavior).
- **Auto-claim multi-account is out of scope** (ToS risk; deliberately excluded).
- 401 handling is interactive (re-login) — there is no token refresh grant in this
  system's OAuth flows.
