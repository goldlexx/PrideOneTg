// Замена модуля "cloudflare:workers" для запуска в Node.js.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
