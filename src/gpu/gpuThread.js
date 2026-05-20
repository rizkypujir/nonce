/**
 * gpuThread.js — Worker thread that owns ONE GPU context.
 * Receives { type:'mine', ... } messages, replies with progress/found/stopped.
 */
import { workerData, parentPort } from 'worker_threads';
import { GPUMiner, buildChallenge } from './gpuMiner.js';

const { deviceIndex, batchSize } = workerData;

const miner = new GPUMiner(deviceIndex);
miner.init();
miner.batchSize = batchSize;

parentPort.postMessage({ type: 'ready', name: miner.deviceName, cu: miner.computeUnits });

let stop = false;
parentPort.on('message', msg => {
  if (msg.type === 'stop') stop = true;
});

// Wait for 'mine' command
parentPort.once('message', async (msg) => {
  if (msg.type !== 'mine') return;

  const { chainId, contractAddr, minerAddr, epoch, difficulty, startNonce } = msg;
  const chal = buildChallenge(BigInt(chainId), contractAddr, minerAddr, BigInt(epoch));
  miner.setChallenge(chal, BigInt(difficulty));

  const RAND_MAX = 1n << 60n;
  let base = BigInt(startNonce);
  let attempts = 0n;
  const started = Date.now();
  let lastReport = Date.now();

  while (!stop) {
    const r = miner.runBatch(base);
    attempts += BigInt(r.attempts);
    base += BigInt(miner.batchSize);
    if (base > RAND_MAX) base = BigInt(Math.floor(Math.random() * 1e15));

    if (r.found) {
      parentPort.postMessage({
        type: 'found',
        nonce: r.nonce.toString(),
        target: r.target.toString(),
        attempts: attempts.toString(),
        ms: Date.now() - started,
      });
      return;
    }

    const now = Date.now();
    if (now - lastReport > 1000) {
      const hps = Number(attempts) / ((now - started) / 1000);
      parentPort.postMessage({ type: 'progress', attempts: attempts.toString(), hps });
      lastReport = now;
    }
  }

  parentPort.postMessage({ type: 'stopped', attempts: attempts.toString() });
});
