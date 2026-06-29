import { Hono } from 'hono';
import type { Env } from '../index';
import { serviceClient } from '../lib/supabase';

// Inbound webhooks. Mounted at /hooks — NOT behind user auth.
// Security comes from signature verification on every request.
const payments = new Hono<{ Bindings: Env }>();

// --- Doku payment result ---
payments.post('/doku/payment', async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header('Signature') || '';
  const ok = await verifyHmac(raw, sig, c.env.DOKU_WEBHOOK_SECRET);
  const db = serviceClient(c.env);

  await db.from('payment_events').insert({ source: 'doku', type: 'payment', payload: JSON.parse(raw), sig_verified: ok });
  if (!ok) return c.json({ error: 'bad signature' }, 401);

  const evt = JSON.parse(raw); // { orderId, status, token, amountCents, dokuRef }
  if (evt.status === 'paid') {
    await db.from('payments').insert({
      order_id: evt.orderId, doku_ref: evt.dokuRef, token: evt.token,
      amount_cents: evt.amountCents, status: 'paid',
    });
    // double-entry ledger: customer pays -> platform clearing
    await db.from('ledger_entries').insert([
      { account: 'clearing:doku',   direction: 'debit',  amount_cents: evt.amountCents, ref_type: 'order', ref_id: evt.orderId },
      { account: `order:${evt.orderId}`, direction: 'credit', amount_cents: evt.amountCents, ref_type: 'order', ref_id: evt.orderId },
    ]);
    await db.from('orders').update({ pay_status: 'paid', status: 'confirmed' }).eq('id', evt.orderId);
    await db.from('order_events').insert({ order_id: evt.orderId, type: 'paid', actor: 'doku' });
    await c.env.JOBS.send({ kind: 'dispatch', orderId: evt.orderId });
    await c.env.JOBS.send({ kind: 'notify', orderId: evt.orderId, to: 'merchant' });
  }
  return c.json({ ok: true });
});

// --- Doku chargeback / dispute ---
payments.post('/doku/chargeback', async (c) => {
  const raw = await c.req.text();
  const ok = await verifyHmac(raw, c.req.header('Signature') || '', c.env.DOKU_WEBHOOK_SECRET);
  const db = serviceClient(c.env);
  await db.from('payment_events').insert({ source: 'doku', type: 'chargeback', payload: JSON.parse(raw), sig_verified: ok });
  if (!ok) return c.json({ error: 'bad signature' }, 401);
  const e = JSON.parse(raw);
  await db.from('chargebacks').insert({ order_id: e.orderId, reason: e.reason, amount_cents: e.amountCents, deadline: e.deadline });
  return c.json({ ok: true });
});

// --- BSP daily settlement file ---
payments.post('/bsp/settlement', async (c) => {
  const raw = await c.req.text();
  const ok = await verifyHmac(raw, c.req.header('Signature') || '', c.env.BSP_SETTLEMENT_SECRET);
  if (!ok) return c.json({ error: 'bad signature' }, 401);
  const db = serviceClient(c.env);
  const batch = JSON.parse(raw); // { batchId, lines:[{orderId, gross, fees, net}] }
  await db.from('settlements').insert({
    bsp_batch_id: batch.batchId,
    gross_cents: batch.lines.reduce((s: number, l: any) => s + l.gross, 0),
    fees_cents:  batch.lines.reduce((s: number, l: any) => s + l.fees, 0),
    net_cents:   batch.lines.reduce((s: number, l: any) => s + l.net, 0),
  });
  // reconcile each line against payments; flag mismatches for the operator queue
  await c.env.JOBS.send({ kind: 'reconcile', batchId: batch.batchId });
  return c.json({ ok: true });
});

// HMAC-SHA256 compare (constant-time) — replace with Doku's exact scheme.
async function verifyHmac(body: string, sig: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(hex, sig);
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export default payments;
