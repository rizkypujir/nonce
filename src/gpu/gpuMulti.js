/**
 * gpuMulti.js — orchestrate N GPUs in parallel using Worker Threads.
 *
 * Each GPU runs in its own thread (true parallel, no GIL/event-loop blocking).
 * First GPU to find a nonce wins; all others are stopped.
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';
import { listAllGPUs, buildChallenge } from './gpuMiner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const THREAD_PATH = path.join(__dirname, 'gpuThread.js');

let _gpuList = null;
let _initLog  = '';

export function multiGpuInfo() { return _initLog; }
export function gpuCount()     { return _gpuList ? _gpuList.length : 0; }

function getGPUList(maxGPUs = 99) {
  if (!_gpuList) {
    _gpuList = listAllGPUs().slice(0, maxGPUs);
    _initLog = `${_gpuList.length} GPU(s): ${_gpuList.map(g => g.name).join(', ')}`;
  }
  return _gpuList;
}

// Kept for compat — no-op since threads init their own context
export function ensureMultiGPU(maxGPUs = 99) {
  getGPUList(maxGPUs);
  return _gpuList;
}

/**
 * Mine one epoch using ALL GPUs in parallel (each in its own Worker Thread).
 * Returns { found, nonce, target, totalHashes, hps, ms, gpuIdx }
 */
export async function multiGpuMineEpoch(opts) {
  const gpus = getGPUList(opts.maxGPUs || 99);
  const N = gpus.length;
  const batchSize = opts.batchSize || (16 * 1024 * 1024);

  const RAND_MAX = 1n << 60n;
  const startNonces = gpus.map((_, i) =>
    ((BigInt(Math.floor(Math.random() * 1e15)) + BigInt(i) * (1n << 52n)) % RAND_MAX).toString()
  );

  const started = Date.now();
  const perGpuAttempts = new Array(N).fill(0n);
  const perGpuHps      = new Array(N).fill(0);
  let lastProgress = Date.now();
  const TO = opts.timeoutMs || 16 * 60 * 1000;

  return new Promise((resolve) => {
    const workers = [];
    let resolved = false;

    function stopAll() {
      for (const w of workers) {
        try { w.postMessage({ type: 'stop' }); w.terminate(); } catch {}
      }
    }

    function totalHashes() {
      return perGpuAttempts.reduce((a, b) => a + b, 0n);
    }

    function totalHps() {
      return perGpuHps.reduce((a, b) => a + b, 0);
    }

    for (let i = 0; i < N; i++) {
      const w = new Worker(THREAD_PATH, {
        workerData: { deviceIndex: i, batchSize },
      });

      w.on('message', (msg) => {
        if (msg.type === 'ready') {
          // GPU ready — send mine command
          w.postMessage({
            type:         'mine',
            chainId:      opts.chainId.toString(),
            contractAddr: opts.contractAddr,
            minerAddr:    opts.minerAddr,
            epoch:        opts.epoch.toString(),
            difficulty:   opts.difficulty.toString(),
            startNonce:   startNonces[i],
          });
        } else if (msg.type === 'progress') {
          perGpuAttempts[i] = BigInt(msg.attempts);
          perGpuHps[i]      = msg.hps;

          if (Date.now() - lastProgress > 2000) {
            const dur = (Date.now() - started) / 1000;
            const th  = totalHashes();
            const hps = totalHps();
            if (opts.onProgress) opts.onProgress({ totalHashes: th, hps, dur });
            lastProgress = Date.now();
          }
        } else if (msg.type === 'found') {
          if (resolved) return;
          resolved = true;
          perGpuAttempts[i] = BigInt(msg.attempts);
          const th  = totalHashes();
          const dur = (Date.now() - started) / 1000;
          const hps = Number(th) / dur || 0;
          stopAll();
          resolve({
            found:       true,
            nonce:       BigInt(msg.nonce),
            target:      BigInt(msg.target),
            totalHashes: th,
            hps,
            ms:          msg.ms,
            gpuIdx:      i,
          });
        }
      });

      w.on('error', (err) => {
        console.error(`[GPU ${i}] thread error: ${err.message}`);
      });

      w.on('exit', (code) => {
        if (!resolved && code !== 0) {
          console.error(`[GPU ${i}] thread exited with code ${code}`);
        }
      });

      workers.push(w);
    }

    // Timeout safety
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        stopAll();
        const th  = totalHashes();
        const dur = (Date.now() - started) / 1000;
        resolve({ found: false, totalHashes: th, hps: Number(th) / dur || 0, timeout: true });
      }
    }, TO);
  });
}

export function destroyMultiGPU() {
  _gpuList = null;
  _initLog  = '';
}
