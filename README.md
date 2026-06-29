# maikai — Backend Handoff

Edge-first marketplace backend for the **maikai** delivery platform (customer · courier · merchant · operator).
This package is the bridge between the prototype (`maikai.dc.html`) and a live deployment. It is **scaffold + contracts**, hardened by default — not a turnkey production system. Review every policy and secret before go-live.

## Stack
- **Cloudflare Workers** — API gateway + domain services (Hono router)
- **Cloudflare Durable Objects** — per-order dispatch rooms + courier location (WebSocket)
- **Cloudflare R2** — menu photos, delivery-proof, KYC documents (private, signed URLs)
- **Cloudflare Queues + Cron** — notifications, ledger posting, payout runs
- **Supabase Postgres** — system of record, Row-Level Security, Realtime
- **Supabase Auth** — users + JWT (role claims drive RLS)
- **BSP Tonga / Doku** — hosted payment page (HPP), settlement, disputes
- **Google Maps + Uber H3** — geocoding, routing, ETA, hex bucketing

## Layout
```
handoff/
  README.md              this file
  wrangler.toml          Workers config (DO, R2, Queues, Cron bindings)
  .dev.vars.example      secret names (copy to .dev.vars, never commit real values)
  schema.sql             tables + enums + RLS policies + indexes
  src/
    index.ts             Hono app, JWT auth middleware, route mounting
    lib/auth.ts          Supabase JWT verification + role guards
    lib/supabase.ts      service-role + request-scoped clients
    routes/orders.ts     cart→order, pricing, state machine
    routes/payments.ts   Doku HPP session + webhook handlers
    routes/merchant.ts   orders accept/ready, menu, promos
    routes/operator.ts   KYC, categories, chargebacks, risk
    do/OrderRoom.ts      dispatch + live tracking Durable Object
    jobs/payout-run.ts   nightly settlement → payouts (cron)
```

## Hardening checklist (do before launch)
- [ ] Rotate all provider keys; store in Workers Secrets (`wrangler secret put`)
- [ ] Verify every RLS policy against `tests/rls.spec.ts` (deny-by-default)
- [ ] Confirm money tables (`payments`, `settlements`, `ledger_entries`, `chargebacks`) are **service-role only**
- [ ] Doku webhook signature verification ON; reject unsigned (`payment_events.sig_verified`)
- [ ] Idempotency keys enforced on `POST /orders` and all webhooks
- [ ] R2 buckets private; KYC docs served only via short-TTL signed URLs
- [ ] Turnstile on signup + checkout; WAF rate-limit rules deployed
- [ ] Separate dev / staging / prod Workers + Supabase projects
- [ ] Doku in **sandbox** until BSP go-live sign-off

## Deploy (high level)
1. `supabase db push` with `schema.sql` into a region-pinned project
2. `wrangler secret put` for each name in `.dev.vars.example`
3. `wrangler deploy` (staging env first)
4. Register Doku webhook → `/hooks/doku/payment`, `/hooks/doku/chargeback`
5. Register BSP settlement drop → `/hooks/bsp/settlement`
6. Smoke-test the order → HPP → tracking flow end to end in sandbox

> Endpoints, schema, and RLS mirror `iMai Backend Architecture.dc.html` one-to-one.
