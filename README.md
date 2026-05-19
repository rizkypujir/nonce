# $NONCE PoW Miner — GPU Edition

Mining $NONCE on Base via OpenCL GPU kernel. Multi-wallet, auto-RPC failover, zero-Python.

## Setup

```bash
npm install
```

`.env` sudah preset:
- `RPC_URL` → ganti kalau perlu (default Ankr)
- `USE_GPU=true` → pakai OpenCL GPU (default)
- `GPU_BATCH=4194304` → 4M nonces per kernel launch
- `GAS_MULTIPLIER`, `PRIORITY_GWEI`, `MAX_GAS_GWEI` → tweak buat priority
- `DRY_RUN=false` → set `true` kalo cuma mau test, gak broadcast

`wallets.txt` → 1 baris per private key (sudah ada 1 wallet lo).

## Run

```bash
# cek state contract
node src/index.js stats

# mulai mining (Ctrl+C buat stop)
node src/index.js mine
```

## Hash Rate Bench

```bash
node src/gpu/test-bench.js
```

Expected RTX 3050: **~300 MH/s** (vs CPU 14-thread ~720 KH/s).

## Math (real numbers)

Difficulty current: 2^218 → expected ~275B hashes per find = ~15 menit @ 300 MH/s avg.
Range: 50%-ile ~10 min, 90%-ile ~35 min.

Block cap 10 mints/block — beberapa attempt mungkin lost-race, tapi per-(miner,epoch) challenge unstealable jadi gak rugi compute-nya.

## Files

- `src/index.js` — CLI dispatcher (stats, mine)
- `src/miner.js` — wallet orchestration + tx submit
- `src/gpu/gpuMiner.js` — OpenCL host code (FFI via koffi)
- `src/gpu/kernel.cl` — keccak256 PoW kernel (compiled at runtime)
- `src/gpu/gpuWorker.js` — gpu mining loop wrapper
- `src/hash.js` — native CPU keccak (fallback)
- `src/worker.js` — CPU worker thread (fallback)
- `src/rpc.js` — viem RPC pool with failover
- `src/config.js` — env loader, ABI

## Switch ke CPU

Edit `.env`: `USE_GPU=false`. CPU pakai 14 threads (`WORKER_THREADS=14`).

## Tips

- **Multi-wallet**: tambah private key di `wallets.txt`, `PARALLEL_WORKERS=1` (GPU shared, gak parallel). Setiap wallet jalan giliran → reward × jumlah wallet kalau patient.
- **Ribet & gak yakin?**: jalanin `node src/gpu/test-bench.js` dulu — kalau dapet 300+ MH/s berarti GPU lo siap. Kalau error → fallback CPU otomatis.
- **Gas spike**: naikin `MAX_GAS_GWEI` kalo Base lagi macet. Default 5 gwei aman.
