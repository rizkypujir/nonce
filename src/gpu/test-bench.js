/**
 * Bench: GPU miner against known challenge.
 * Verifies kernel correctness with a low-difficulty test, then measures hash rate.
 */

import { GPUMiner, buildChallenge } from './gpuMiner.js';
import { makeChallengeHasher } from '../hash.js';
import keccak from 'keccak';

const chainId = 8453n;
const contract = '0xE7bADd12bdf070e925A55A98c981f3aBAB4f20cc';
const miner = '0x0000000000000000000000000000000000000001';
const epoch = 462064n;

const challenge = buildChallenge(chainId, contract, miner, epoch);
console.log('Challenge:', challenge.toString('hex'));

// CPU reference: compute hash for nonce=12345
const cpuHash = makeChallengeHasher(chainId, contract, miner, epoch);
const refNonce = 12345n;
const refTarget = cpuHash(refNonce);
console.log('CPU ref hash for nonce=12345:', refTarget.toString(16).padStart(64, '0'));

// --- GPU init
console.log('\n=== GPU init ===');
const gm = new GPUMiner();
const dev = gm.init();
console.log(`device: ${dev.name} (${dev.computeUnits} CUs)`);

// --- Test 1: low difficulty (target very high) => should find immediately
console.log('\n=== Test 1: easy difficulty ===');
const easyDiff = (1n << 256n) - 1n; // accept anything
gm.setChallenge(challenge, easyDiff);
gm.batchSize = 256; // small batch for test
const r1 = gm.runBatch(0n);
console.log('result:', { found: r1.found, nonce: r1.nonce?.toString(), ms: r1.ms });

if (r1.found) {
  // Verify GPU result against CPU
  const cpuVerify = cpuHash(r1.nonce);
  console.log('CPU recompute target:', cpuVerify.toString(16).padStart(64, '0'));
  console.log('GPU returned target :', r1.target.toString(16).padStart(64, '0'));
  if (cpuVerify === r1.target) {
    console.log('✓ GPU hash matches CPU');
  } else {
    console.log('✗ MISMATCH — kernel bug!');
    process.exit(1);
  }
}

// --- Test 2: hash rate benchmark with diff=0 (never matches, full batch runs)
console.log('\n=== Test 2: hash rate bench ===');
gm.setChallenge(challenge, 0n); // never match → full batch processes
gm.batchSize = 1024 * 1024 * 4; // 4M nonces per batch
console.log(`batch size: ${gm.batchSize / 1e6}M`);

// Warmup
gm.runBatch(1000000n);

const N = 10;
let totalNonces = 0;
let totalMs = 0;
const startBench = Date.now();
for (let i = 0; i < N; i++) {
  const r = gm.runBatch(BigInt(i + 2) * BigInt(gm.batchSize));
  totalNonces += r.attempts;
  totalMs += r.ms;
  process.stdout.write(`  batch ${i+1}/${N}: ${(r.attempts/1e6).toFixed(1)}M in ${r.ms}ms = ${(r.attempts/r.ms/1000).toFixed(1)} MH/s\n`);
}
const wallMs = Date.now() - startBench;
const totalMH = totalNonces / 1e6;
const wallHps = (totalNonces / wallMs * 1000) / 1e6;
console.log(`\nTOTAL: ${totalMH.toFixed(1)}M nonces in ${wallMs}ms wall = ${wallHps.toFixed(1)} MH/s`);

gm.destroy();
console.log('done.');
