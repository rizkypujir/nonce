/**
 * cpuThread.js — CPU worker thread for hybrid GPU+CPU mining.
 * Uses native keccak (same as worker.js) but reports to hybrid orchestrator.
 */
import { workerData, parentPort } from 'worker_threads';
import { makeChallengeHasher } from '../hash.js';

const { chainId, contractAddr, minerAddr, epoch, difficulty, startNonce, threadId } = workerData;

const tryNonce   = makeChallengeHasher(chainId, contractAddr, minerAddr, epoch);
const diffBig    = BigInt(difficulty);
let   nonce      = BigInt(startNonce);
const BATCH      = 50000n;
let   attempts   = 0n;
const startTime  = Date.now();
let   lastReport = Date.now();
let   stopped    = false;

parentPort.on('message', msg => { if (msg === 'stop') stopped = true; });

(async () => {
  while (!stopped) {
    for (let i = 0n; i < BATCH; i++) {
      const target = tryNonce(nonce);
      if (target < diffBig) {
        parentPort.postMessage({ type: 'found', nonce: nonce.toString(), threadId });
        return;
      }
      nonce++;
    }
    attempts += BATCH;

    const now = Date.now();
    if (now - lastReport > 1000) {
      const hps = Number(attempts) / ((now - startTime) / 1000);
      parentPort.postMessage({ type: 'progress', attempts: attempts.toString(), hps, threadId });
      lastReport = now;
    }
    await new Promise(r => setImmediate(r));
  }
  parentPort.postMessage({ type: 'stopped', attempts: attempts.toString(), threadId });
})();
