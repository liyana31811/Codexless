export class LazyCodexAgentExecutor {
  #factory;
  #delegate = null;
  #delegatePromise = null;
  #closed = false;

  constructor({ factory }) {
    if (typeof factory !== "function") throw new Error("LazyCodexAgentExecutor requires a factory");
    this.#factory = factory;
  }

  get running() {
    return this.#delegate?.running === true;
  }

  async open() {
    if (this.#closed) throw new Error("LazyCodexAgentExecutor is closed");
    return { deferred: true, runtimeLane: "existing" };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const delegate = this.#delegate;
    this.#delegate = null;
    this.#delegatePromise = null;
    if (delegate) await delegate.close();
  }

  async listModels(input) { return (await this.#get()).listModels(input); }
  async start(input) { return (await this.#get()).start(input); }
  async show(input) { return (await this.#get()).show(input); }
  async resolvePendingRequest(input) { return (await this.#get()).resolvePendingRequest(input); }
  async rejectPendingRequest(input) { return (await this.#get()).rejectPendingRequest(input); }
  async resolveApproval(input) { return (await this.#get()).resolveApproval(input); }
  async steer(input) { return (await this.#get()).steer(input); }
  async cancel(input) { return (await this.#get()).cancel(input); }
  async send(input) { return (await this.#get()).send(input); }

  async #get() {
    if (this.#closed) throw new Error("LazyCodexAgentExecutor is closed");
    if (this.#delegate) return this.#delegate;
    if (!this.#delegatePromise) {
      this.#delegatePromise = (async () => {
        const delegate = await this.#factory();
        if (!delegate || typeof delegate.open !== "function") {
          throw new Error("LazyCodexAgentExecutor factory returned an invalid executor");
        }
        await delegate.open();
        this.#delegate = delegate;
        return delegate;
      })();
    }
    try {
      return await this.#delegatePromise;
    } finally {
      if (!this.#delegate) this.#delegatePromise = null;
    }
  }
}
