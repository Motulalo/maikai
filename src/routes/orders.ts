import { Hono } from 'hono';
import type { Env } from '../index';
import { userClient, serviceClient } from '../lib/supabase';

const orders = new Hono<{ Bindings: Env }>();

// POST /api/orders — create order, price server-side, open payment.
// Idempotency-Key header REQUIRED to make retries safe.
orders.post('/', async (c) => {
  const idem = c.req.header('Idempotency-Key');
  if (!idem) return c.json({ error: 'Idempotency-Key required' }, 400);
  const body = await c.req.json(); // { merchantId, items:[{itemId, qty, modifiers}], fulfillment, payMethod, tipCents }
  const db = serviceClient(c.env);

  // 1) re-price from the DB — never trust client prices
  const priced = await priceCart(db, body); // -> { subtotal, fee, service, tax, total, lines }

  // 2) insert order (idempotency_key unique → dup retry returns existing)
  const { data: order, error } = await db.from('orders').insert({
    customer_id: c.get('userId'),
    merchant_id: body.merchantId,
    fulfillment: body.fulfillment,
    pay_method: body.payMethod,
    subtotal_cents: priced.subtotal, fee_cents: priced.fee, service_cents: priced.service,
    tax_cents: priced.tax, tip_cents: body.tipCents ?? 0, total_cents: priced.total,
    idempotency_key: idem,
  }).select().single();
  if (error) return c.json({ error: error.message }, 409);

  await db.from('order_items').insert(priced.lines.map((l: any) => ({ order_id: order.id, ...l })));
  await db.from('order_events').insert({ order_id: order.id, type: 'created', actor: 'customer' });

  // 3) COD → confirm now & dispatch; card → hand back a Doku HPP URL
  if (body.payMethod === 'cod') {
    await confirmOrder(c.env, order.id);
    return c.json({ orderId: order.id, status: 'confirmed' });
  }
  const hppUrl = await createDokuSession(c.env, order); // see routes/payments
  return c.json({ orderId: order.id, hppUrl });
});

// GET /api/orders/:id — RLS limits visibility to the customer/merchant/courier on it.
orders.get('/:id', async (c) => {
  const db = userClient(c.env, c.req.header('Authorization')!.slice(7));
  const { data, error } = await db.from('orders').select('*, order_items(*)').eq('id', c.req.param('id')).single();
  if (error) return c.json({ error: error.message }, 404);
  return c.json(data);
});

// --- helpers (implement against your catalog) ---
async function priceCart(db: any, body: any): Promise<any> {
  // load items + modifier prices from DB, sum, apply fee/service/tax. Throw on any unknown id.
  throw new Error('TODO: implement server-side pricing');
}
async function confirmOrder(env: Env, orderId: string) {
  // flip status→confirmed, post ledger, wake the OrderRoom DO to start dispatch
  throw new Error('TODO');
}
async function createDokuSession(env: Env, order: any): Promise<string> {
  throw new Error('TODO: see routes/payments');
}

export default orders;
