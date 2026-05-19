/**
 * rpc.js — RPC failover with viem
 */

import { createPublicClient, createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { config } from './config.js';

class FailoverPool {
  constructor(urls) {
    this.urls = urls.filter(Boolean);
    this.idx  = 0;
    this.publics = this.urls.map(u => createPublicClient({
      chain: base,
      transport: http(u, { batch: false, timeout: 15000 }),
    }));
  }

  current()    { return this.publics[this.idx]; }
  currentUrl() { return this.urls[this.idx]; }
  rotate()     { this.idx = (this.idx + 1) % this.publics.length; }

  async call(method, ...args) {
    let lastErr;
    for (let i = 0; i < this.publics.length * 2; i++) {
      const p = this.current();
      try {
        const fn = p[method];
        if (typeof fn !== 'function') throw new Error(`no method ${method}`);
        return await fn.apply(p, args);
      } catch (e) {
        lastErr = e;
        const msg = e.message || '';
        if (/invalid|reverted|nonce too low|already known/i.test(msg)) throw e;
        this.rotate();
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
      }
    }
    throw lastErr;
  }
}

export const rpcPool = new FailoverPool(config.RPC_URLS);

export function getWalletClient(account) {
  return createWalletClient({
    account,
    chain: base,
    transport: http(rpcPool.currentUrl(), { batch: false, timeout: 15000 }),
  });
}
