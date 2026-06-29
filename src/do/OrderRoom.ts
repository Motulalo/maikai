import type { Env } from '../index';

// One instance per active order. Owns the offer loop and live courier location,
// so high-churn GPS never hits Postgres on the hot path — only milestones persist.
export class OrderRoom {
  state: DurableObjectState;
  env: Env;
  sockets: Set<WebSocket> = new Set();
  orderId = '';

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request) {
    const url = new URL(req.url);

    // Customer / courier subscribe for live updates.
    if (url.pathname.endsWith('/ws')) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.add(server);
      server.addEventListener('message', (e) => this.onMessage(server, e));
      server.addEventListener('close', () => this.sockets.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    // Dispatch kickoff (called from the queue consumer after order.confirmed).
    if (url.pathname.endsWith('/dispatch')) {
      const { orderId } = await req.json<{ orderId: string }>();
      this.orderId = orderId;
      await this.runOfferLoop();
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  onMessage(ws: WebSocket, e: MessageEvent) {
    const msg = JSON.parse(e.data as string);
    if (msg.type === 'location') {
      // courier GPS → fan out to all subscribers; throttle persistence (e.g. every 10s)
      this.broadcast({ type: 'courier_location', lat: msg.lat, lng: msg.lng, heading: msg.heading });
    }
  }

  // Rank nearby online couriers by H3 ring + score, offer with a timeout cascade.
  async runOfferLoop() {
    // 1) resolve store H3 cell + k-ring
    // 2) query couriers where online and h3 in ring, order by distance/score
    // 3) create dispatch_offers row, push offer over that courier's socket
    // 4) wait for accept; on timeout, expire and offer the next candidate
    // TODO: implement against couriers + dispatch_offers
    this.broadcast({ type: 'dispatch_started', orderId: this.orderId });
  }

  broadcast(obj: unknown) {
    const data = JSON.stringify(obj);
    for (const ws of this.sockets) { try { ws.send(data); } catch { this.sockets.delete(ws); } }
  }
}
