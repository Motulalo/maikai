-- maikai — Postgres schema + Row-Level Security
-- Target: Supabase Postgres. Run as a migration. Review every policy before production.
-- Convention: every tenant table carries an owner column; RLS is deny-by-default.

-- ============================================================
-- EXTENSIONS & ENUMS
-- ============================================================
create extension if not exists "uuid-ossp";

create type user_role        as enum ('customer','courier','merchant','operator');
create type store_kind        as enum ('merchant','provider');
create type order_status      as enum ('pending','confirmed','preparing','ready','en_route','delivered','cancelled');
create type fulfillment_type  as enum ('delivery','pickup');
create type pay_method        as enum ('card','cod');
create type pay_status        as enum ('unpaid','authorized','paid','refunded','failed');
create type delivery_status   as enum ('offered','accepted','picked_up','delivered','failed');
create type offer_state       as enum ('pending','accepted','declined','expired');
create type promo_type        as enum ('percent','amount','free_delivery','bogo','first_order','happy_hour','sponsored');
create type promo_funding     as enum ('merchant','cofunded','ad');
create type promo_status      as enum ('active','paused','ended');
create type kyc_check_state   as enum ('pending','ok','warn','fail');
create type kyc_decision      as enum ('pending','approved','rejected');
create type risk_severity     as enum ('low','med','high');
create type ledger_direction  as enum ('debit','credit');

-- ============================================================
-- HELPER: current role + entity ids from JWT claims
-- ============================================================
create or replace function auth_role() returns user_role language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role')::user_role, 'customer');
$$;
create or replace function is_operator() returns boolean language sql stable as $$
  select auth_role() = 'operator';
$$;

-- ============================================================
-- IDENTITY
-- ============================================================
create table profiles (
  id          uuid primary key references auth.users on delete cascade,
  role        user_role not null default 'customer',
  full_name   text,
  phone       text,
  created_at  timestamptz not null default now()
);
alter table profiles enable row level security;
create policy profiles_self  on profiles for select using (id = auth.uid() or is_operator());
create policy profiles_upd   on profiles for update using (id = auth.uid());

create table merchants (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references profiles(id),
  kind            store_kind not null default 'merchant',
  name            text not null,
  category_id     uuid,
  h3              text,
  commission_pct  numeric(4,1) not null default 18.0,
  rating          numeric(2,1) default 5.0,
  active          boolean not null default false,
  created_at      timestamptz not null default now()
);
alter table merchants enable row level security;
create policy merchants_public  on merchants for select using (active or owner_id = auth.uid() or is_operator());
create policy merchants_owner   on merchants for all    using (owner_id = auth.uid() or is_operator()) with check (owner_id = auth.uid() or is_operator());

create table couriers (
  id          uuid primary key default uuid_generate_v4(),
  profile_id  uuid not null references profiles(id),
  vehicle     text,
  rating      numeric(2,1) default 5.0,
  online      boolean not null default false,
  h3          text,
  active      boolean not null default false
);
alter table couriers enable row level security;
create policy couriers_self on couriers for all using (profile_id = auth.uid() or is_operator()) with check (profile_id = auth.uid() or is_operator());

-- ============================================================
-- CATALOG
-- ============================================================
create table categories (
  id      uuid primary key default uuid_generate_v4(),
  name    text not null,
  slug    text unique not null,
  sort    int not null default 0,
  active  boolean not null default true
);
alter table categories enable row level security;
create policy categories_read  on categories for select using (true);
create policy categories_write on categories for all using (is_operator()) with check (is_operator());

create table menu_items (
  id           uuid primary key default uuid_generate_v4(),
  merchant_id  uuid not null references merchants(id) on delete cascade,
  name         text not null,
  desc_text    text,
  price_cents  int not null,
  photo_key    text,            -- R2 object key
  available    boolean not null default true
);
alter table menu_items enable row level security;
create policy menu_read  on menu_items for select using (available or is_operator()
  or exists (select 1 from merchants m where m.id = merchant_id and m.owner_id = auth.uid()));
create policy menu_write on menu_items for all using (
  exists (select 1 from merchants m where m.id = merchant_id and m.owner_id = auth.uid()) or is_operator());

create table modifier_groups (
  id        uuid primary key default uuid_generate_v4(),
  item_id   uuid not null references menu_items(id) on delete cascade,
  name      text not null,
  group_type text not null,     -- 'single' | 'multi'
  min_sel   int default 0,
  max_sel   int default 1,
  choices   jsonb not null default '[]'
);
alter table modifier_groups enable row level security;
create policy mod_read  on modifier_groups for select using (true);
create policy mod_write on modifier_groups for all using (
  exists (select 1 from menu_items i join merchants m on m.id = i.merchant_id
          where i.id = item_id and m.owner_id = auth.uid()) or is_operator());

-- ============================================================
-- ORDERS & DISPATCH
-- ============================================================
create table orders (
  id            uuid primary key default uuid_generate_v4(),
  customer_id   uuid not null references profiles(id),
  merchant_id   uuid not null references merchants(id),
  status        order_status not null default 'pending',
  fulfillment   fulfillment_type not null default 'delivery',
  subtotal_cents int not null default 0,
  fee_cents      int not null default 0,
  service_cents  int not null default 0,
  tax_cents      int not null default 0,
  tip_cents      int not null default 0,
  total_cents    int not null default 0,
  pay_method     pay_method not null default 'card',
  pay_status     pay_status not null default 'unpaid',
  idempotency_key text unique,
  created_at     timestamptz not null default now()
);
alter table orders enable row level security;
create policy orders_customer on orders for select using (customer_id = auth.uid() or is_operator());
create policy orders_merchant on orders for select using (
  exists (select 1 from merchants m where m.id = merchant_id and m.owner_id = auth.uid()));
create policy orders_courier  on orders for select using (
  exists (select 1 from deliveries d join couriers c on c.id = d.courier_id
          where d.order_id = orders.id and c.profile_id = auth.uid()));
create policy orders_insert   on orders for insert with check (customer_id = auth.uid());
-- NOTE: status/pay_status transitions are service-role only (see Worker), not client UPDATE.

create table order_items (
  id          uuid primary key default uuid_generate_v4(),
  order_id    uuid not null references orders(id) on delete cascade,
  item_id     uuid references menu_items(id),
  name        text not null,
  qty         int not null,
  unit_cents  int not null,
  modifiers   jsonb not null default '[]'
);
alter table order_items enable row level security;
create policy order_items_via_parent on order_items for select using (
  exists (select 1 from orders o where o.id = order_id and
    (o.customer_id = auth.uid() or is_operator()
     or exists (select 1 from merchants m where m.id = o.merchant_id and m.owner_id = auth.uid()))));

create table order_events (
  id        bigint generated always as identity primary key,
  order_id  uuid not null references orders(id) on delete cascade,
  type      text not null,
  actor     text,
  meta      jsonb default '{}',
  at        timestamptz not null default now()
);
alter table order_events enable row level security;
create policy order_events_read on order_events for select using (is_operator()
  or exists (select 1 from orders o where o.id = order_id and o.customer_id = auth.uid()));
-- append-only: no update/delete policy

create table deliveries (
  id          uuid primary key default uuid_generate_v4(),
  order_id    uuid not null references orders(id) on delete cascade,
  courier_id  uuid references couriers(id),
  status      delivery_status not null default 'offered',
  proof_key   text,            -- R2 object key
  pickup_at   timestamptz,
  drop_at     timestamptz
);
alter table deliveries enable row level security;
create policy deliveries_courier on deliveries for all using (
  exists (select 1 from couriers c where c.id = courier_id and c.profile_id = auth.uid()) or is_operator());
create policy deliveries_customer on deliveries for select using (
  exists (select 1 from orders o where o.id = order_id and o.customer_id = auth.uid()));

create table dispatch_offers (
  id           uuid primary key default uuid_generate_v4(),
  order_id     uuid not null references orders(id) on delete cascade,
  courier_id   uuid not null references couriers(id),
  payout_cents int not null,
  state        offer_state not null default 'pending',
  expires_at   timestamptz not null
);
alter table dispatch_offers enable row level security;
create policy offers_courier on dispatch_offers for all using (
  exists (select 1 from couriers c where c.id = courier_id and c.profile_id = auth.uid()) or is_operator());

create table courier_locations (
  courier_id  uuid not null references couriers(id) on delete cascade,
  lat         double precision not null,
  lng         double precision not null,
  h3          text,
  heading     int,
  at          timestamptz not null default now(),
  primary key (courier_id, at)
);
alter table courier_locations enable row level security;
create policy loc_self on courier_locations for all using (
  exists (select 1 from couriers c where c.id = courier_id and c.profile_id = auth.uid()) or is_operator());

-- ============================================================
-- PAYMENTS & LEDGER  (service-role only — clients read derived views)
-- ============================================================
create table payments (
  id          uuid primary key default uuid_generate_v4(),
  order_id    uuid not null references orders(id),
  doku_ref    text,
  token       text,            -- gateway token; NEVER a PAN
  amount_cents int not null,
  status      pay_status not null default 'unpaid',
  created_at  timestamptz not null default now()
);
alter table payments enable row level security;  -- no client policy => service-role only

create table payment_events (
  id            bigint generated always as identity primary key,
  source        text not null,           -- 'doku' | 'bsp'
  type          text not null,
  payload       jsonb not null,
  sig_verified  boolean not null default false,
  received_at   timestamptz not null default now()
);
alter table payment_events enable row level security;

create table settlements (
  id           uuid primary key default uuid_generate_v4(),
  bsp_batch_id text not null,
  gross_cents  int not null,
  fees_cents   int not null,
  net_cents    int not null,
  reconciled   boolean not null default false,
  created_at   timestamptz not null default now()
);
alter table settlements enable row level security;

create table ledger_entries (
  id          bigint generated always as identity primary key,
  account     text not null,            -- e.g. 'merchant:<id>', 'platform:commission', 'courier:<id>'
  direction   ledger_direction not null,
  amount_cents int not null,
  ref_type    text not null,            -- 'order' | 'payout' | 'chargeback' | 'ad' | 'promo'
  ref_id      uuid,
  at          timestamptz not null default now()
);
alter table ledger_entries enable row level security;  -- append-only, service-role only

create table payouts (
  id          uuid primary key default uuid_generate_v4(),
  merchant_id uuid not null references merchants(id),
  period      text not null,
  net_cents   int not null,
  status      text not null default 'pending',  -- pending | sent
  sent_at     timestamptz
);
alter table payouts enable row level security;
create policy payouts_owner on payouts for select using (
  exists (select 1 from merchants m where m.id = merchant_id and m.owner_id = auth.uid()) or is_operator());

create table chargebacks (
  id          uuid primary key default uuid_generate_v4(),
  order_id    uuid not null references orders(id),
  reason      text,
  amount_cents int not null,
  deadline    timestamptz,
  state       text not null default 'open',     -- open | won | lost | accepted
  created_at  timestamptz not null default now()
);
alter table chargebacks enable row level security;
create policy chargebacks_operator on chargebacks for all using (is_operator()) with check (is_operator());

-- ============================================================
-- PROMOTIONS, REVIEWS & RISK
-- ============================================================
create table promotions (
  id          uuid primary key default uuid_generate_v4(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  promo_type  promo_type not null,
  value_num   numeric,
  funding     promo_funding not null default 'merchant',
  budget_cents int not null default 0,
  spent_cents  int not null default 0,
  sponsored   boolean not null default false,
  status      promo_status not null default 'active',
  created_at  timestamptz not null default now()
);
alter table promotions enable row level security;
create policy promos_owner on promotions for all using (
  exists (select 1 from merchants m where m.id = merchant_id and m.owner_id = auth.uid()) or is_operator())
  with check (exists (select 1 from merchants m where m.id = merchant_id and m.owner_id = auth.uid()) or is_operator());
create policy promos_public on promotions for select using (status = 'active');

create table promo_redemptions (
  id            bigint generated always as identity primary key,
  promo_id      uuid not null references promotions(id) on delete cascade,
  order_id      uuid not null references orders(id),
  discount_cents int not null,
  cofund_cents   int not null default 0,
  at            timestamptz not null default now()
);
alter table promo_redemptions enable row level security;
create policy redemptions_read on promo_redemptions for select using (is_operator()
  or exists (select 1 from promotions p join merchants m on m.id = p.merchant_id
             where p.id = promo_id and m.owner_id = auth.uid()));

create table ad_charges (
  id          bigint generated always as identity primary key,
  promo_id    uuid not null references promotions(id) on delete cascade,
  order_id    uuid not null references orders(id),
  amount_cents int not null,
  billed      boolean not null default false,
  at          timestamptz not null default now()
);
alter table ad_charges enable row level security;
create policy ad_charges_operator on ad_charges for select using (is_operator());

create table reviews (
  id          uuid primary key default uuid_generate_v4(),
  order_id    uuid not null references orders(id),
  merchant_id uuid not null references merchants(id),
  author_id   uuid not null references profiles(id),
  stars       int not null check (stars between 1 and 5),
  body        text,
  reply       text,
  replied_at  timestamptz,
  created_at  timestamptz not null default now()
);
alter table reviews enable row level security;
create policy reviews_read   on reviews for select using (true);
create policy reviews_author on reviews for insert with check (author_id = auth.uid());
create policy reviews_reply  on reviews for update using (
  exists (select 1 from merchants m where m.id = merchant_id and m.owner_id = auth.uid()));

create table kyc_applications (
  id            uuid primary key default uuid_generate_v4(),
  subject_id    uuid references profiles(id),
  store_kind    store_kind not null default 'merchant',
  business_name text not null,
  category_id   uuid,
  licence_no    text,
  licence_state kyc_check_state not null default 'pending',
  record_state  kyc_check_state not null default 'pending',
  risk          risk_severity not null default 'med',
  decision      kyc_decision not null default 'pending',
  actor         text,
  created_at    timestamptz not null default now()
);
alter table kyc_applications enable row level security;
create policy kyc_self     on kyc_applications for select using (subject_id = auth.uid() or is_operator());
create policy kyc_operator on kyc_applications for all using (is_operator()) with check (is_operator());

create table risk_signals (
  id          uuid primary key default uuid_generate_v4(),
  kind        text not null,            -- 'promo_abuse' | 'card_testing' | 'geo_anomaly' | 'refund_farming'
  severity    risk_severity not null,
  subject_id  uuid,
  score       numeric,
  state       text not null default 'open',
  meta        jsonb default '{}',
  created_at  timestamptz not null default now()
);
alter table risk_signals enable row level security;
create policy risk_operator on risk_signals for all using (is_operator()) with check (is_operator());

-- ============================================================
-- INDEXES (hot paths)
-- ============================================================
create index on orders (merchant_id, status);
create index on orders (customer_id, created_at desc);
create index on order_items (order_id);
create index on deliveries (courier_id, status);
create index on dispatch_offers (courier_id, state);
create index on menu_items (merchant_id) where available;
create index on promotions (merchant_id, status);
create index on ledger_entries (account, at desc);
create index on kyc_applications (decision) where decision = 'pending';
create index on risk_signals (state) where state = 'open';
