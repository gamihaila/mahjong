// Minimal stand-in for the "cloudflare:workers" module so the
// room server (which extends PartyServer's Server, which extends
// DurableObject) can be imported and exercised in plain Node.
// Only the surface the class hierarchy touches at construction
// time is provided; storage and connections are stubbed by the
// test harness itself.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export const env = {};
