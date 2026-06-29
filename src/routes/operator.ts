import { Hono } from 'hono';
import type { Env } from '../index';
import { userClient, serviceClient } from '../lib/supabase';

// Operator-only. requireRole('operator') guards the mount; RLS enforces again.
const operator = new Hono<{ Bindings: Env }>();
const db = (c: any) => userClient(c.env, c.req.header('Authorization').slice(7));

// KYC queue
operator.get('/kyc', async (c) => {
  const { data } = await db(c).from('kyc_applications').select('*').eq('decision', 'pending').order('created_at');
  return c.json(data ?? []);
});
operator.post('/kyc/:id/approve', async (c) => {
  const svc = serviceClient(c.env);
  const { data: app } = await svc.from('kyc_applications').update({ decision: 'approved', actor: c.get('userId') }).eq('id', c.req.param('id')).select().single();
  if (app?.subject_id) await svc.from('merchants').update({ active: true }).eq('owner_id', app.subject_id);
  return c.json({ ok: true });
});
operator.post('/kyc/:id/reject', async (c) => {
  await serviceClient(c.env).from('kyc_applications').update({ decision: 'rejected', actor: c.get('userId') }).eq('id', c.req.param('id'));
  return c.json({ ok: true });
});

// Categories (power the customer rail)
operator.get('/categories', async (c) => c.json((await db(c).from('categories').select('*').order('sort')).data ?? []));
operator.post('/categories', async (c) => {
  const b = await c.req.json();
  const { data, error } = await db(c).from('categories').insert(b).select().single();
  return error ? c.json({ error: error.message }, 403) : c.json(data);
});
operator.delete('/categories/:id', async (c) => {
  await db(c).from('categories').delete().eq('id', c.req.param('id'));
  return c.json({ ok: true });
});

// Chargebacks
operator.get('/chargebacks', async (c) => c.json((await db(c).from('chargebacks').select('*').eq('state', 'open')).data ?? []));
operator.post('/chargebacks/:id/evidence', async (c) => {
  // attach evidence + submit to Doku; mark in-review
  await db(c).from('chargebacks').update({ state: 'won' }).eq('id', c.req.param('id')); // optimistic; reconcile on webhook
  return c.json({ ok: true });
});

// Risk signals
operator.get('/risk-signals', async (c) => c.json((await db(c).from('risk_signals').select('*').eq('state', 'open')).data ?? []));
operator.post('/risk/:id/block', async (c) => {
  const svc = serviceClient(c.env);
  const { data: sig } = await svc.from('risk_signals').update({ state: 'actioned' }).eq('id', c.req.param('id')).select().single();
  // cascade: disable the subject's auth + cancel their open orders (implement to taste)
  return c.json({ ok: true, subject: sig?.subject_id });
});
operator.post('/risk/:id/dismiss', async (c) => {
  await db(c).from('risk_signals').update({ state: 'dismissed' }).eq('id', c.req.param('id'));
  return c.json({ ok: true });
});

// Create a store/provider application from the operator "+" flow
operator.post('/stores', async (c) => {
  const b = await c.req.json(); // { businessName, storeKind, categoryId, licenceNo }
  const { data, error } = await serviceClient(c.env).from('kyc_applications').insert({
    business_name: b.businessName, store_kind: b.storeKind, category_id: b.categoryId,
    licence_no: b.licenceNo, licence_state: 'pending', record_state: 'pending', risk: 'med',
  }).select().single();
  return error ? c.json({ error: error.message }, 400) : c.json(data);
});

export default operator;
