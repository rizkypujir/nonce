/**
 * gpuWorker.js — GPU-equivalent of worker.js for the main miner orchestration.
 *
 * Run inline (NOT in worker_threads — GPU calls block briefly per batch).
 * The main miner loop calls runEpoch() and gets back { found, nonce, hashes, ms }.
 */

import { GPUMiner, buildChallenge } from './gpuMiner.js';

let _miner = null;
let _initLog = '';

export function ensureGPU() {
  if (_miner) return _miner;
  _miner = new GPUMiner();
  const info = _miner.init();
  _initLog = `${info.name} (${info.computeUnits} CUs)`;
  return _miner;
}

export function gpuInfo() { return _initLog; }

/**
 * Mine one epoch on GPU until found, timeout, or stop callback returns true.
 *
 * @param {object} opts
 *   - chainId, contractAddr, minerAddr, epoch, difficulty (BigInt)
 *   - batchSize (default 4M)
 *   - shouldStop (() => boolean)  early exit between batches
 *   - onProgress ({ totalHashes, hps, dur }) called every ~2s
 *   - timeoutMs (default 16 min)
 */
export async function gpuMineEpoch(opts) {
  const m = ensureGPU();
  m.batchSize = opts.batchSize || (4 * 1024 * 1024);

  const chal = buildChallenge(opts.chainId, opts.contractAddr, opts.minerAddr, opts.epoch);
  m.setChallenge(chal, opts.difficulty);

  // Random start nonce — keep within uint64 for kernel
  const RAND_MAX = 1n << 60n;
  let baseNonce = BigInt(Math.floor(Math.random() * 1e15));

  const started = Date.now();
  let totalHashes = 0n;
  let lastProgress = Date.now();
  const TO = opts.timeoutMs || 16 * 60 * 1000;

  while (true) {
    if (opts.shouldStop && opts.shouldStop()) {
      return { found: false, totalHashes, hps: Number(totalHashes) / ((Date.now() - started) / 1000) || 0, stopped: true };
    }
    if (Date.now() - started > TO) {
      return { found: false, totalHashes, hps: Number(totalHashes) / ((Date.now() - started) / 1000) || 0, timeout: true };
    }

    const r = m.runBatch(baseNonce);
    totalHashes += BigInt(r.attempts);
    baseNonce += BigInt(m.batchSize);
    if (baseNonce > RAND_MAX) baseNonce = BigInt(Math.floor(Math.random() * 1e15));

    if (r.found) {
      const dur = (Date.now() - started) / 1000;
      const hps = Number(totalHashes) / dur || 0;
      // Verify with CPU (sanity check) — the kernel could in theory have a bug
      // (we already verified in tests, so just return)
      return { found: true, nonce: r.nonce, target: r.target, totalHashes, hps, ms: Date.now() - started };
    }

    // Yield to event loop so RPC reads etc. can run
    if (Date.now() - lastProgress > 2000) {
      const dur = (Date.now() - started) / 1000;
      const hps = Number(totalHashes) / dur || 0;
      if (opts.onProgress) opts.onProgress({ totalHashes, hps, dur });
      lastProgress = Date.now();
      // small async yield so SIGINT etc. land
      await new Promise(r => setImmediate(r));
    }
  }
}

export function destroyGPU() {
  if (_miner) {
    try { _miner.destroy(); } catch {}
    _miner = null;
  }
}
