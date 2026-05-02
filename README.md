# The Hat Gauntlet

The collaborative defend-the-hat game for the $WIF2 community. The hat stays on. 2.

## Features

- **Real-time game** — meter drains, taps add stability, hazards drop the meter randomly
- **Live community chat** — alongside the game, with profanity filter and rate limit
- **Phantom wallet integration** — verifies $WIF2 holders, gives them 4× boost + HOLDER badge
- **Mobile deep-link** — tapping CONNECT PHANTOM on mobile Safari redirects through Phantom's in-app browser
- **3 badge types** — Daily Top 3, Hazard Hero, Survivor (off-chain in KV)
- **Public badge gallery** at `/badges` — look up anyone's badges by name
- **Admin moderator panel** at `/admin` — password-gated, hide/delete chat, ban names/IPs, emergency game controls
- **Burn vault** — every tap fuels an on-chain burn. Auto-accumulating pool, manual admin trigger, full transparency on `/burns`
- **1.5s polling** — feels real-time, no SSE complexity

## Stack

- Frontend: static HTML/CSS/JS, four pages (`index.html`, `admin.html`, `badges.html`, `burns.html`)
- Backend: Vercel Functions on Node.js runtime (`/api/*`)
- State: Vercel KV (Redis-backed)
- On-chain: Solana web3.js + SPL Token, multi-RPC fallback
- Holder verification: Solana RPC `getTokenAccountsByOwner` with 10-min cache, 3-endpoint fallback
- Realtime: polling at 1.5s with paused-when-tab-hidden + new-data dedup

## API routes

Public:
- `GET /api/state` — current meter, leaderboards, recent events, burn pool snapshot
- `POST /api/tap` — register a tap (rate-limited per IP+name; returns earned badges + burn pool delta)
- `GET/POST /api/chat` — recent messages / send a message
- `POST /api/verify-holder` — check $WIF2 balance for a wallet
- `GET /api/badges?name=X&holder=Y` — list a user's earned badges
- `GET /api/burns` — public burn pool + history

Admin (require `Authorization: Bearer <token>`):
- `POST /api/admin/auth` — login with password, returns 12h session token
- `GET/POST /api/admin/messages` — list/hide/unhide/delete messages
- `GET/POST /api/admin/ban` — list/add/remove name + IP bans
- `POST /api/admin/reset` — set_meter / reset_state / clear_lb / clear_chat
- `POST /api/admin/burn` — execute on-chain burn (Node.js runtime, signs with VAULT_PRIVATE_KEY)

## Required env vars

| Variable | Required? | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | Yes (for admin) | Login password for `/admin` |
| `ADMIN_SECRET` | Optional | HMAC secret for session tokens (defaults to ADMIN_PASSWORD) |
| `VAULT_PRIVATE_KEY` | Yes (for burns) | Base58 private key of the vault wallet |
| `VAULT_PUBLIC_ADDRESS` | Optional | Public address shown on `/burns` page |
| KV_* | Yes (auto-set) | Vercel KV connection string, set automatically when KV is connected |

## Deploy

See `HOW-TO-DEPLOY.txt`. Three things to know:

1. Set `ADMIN_PASSWORD` and (optionally) the burn vault env vars
2. Provision Vercel KV from Storage tab → Connect Project
3. Redeploy once after KV connection so env vars take effect

The dapp works without `VAULT_PRIVATE_KEY` — the burn pool counter still accumulates and the `/burns` page still works. Only the admin "Execute Burn" button is disabled until you add it.

## Game balance constants (`lib/kv.js`)

| Constant | Default | What it does |
|---|---|---|
| `TAP_BASE_AMT` | 0.5% | per tap (non-holder) |
| `TAP_HOLDER_AMT` | 2.0% | per tap (holder, 4×) |
| `TAP_COOLDOWN_MS` | 60000 | seconds between taps |
| `DRAIN_PER_MIN` | 1.0% | per-minute meter drain |
| `HAZARD_MIN_INTERVAL_MS` | 5min | minimum between hazards |
| `HAZARD_MAX_INTERVAL_MS` | 15min | maximum between hazards |
| `FALL_RESET_DELAY_MS` | 60000 | mourning period after fall |

## Burn constants (`lib/burn.js`)

| Constant | Default | What it does |
|---|---|---|
| `BURN_PER_TAP_ANON` | 0.020 | tokens contributed per non-holder tap |
| `BURN_PER_TAP_HOLDER` | 0.080 | tokens per holder tap |
| `BURN_THRESHOLD` | 10000 | pool size required before burn can fire |
| `TOKEN_DECIMALS` | 6 | $WIF2 decimal places (verify before deploy) |

## Free tier limits

Vercel Hobby (free tier as of 2026): 1M function invocations/month, 4 hours Active CPU/month, 100GB bandwidth/month, 1 developer seat. Hobby is restricted to non-commercial use — for community/meme-coin projects this is a grey area, so plan to upgrade to Pro ($20/mo) before scaling.

Vercel KV Hobby: 30k requests/day.

A user does ~2 polls per second on the page. 1M invocations covers about 138 user-hours/month before hitting limits — fine for a small community, will require Pro at scale. Pro tier bumps function invocations to ~10M and includes $20/mo of usage credit.
