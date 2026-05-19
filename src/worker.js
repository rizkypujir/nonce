/**
 * worker.js — Worker thread for parallel mining within one wallet
 *
 * Each thread gets a different nonce range to search.
 * When any thread finds a solution, it posts back, parent terminates all.
 */

import { parentPort, workerData } from 'worker_threads';
import { makeChallengeHasher } from './hash.js';

const { minerAddr, contractAddr, chainId, epoch, difficulty, startNonce, threadId } = workerData;

const tryNonce = makeChallengeHasher(chainId, contractAddr, minerAddr, epoch);
const diffBig = BigInt(difficulty);

let nonce = BigInt(startNonce);
let attempts = 0n;
const BATCH = 10000n;
const startTime = Date.now();
let lastReport = Date.now();
let stopped = false;

parentPort.on('message', (msg) => {
  if (msg === 'stop') stopped = true;
});

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

    // Yield + report every ~2s
    const now = Date.now();
    if (now - lastReport > 2000) {
      const dur = (now - startTime) / 1000;
      const hps = Number(attempts) / dur;
      parentPort.postMessage({ type: 'progress', attempts: attempts.toString(), hps, threadId });
      lastReport = now;
    }

    // Tiny yield so 'stop' messages can be received
    await new Promise(r => setImmediate(r));
  }

  parentPort.postMessage({ type: 'stopped', attempts: attempts.toString(), threadId });
})();
