#!/usr/bin/env node
/**
 * NONCE Multi-Wallet PoW Miner
 *
 * Commands:
 *   npm start | npm run mine    Start mining
 *   npm run stats               Show contract state
 */

import chalk from 'chalk';
import { formatEther, formatUnits } from 'viem';
import { CONTRACT, ABI, EPOCH_BLOCKS, config, loadWallets } from './config.js';
import { rpcPool } from './rpc.js';
import { runWorker } from './miner.js';

async function fetchInfo() {
  const [diff, totalMints, totalMined, genesisComplete, blockNumber] = await Promise.all([
    rpcPool.call('readContract', { address: CONTRACT, abi: ABI, functionName: 'currentDifficulty' }),
    rpcPool.call('readContract', { address: CONTRACT, abi: ABI, functionName: 'totalMints' }),
    rpcPool.call('readContract', { address: CONTRACT, abi: ABI, functionName: 'totalMiningMinted' }),
    rpcPool.call('readContract', { address: CONTRACT, abi: ABI, functionName: 'genesisComplete' }),
    rpcPool.call('getBlockNumber'),
  ]);
  return {
    difficulty: diff,
    totalMints,
    totalMined,
    genesisComplete,
    blockNumber,
    epoch: blockNumber / EPOCH_BLOCKS,
    blocksUntilNextEpoch: Number(EPOCH_BLOCKS - (blockNumber % EPOCH_BLOCKS)),
  };
}

function eraOf(totalMints) {
  return totalMints / 100_000n;
}

function rewardOf(era) {
  // 100 NONCE >> era (e18 decimals)
  let reward = 100n * 10n**18n;
  for (let i = 0n; i < era; i++) reward >>= 1n;
  return reward;
}

async function cmdStats() {
  console.log(chalk.cyan('\n  $NONCE Multi-Wallet Miner\n'));
  console.log(chalk.gray(`  Contract : ${CONTRACT}`));
  console.log(chalk.gray(`  RPCs     : ${config.RPC_URLS.length} (${config.RPC_URLS[0]} primary)`));
  console.log(chalk.gray(`  Gas mult : ${config.GAS_MULTIPLIER}x`));
  console.log(chalk.gray(`  Priority : ${config.PRIORITY_GWEI} gwei`));
  console.log(chalk.gray(`  Workers  : ${config.PARALLEL_WORKERS} concurrent`));
  console.log(chalk.gray(`  Engine   : ${config.USE_GPU ? 'GPU (OpenCL)' : 'CPU (' + config.WORKER_THREADS + ' threads)'}`));
  console.log(chalk.gray(`  DryRun   : ${config.DRY_RUN}\n`));

  const info = await fetchInfo();
  const era = eraOf(info.totalMints);
  const reward = rewardOf(era);
  const minedM = parseFloat(formatUnits(info.totalMined, 18)) / 1e6;
  const targetM = 18.9;
  const pct = (minedM / targetM) * 100;
  const diffPct = (parseFloat(formatUnits(info.difficulty, 0)) / Math.pow(2, 256)) * 100;

  console.log(chalk.cyan('  Contract state:'));
  console.log(chalk.gray(`    Total mints  : ${info.totalMints}`));
  console.log(chalk.gray(`    Mined        : ${minedM.toFixed(2)}M / ${targetM}M NONCE (${pct.toFixed(2)}%)`));
  console.log(chalk.gray(`    Era          : ${era}`));
  console.log(chalk.gray(`    Reward/mint  : ${formatUnits(reward, 18)} NONCE`));
  console.log(chalk.gray(`    Difficulty   : 2^${Math.log2(parseFloat(formatUnits(info.difficulty, 0))).toFixed(1)} (~${diffPct.toExponential(1)}% of 2^256)`));
  console.log(chalk.gray(`    Block        : ${info.blockNumber}`));
  console.log(chalk.gray(`    Epoch        : ${info.epoch} (next in ${info.blocksUntilNextEpoch} blocks ~${(info.blocksUntilNextEpoch * 2 / 60).toFixed(1)} min)`));
  console.log(chalk.gray(`    Genesis      : ${info.genesisComplete ? '✓ complete (mining live)' : '⏳ not complete'}\n`));

  const wallets = loadWallets();
  console.log(chalk.cyan(`  ${wallets.length} wallet(s) loaded\n`));
}

async function cmdMine() {
  await cmdStats();

  const wallets = loadWallets();
  console.log(chalk.cyan(`\n  Starting ${Math.min(wallets.length, config.PARALLEL_WORKERS)} worker(s) in parallel...\n`));
  console.log(chalk.gray('  Each wallet has its own per-address challenge (unstealable from mempool).\n'));
  console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

  const limit = config.PARALLEL_WORKERS;
  const queue = wallets.slice();
  const active = [];
  const results = [];

  while (queue.length > 0 || active.length > 0) {
    while (queue.length > 0 && active.length < limit) {
      const pk = queue.shift();
      const idx = wallets.indexOf(pk) + 1;
      const label = chalk.cyan(`[w${idx}]`);
      const promise = runWorker(pk, label).then(r => {
        results.push(r);
        active.splice(active.indexOf(promise), 1);
      }).catch(e => {
        console.error(chalk.red(`  Worker error: ${e.message}`));
        active.splice(active.indexOf(promise), 1);
      });
      active.push(promise);
    }
    if (active.length) await Promise.race(active);
  }

  console.log(chalk.cyan('\n  All workers done.\n'));
  let total = 0;
  for (const r of results) {
    console.log(chalk.gray(`  ${r.wallet}  → ${r.mints} mints${r.error ? ' (' + r.error + ')' : ''}`));
    total += r.mints;
  }
  console.log(chalk.green(`\n  Total mints across all wallets: ${total}\n`));
}

const cmd = (process.argv[2] || 'mine').toLowerCase();

(async () => {
  try {
    if (cmd === 'stats')      await cmdStats();
    else if (cmd === 'mine')  await cmdMine();
    else if (cmd === 'help' || cmd === '-h') showHelp();
    else { console.error(`Unknown command: ${cmd}`); showHelp(); process.exit(1); }
  } catch (e) {
    console.error(chalk.red(`\n  Fatal: ${e.message}\n`));
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
})();

function showHelp() {
  console.log(chalk.cyan(`
  $NONCE Multi-Wallet Miner

  Commands:
    stats    Show contract state, no mining
    mine     Start mining with all wallets in parallel (default)

  Setup:
    1. cp .env.example .env       → fill RPC_URL
    2. cp wallets.txt.example wallets.txt   → fill private keys
    3. npm install
    4. npm run stats              → verify
    5. npm run mine               → start

  Mining algorithm:
    challenge = keccak256(chainId, contract, miner, epoch)
    target    = keccak256(challenge, nonce)
    valid if target < currentDifficulty

    Per-(miner, epoch) → unstealable from mempool.

  Tips:
    - Each wallet has independent challenge → run as many wallets as you want
    - Block cap = 10 mints/block (across all miners)
    - Epoch ~3.3 minutes on Base (100 blocks)
    - Reward halves every 100k mints
`));
}

process.on('SIGINT', () => {
  console.log(chalk.gray('\n  Stopped.\n'));
  process.exit(0);
});
