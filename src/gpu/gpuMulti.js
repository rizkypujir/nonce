/**
 * gpuMulti.js — orchestrate N GPUs in parallel for one challenge.
 *
 * Splits nonce space across all GPUs. First GPU to find wins, others abort.
 */

import { GPUMiner, listAllGPUs, buildChallenge } from './gpuMiner.js';

let _miners = null;       // GPUMiner instances per device
let _initLog = '';

export function ensureMultiGPU(maxGPUs = Infinity) {
  if (_miners) return _miners;
  const all = listAllGPUs();
  const use = all.slice(0, Math.min(all.length, maxGPUs));
  _miners = use.map((d, i) => {
    const m = new GPUMiner(i);
    m.init();
    return m;
  });
  _initLog = `${_miners.length} GPU(s): ${_miners.map(m => m.deviceName).join(', ')}`;
  return _miners;
}

export function multiGpuInfo() { return _initLog; }
export function gpuCount() { return _miners ? _miners.length : 0; }

/**
 * Mine one epoch on ALL GPUs in parallel, with each device searching a different
 * portion of the nonce space. First GPU to find returns; others stop.
 *
 * @param {object} opts (same as gpuMineEpoch + multiBatchSize)
 */
export async function multiGpuMineEpoch(opts) {
  const miners = ensureMultiGPU(opts.maxGPUs);
  const N = miners.length;

  const chal = buildChallenge(opts.chainId, opts.contractAddr, opts.minerAddr, opts.epoch);
  for (const m of miners) {
    m.batchSize = opts.batchSize || (16 * 1024 * 1024);
    m.setChallenge(chal, opts.difficulty);
  }

  const RAND_MAX = 1n << 60n;
  // Each GPU gets a different starting region in nonce space
  const baseNonces = miners.map((_, i) =>
    (BigInt(Math.floor(Math.random() * 1e15)) + BigInt(i) * (1n << 50n)) % RAND_MAX
  );

  const started = Date.now();
  let totalHashes = 0n;
  let lastProgress = Date.now();
  const TO = opts.timeoutMs || 16 * 60 * 1000;

  let foundResult = null;

  // Simple round-robin: each tick, run one batch on each GPU sequentially
  // (kernel launches are async on driver side, finish blocks). But we use
  // separate worker promises for each GPU to overlap host-side work.
  let stop = false;

  async function runOneGPU(idx) {
    const m = miners[idx];
    while (!stop) {
      if (opts.shouldStop && opts.shouldStop()) { stop = true; return; }
      if (Date.now() - started > TO) { stop = true; return; }

      const r = m.runBatch(baseNonces[idx]);
      totalHashes += BigInt(r.attempts);
      baseNonces[idx] += BigInt(m.batchSize);
      if (baseNonces[idx] > RAND_MAX) baseNonces[idx] = BigInt(Math.floor(Math.random() * 1e15));

      if (r.found) {
        foundResult = { found: true, nonce: r.nonce, target: r.target, totalHashes, ms: Date.now() - started, gpuIdx: idx };
        stop = true;
        return;
      }

      // Yield occasionally
      if (Date.now() - lastProgress > 2000) {
        const dur = (Date.now() - started) / 1000;
        const hps = Number(totalHashes) / dur || 0;
        if (opts.onProgress) opts.onProgress({ totalHashes, hps, dur });
        lastProgress = Date.now();
      }
      // tiny yield so all GPU promises can interleave
      await new Promise(r => setImmediate(r));
    }
  }

  // Run all GPUs concurrently
  await Promise.all(miners.map((_, i) => runOneGPU(i)));

  if (foundResult) {
    foundResult.hps = Number(foundResult.totalHashes) / ((Date.now() - started) / 1000) || 0;
    return foundResult;
  }
  const hps = Number(totalHashes) / ((Date.now() - started) / 1000) || 0;
  return { found: false, totalHashes, hps, timeout: Date.now() - started > TO, stopped: stop };
}

export function destroyMultiGPU() {
  if (_miners) {
    for (const m of _miners) {
      try { m.destroy(); } catch {}
    }
    _miners = null;
  }
}
