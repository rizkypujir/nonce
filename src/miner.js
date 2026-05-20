/**
 * miner.js — Multi-thread PoW miner
 *
 * Each wallet uses N worker threads (configurable WORKER_THREADS).
 * Each thread searches different nonce range. First found wins.
 *
 * GPU mode: when config.USE_GPU is true, each wallet uses the OpenCL kernel
 * instead of CPU worker threads (~400x faster on RTX 3050 vs i5-12500H).
 */

import { Worker } from 'worker_threads';
import { privateKeyToAccount } from 'viem/accounts';
import { parseUnits, formatEther } from 'viem';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import chalk from 'chalk';

import { CONTRACT, CHAIN_ID, EPOCH_BLOCKS, MAX_MINTS_PER_BLOCK, ABI, config } from './config.js';
import { rpcPool, getWalletClient } from './rpc.js';
import { gpuMineEpoch, ensureGPU, gpuInfo } from './gpu/gpuWorker.js';
import { multiGpuMineEpoch, ensureMultiGPU, multiGpuInfo, gpuCount } from './gpu/gpuMulti.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'worker.js');

function ts() {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}

/**
 * Spawn N workers each searching different nonce range.
 * Returns Promise<{ found, nonce, totalHashes, hps }>
 */
function mineEpochParallel(minerAddr, epoch, difficulty, threadCount, label, onProgress) {
  return new Promise((resolve) => {
    const workers = [];
    const startTime = Date.now();
    let totalAttempts = 0n;
    const threadAttempts = new Array(threadCount).fill(0n);
    let resolved = false;
    let lastProgressLog = Date.now();

    const stopAll = () => {
      for (const w of workers) {
        try { w.postMessage('stop'); w.terminate(); } catch {}
      }
    };

    for (let t = 0; t < threadCount; t++) {
      // Each thread starts at a different random nonce
      const startNonce = (BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) + BigInt(t) * 10n**12n).toString();

      const worker = new Worker(WORKER_PATH, {
        workerData: {
          minerAddr,
          contractAddr: CONTRACT,
          chainId:      CHAIN_ID,
          epoch:        epoch.toString(),
          difficulty:   difficulty.toString(),
          startNonce,
          threadId:     t,
        },
      });

      worker.on('message', (msg) => {
        if (msg.type === 'progress') {
          threadAttempts[msg.threadId] = BigInt(msg.attempts);
          const total = threadAttempts.reduce((a, b) => a + b, 0n);
          const dur = (Date.now() - startTime) / 1000;
          const hps = Number(total) / dur;

          // Report every 2s
          if (Date.now() - lastProgressLog > 2000) {
            if (onProgress) onProgress(total, hps, dur);
            lastProgressLog = Date.now();
          }
          totalAttempts = total;
        } else if (msg.type === 'found') {
          if (resolved) return;
          resolved = true;
          const dur = (Date.now() - startTime) / 1000;
          const hps = Number(totalAttempts) / dur || 0;
          stopAll();
          resolve({ found: true, nonce: BigInt(msg.nonce), hashesPerSec: hps, totalHashes: totalAttempts, threadId: msg.threadId });
        } else if (msg.type === 'stopped') {
          threadAttempts[msg.threadId] = BigInt(msg.attempts);
        }
      });

      worker.on('error', (err) => {
        console.error(chalk.red(`  Worker thread error: ${err.message}`));
      });

      workers.push(worker);
    }

    // External stop hook (epoch change)
    const checkInterval = setInterval(() => {
      // Timeout safety: if mining takes > 5 epochs (~16 min), give up
      if (Date.now() - startTime > 16 * 60 * 1000 && !resolved) {
        resolved = true;
        clearInterval(checkInterval);
        stopAll();
        const dur = (Date.now() - startTime) / 1000;
        const hps = Number(totalAttempts) / dur || 0;
        resolve({ found: false, hashesPerSec: hps, totalHashes: totalAttempts });
      }
    }, 5000);
  });
}

async function readState() {
  const [difficulty, totalMints, totalMined, genesisComplete] = await Promise.all([
    rpcPool.call('readContract', { address: CONTRACT, abi: ABI, functionName: 'currentDifficulty' }),
    rpcPool.call('readContract', { address: CONTRACT, abi: ABI, functionName: 'totalMints' }),
    rpcPool.call('readContract', { address: CONTRACT, abi: ABI, functionName: 'totalMiningMinted' }),
    rpcPool.call('readContract', { address: CONTRACT, abi: ABI, functionName: 'genesisComplete' }),
  ]);
  return { difficulty, totalMints, totalMined, genesisComplete };
}

async function submitMine(account, nonce) {
  if (config.DRY_RUN) {
    return { ok: true, hash: '0xDRY_RUN', dry: true };
  }
  try {
    const wallet = getWalletClient(account);
    const baseFee = await rpcPool.call('getGasPrice');
    const maxFee = (baseFee * BigInt(Math.floor(config.GAS_MULTIPLIER * 1000))) / 1000n;
    const priority = parseUnits(String(config.PRIORITY_GWEI), 9);
    const cap = parseUnits(String(config.MAX_GAS_GWEI), 9);

    const finalMax = maxFee + priority > cap ? cap : maxFee + priority;

    const hash = await wallet.writeContract({
      address: CONTRACT,
      abi: ABI,
      functionName: 'mine',
      args: [nonce],
      gas: 200_000n,
      maxFeePerGas:         finalMax,
      maxPriorityFeePerGas: priority,
    });
    return { ok: true, hash };
  } catch (err) {
    return { ok: false, err: err.shortMessage || err.message?.slice(0, 150) };
  }
}

export async function runWorker(privateKey, label) {
  const account = privateKeyToAccount(privateKey);
  const balance = await rpcPool.call('getBalance', { address: account.address });
  const balEth = parseFloat(formatEther(balance));

  console.log(chalk.cyan(`[${ts()}] ${label} ${account.address.slice(0, 10)}... balance=${balEth.toFixed(5)} ETH`));

  if (balEth < 0.0005) {
    console.log(chalk.yellow(`  ⚠ ${label} balance too low (need ≥0.0005 ETH)`));
    return { wallet: account.address, mints: 0, error: 'low_balance' };
  }

  // Determine thread count: use config, but cap at CPU count
  const cpuCount = os.cpus().length;
  const threads = Math.min(Math.max(1, config.WORKER_THREADS), cpuCount);
  console.log(chalk.gray(`  ${label} using ${threads} threads (CPU: ${cpuCount})`));

  let mintsCount = 0;
  let currentEpoch = 0n;
  // Session-level counters (across all rounds)
  const sessionStart = Date.now();
  let sessionHashes  = 0n;
  let sessionFinds   = 0;

  while (true) {
    const block = await rpcPool.call('getBlockNumber');
    const newEpoch = block / EPOCH_BLOCKS;

    if (newEpoch !== currentEpoch) {
      currentEpoch = newEpoch;
    }

    const state = await readState();
    if (!state.genesisComplete) {
      console.log(chalk.yellow(`  ⚠ ${label} genesis not complete yet, waiting...`));
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    const mintsThisBlock = await rpcPool.call('readContract', {
      address: CONTRACT,
      abi: ABI,
      functionName: 'mintsInBlock',
      args: [block],
    });
    if (mintsThisBlock >= BigInt(MAX_MINTS_PER_BLOCK)) {
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    let epochAtStart = currentEpoch;
    const diffLog2 = Math.log2(parseFloat(state.difficulty.toString())).toFixed(1);

    let result;
    const startMine = Date.now();

    if (config.USE_GPU) {
      // ----- GPU path -----
      let gpuName = '';
      try {
        if (config.MULTI_GPU) {
          ensureMultiGPU(config.MAX_GPUS);
          gpuName = multiGpuInfo();
        } else {
          ensureGPU();
          gpuName = gpuInfo();
        }
      } catch (e) {
        console.log(chalk.yellow(`  ⚠ ${label} GPU init failed (${e.message.slice(0,80)}), falling back to CPU`));
        config.USE_GPU = false;
      }

      if (config.USE_GPU) {
        console.log(chalk.gray(`  ⛏  ${label} epoch ${epochAtStart} GPU ${gpuName} (diff 2^${diffLog2})...`));
        const mineFn = config.MULTI_GPU ? multiGpuMineEpoch : gpuMineEpoch;
        result = await mineFn({
          chainId:      CHAIN_ID,
          contractAddr: CONTRACT,
          minerAddr:    account.address,
          epoch:        epochAtStart,
          difficulty:   state.difficulty,
          batchSize:    config.GPU_BATCH,
          maxGPUs:      config.MAX_GPUS,
          shouldStop:   () => false,
          onProgress: ({ totalHashes, hps, dur }) => {
            // Cumulative session display
            const cumHashes = sessionHashes + totalHashes;
            const cumDur    = (Date.now() - sessionStart) / 1000;
            const cumHps    = Number(cumHashes) / cumDur;
            const mh        = (Number(cumHashes) / 1e6).toFixed(1);
            const rate      = cumHps >= 1e9
              ? (cumHps / 1e9).toFixed(2) + ' GH/s'
              : (cumHps / 1e6).toFixed(1) + ' MH/s';
            const findsTxt  = sessionFinds > 0 ? ` · ${sessionFinds} finds` : '';
            process.stdout.write(chalk.gray(`     ${label} ${mh}M tries · ${rate} · ${cumDur.toFixed(0)}s${findsTxt}\n`));
          },
        });
        // adapt fields
        result.hashesPerSec = result.hps;
      }
    }

    if (!config.USE_GPU) {
      // ----- CPU path (legacy) -----
      console.log(chalk.gray(`  ⛏  ${label} epoch ${epochAtStart} CPU (diff 2^${diffLog2}, ${threads} threads)...`));

      result = await mineEpochParallel(
        account.address, epochAtStart, state.difficulty, threads, label,
        (attempts, hps, dur) => {
          const mh = (Number(attempts) / 1e6).toFixed(2);
          const khps = (hps / 1000).toFixed(0);
          process.stdout.write(chalk.gray(`     ${label} ${mh}M tries · ${khps} KH/s · ${dur.toFixed(0)}s\n`));
        },
      );
    }

    const dur = ((Date.now() - startMine) / 1000).toFixed(1);
    if (!result.found) {
      sessionHashes += BigInt(result.totalHashes || 0n);
      const cumDur = (Date.now() - sessionStart) / 1000;
      const cumHps = Number(sessionHashes) / cumDur;
      const rateStr = cumHps >= 1e9 ? `${(cumHps/1e9).toFixed(2)} GH/s` : `${(cumHps/1e6).toFixed(1)} MH/s`;
      console.log(chalk.gray(`  ${label} no result this round · session ${(Number(sessionHashes)/1e9).toFixed(1)}B @ ${rateStr}`));
      continue;
    }

    sessionHashes += BigInt(result.totalHashes);
    sessionFinds++;
    const cumDur = (Date.now() - sessionStart) / 1000;
    const cumHps = Number(sessionHashes) / cumDur;
    const cumGH  = (Number(sessionHashes) / 1e9).toFixed(1);
    const rateStr = cumHps >= 1e9 ? `${(cumHps/1e9).toFixed(2)} GH/s` : `${(cumHps/1e6).toFixed(1)} MH/s`;
    console.log(chalk.green(`  ✓ ${label} FOUND #${sessionFinds} after ${dur}s round · session ${cumGH}B in ${cumDur.toFixed(0)}s @ ${rateStr}`));

    // Verify epoch & block cap before submit
    const blockNow = await rpcPool.call('getBlockNumber');
    const epochNow = blockNow / EPOCH_BLOCKS;
    if (epochNow !== epochAtStart) {
      console.log(chalk.yellow(`  ⚠ ${label} epoch changed (${epochAtStart} → ${epochNow}), retrying...`));
      continue;
    }

    // re-check mints in current block (race with other miners)
    const mintsNow = await rpcPool.call('readContract', {
      address: CONTRACT, abi: ABI, functionName: 'mintsInBlock', args: [blockNow],
    });
    if (mintsNow >= BigInt(MAX_MINTS_PER_BLOCK)) {
      console.log(chalk.yellow(`  ⚠ ${label} block ${blockNow} already has ${mintsNow}/10 mints, waiting next block...`));
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }

    process.stdout.write(chalk.gray(`  📤 ${label} submitting tx... `));
    const tx = await submitMine(account, result.nonce);
    if (tx.ok) {
      mintsCount++;
      console.log(chalk.green(`✓ ${tx.hash.slice(0, 14)}...`));
      console.log(chalk.gray(`     https://basescan.org/tx/${tx.hash}`));

      if (config.TARGET_MINTS_PER_WALLET > 0 && mintsCount >= config.TARGET_MINTS_PER_WALLET) {
        console.log(chalk.cyan(`  🎯 ${label} target ${mintsCount} reached`));
        break;
      }

      try {
        await rpcPool.call('waitForTransactionReceipt', { hash: tx.hash, timeout: 60000 });
      } catch {}
    } else {
      console.log(chalk.red(`✗ ${tx.err}`));
      if (/used|already|replay/i.test(tx.err || '')) {
        await new Promise(r => setTimeout(r, 500));
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  return { wallet: account.address, mints: mintsCount };
}
