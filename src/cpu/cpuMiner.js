/**
 * cpuMiner.js — spawn N CPU threads for keccak256 mining.
 * Returns same interface as multiGpuMineEpoch.
 */
import { Worker } from 'worker_threads';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const THREAD_PATH = path.join(__dirname, 'cpuThread.js');

export function cpuThreadCount(requested) {
  const cores = os.cpus().length;
  return Math.min(Math.max(1, requested || cores), cores);
}

/**
 * Mine using N CPU threads. Returns { found, nonce, totalHashes, hps, ms }.
 * Stops when found OR external stop() is called.
 */
export function cpuMineEpoch(opts, stopSignal) {
  const N = cpuThreadCount(opts.threads);
  const RAND_MAX = BigInt(Number.MAX_SAFE_INTEGER);

  return new Promise((resolve) => {
    const workers = [];
    const perAttempts = new Array(N).fill(0n);
    const perHps      = new Array(N).fill(0);
    let resolved = false;
    const started = Date.now();

    function stopAll() {
      for (const w of workers) {
        try { w.postMessage('stop'); w.terminate(); } catch {}
      }
    }

    function totalHashes() { return perAttempts.reduce((a, b) => a + b, 0n); }
    function totalHps()    { return perHps.reduce((a, b) => a + b, 0); }

    // Check external stop signal every 500ms
    const stopCheck = setInterval(() => {
      if (stopSignal && stopSignal.stopped && !resolved) {
        resolved = true;
        clearInterval(stopCheck);
        stopAll();
        const th = totalHashes();
        resolve({ found: false, totalHashes: th, hps: totalHps(), stopped: true });
      }
    }, 500);

    for (let t = 0; t < N; t++) {
      const startNonce = (
        BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) +
        BigInt(t) * (1n << 40n)
      ).toString();

      const w = new Worker(THREAD_PATH, {
        workerData: {
          chainId:      opts.chainId.toString(),
          contractAddr: opts.contractAddr,
          minerAddr:    opts.minerAddr,
          epoch:        opts.epoch.toString(),
          difficulty:   opts.difficulty.toString(),
          startNonce,
          threadId:     t,
        },
      });

      w.on('message', (msg) => {
        if (msg.type === 'progress') {
          perAttempts[msg.threadId] = BigInt(msg.attempts);
          perHps[msg.threadId]      = msg.hps;
        } else if (msg.type === 'found') {
          if (resolved) return;
          resolved = true;
          clearInterval(stopCheck);
          const th = totalHashes();
          stopAll();
          resolve({
            found:       true,
            nonce:       BigInt(msg.nonce),
            totalHashes: th,
            hps:         totalHps(),
            ms:          Date.now() - started,
            source:      'cpu',
            threadId:    msg.threadId,
          });
        }
      });

      w.on('error', err => console.error(`[CPU t${t}] ${err.message}`));
      workers.push(w);
    }
  });
}
