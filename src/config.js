import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.join(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

function bool(name, fallback = false) {
  const raw = (process.env[name] || '');
  // Strip inline comments (e.g. "true  # comment")
  const v = raw.split('#')[0].toLowerCase().trim();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return fallback;
}

function num(name, fallback) {
  const raw = (process.env[name] || '');
  const v = raw.split('#')[0].trim();
  if (v === '') return fallback;
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

export const CONTRACT  = '0xE7bADd12bdf070e925A55A98c981f3aBAB4f20cc';
export const CHAIN_ID  = 8453;  // Base mainnet
export const EPOCH_BLOCKS = 600n;
export const MAX_MINTS_PER_BLOCK = 10;

export const config = {
  RPC_URL:  process.env.RPC_URL || 'https://mainnet.base.org',
  RPC_URLS: (process.env.RPC_URLS || process.env.RPC_URL || 'https://mainnet.base.org')
            .split(',').map(s => s.trim()).filter(Boolean),
  GAS_MULTIPLIER:    num('GAS_MULTIPLIER', 1.2),
  PRIORITY_GWEI:     num('PRIORITY_GWEI', 0.01),
  MAX_GAS_GWEI:      num('MAX_GAS_GWEI', 5),
  PARALLEL_WORKERS:  Math.max(1, Math.floor(num('PARALLEL_WORKERS', 5))),
  WORKER_THREADS:    Math.max(1, Math.floor(num('WORKER_THREADS', 2))),
  TARGET_MINTS_PER_WALLET: Math.floor(num('TARGET_MINTS_PER_WALLET', 0)),
  DRY_RUN:           bool('DRY_RUN', false),
  SKIP_HARD_EPOCH:   bool('SKIP_HARD_EPOCH', false),
  USE_GPU:           bool('USE_GPU', true),
  MULTI_GPU:         bool('MULTI_GPU', false),
  MAX_GPUS:          Math.max(1, Math.floor(num('MAX_GPUS', 99))),
  GPU_BATCH:         Math.max(1024, Math.floor(num('GPU_BATCH', 4 * 1024 * 1024))),
  USE_CPU_HYBRID:    bool('USE_CPU_HYBRID', false),
  ROOT,
};

export function loadWallets() {
  const fp = path.join(ROOT, 'wallets.txt');
  if (!fs.existsSync(fp)) {
    throw new Error(`wallets.txt not found. Copy wallets.txt.example → wallets.txt and fill private keys.`);
  }
  const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
  const keys = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const k = t.startsWith('0x') ? t : '0x' + t;
    if (!/^0x[a-fA-F0-9]{64}$/.test(k)) {
      console.warn(`[warn] skipping invalid key: ${t.slice(0, 10)}...`);
      continue;
    }
    keys.push(k);
  }
  if (!keys.length) throw new Error('No valid private keys in wallets.txt');
  return keys;
}

// ABI for $NONCE contract
export const ABI = [
  {
    name: 'mine',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'nonce', type: 'uint256' }],
    outputs: [],
  },
  // View functions for state
  { name: 'currentDifficulty', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalMints', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalMiningMinted', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'genesisComplete', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { name: 'mintsInBlock', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { name: 'usedProofs', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
