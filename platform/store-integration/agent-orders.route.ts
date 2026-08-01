// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE HANDLER — copy this into your PrintSmith store repo.
//
// Location (Next.js App Router):  app/api/agent/orders/route.ts
//
// It lets the Vendable agent create a real order in your store AFTER Prava has
// already settled the payment (agent-to-agent, headless). Your store does NOT take
// a second payment here — the money moved on the Prava rail; this just records the
// order so it appears in your admin.
//
// Wire-up on the Vendable side:
//   STORE_ORDER_URL=https://theprintsmithstore.com/api/agent/orders
//   STORE_ORDER_SECRET=<a long random secret>          (same value both sides)
//
// SECURITY (do not skip):
//   1. Require the shared secret via `Authorization: Bearer <secret>` and compare
//      in constant time. Reject everything else with 401.
//   2. NEVER trust the amount from the request. Re-price every line item from your
//      own product table on the server. If the client total disagrees, reject.
//   3. Idempotency: the same `reference` must return the existing order, never a
//      duplicate (the agent may retry).
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
// import { db } from '@/lib/db'; // TODO: your data layer (Prisma, Drizzle, etc.)

function bearerOk(req: NextRequest): boolean {
  const secret = process.env.AGENT_ORDER_SECRET ?? '';
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!secret || !token || token.length !== secret.length) return false;
  // constant-time compare to avoid timing attacks
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

interface AgentOrderBody {
  reference?: string;
  source?: string;
  buyer?: { id?: string; email?: string; name?: string };
  items?: { sku: string; title: string; quantity: number; unit_price: number; url?: string }[];
  amount?: number;
  currency?: string;
  payment?: {
    rail: string;
    status: string;
    transaction_id?: string;
    mandate_id?: string;
    amount?: number;
    currency?: string;
  };
}

export async function POST(req: NextRequest) {
  if (!bearerOk(req)) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'bad secret' } }, { status: 401 });
  }

  let body: AgentOrderBody;
  try {
    body = (await req.json()) as AgentOrderBody;
  } catch {
    return NextResponse.json({ error: { code: 'BAD_JSON', message: 'invalid JSON' } }, { status: 400 });
  }

  const items = body.items ?? [];
  if (!items.length || items.some((i) => !i.sku || !(i.quantity > 0))) {
    return NextResponse.json({ error: { code: 'BAD_ITEMS', message: 'items[].sku and quantity are required' } }, { status: 400 });
  }
  if (body.payment?.status !== 'settled') {
    return NextResponse.json({ error: { code: 'NOT_PAID', message: 'payment.status must be settled' } }, { status: 400 });
  }

  const reference = body.reference || body.payment?.transaction_id;
  if (!reference) {
    return NextResponse.json({ error: { code: 'NO_REFERENCE', message: 'reference (idempotency key) is required' } }, { status: 400 });
  }

  // ── 1. Idempotency: return the existing order if we've seen this reference ──
  // const existing = await db.order.findUnique({ where: { agentReference: reference } });
  // if (existing) {
  //   return NextResponse.json({ orderId: existing.id, orderNumber: existing.number, status: existing.status });
  // }

  // ── 2. Re-price on the server — never trust body.amount ──
  // let total = 0;
  // const lines = [];
  // for (const i of items) {
  //   const product = await db.product.findUnique({ where: { slug: i.sku } }); // sku == product slug
  //   if (!product) {
  //     return NextResponse.json({ error: { code: 'UNKNOWN_SKU', message: `no product ${i.sku}` } }, { status: 400 });
  //   }
  //   total += product.price * i.quantity;
  //   lines.push({ productId: product.id, quantity: i.quantity, unitPrice: product.price });
  // }

  // ── 3. Create the order (adapt to your schema) ──
  // const order = await db.order.create({
  //   data: {
  //     number: `PS${Date.now().toString().slice(-10)}`,
  //     status: 'confirmed',
  //     customerName: body.buyer?.name ?? 'Vendable Agent',
  //     customerEmail: body.buyer?.email ?? 'agent@vendable.dev',
  //     currency: body.currency ?? 'INR',
  //     total, // computed above, not from the client
  //     paymentMethod: 'Prava (agent)',
  //     paymentRef: body.payment?.transaction_id,
  //     agentReference: reference, // unique — enforces idempotency
  //     items: { create: lines },
  //   },
  // });
  // return NextResponse.json({ orderId: order.id, orderNumber: order.number, status: order.status });

  // Placeholder response until you wire the DB above:
  return NextResponse.json(
    {
      orderId: `stub_${reference}`,
      orderNumber: `PS${Date.now().toString().slice(-10)}`,
      status: 'confirmed',
      note: 'Replace this stub with the DB writes above.',
    },
    { status: 201 },
  );
}
