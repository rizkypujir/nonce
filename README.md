# $NONCE GPU Miner

Multi-wallet PoW miner untuk **$NONCE** token di Base chain.
GPU OpenCL kernel (zero Python, zero compiler) — support **multi-GPU + CPU hybrid**.

Contract: [`0xE7bADd12bdf070e925A55A98c981f3aBAB4f20cc`](https://basescan.org/address/0xE7bADd12bdf070e925A55A98c981f3aBAB4f20cc)
Site: https://nonceagent8004.com

---

## Requirements

- **Node.js 20+** ([download](https://nodejs.org))
- **GPU NVIDIA / AMD / Intel** dengan driver terbaru (OpenCL support)
- **Git** ([download](https://git-scm.com))
- **ETH di Base** ≥ 0.001 ETH per wallet buat gas

Cek GPU:
```bash
nvidia-smi          # NVIDIA
clinfo -l           # semua GPU (Linux)
```

---

## Install

```bash
git clone https://github.com/rizkypujir/nonce.git
cd nonce
npm install
cp .env.example .env
cp wallets.txt.example wallets.txt
```

Edit `.env` dan `wallets.txt` sesuai setup lo.

---

## Run

```bash
node src/index.js stats    # cek state contract
node src/index.js mine     # mulai mining
node src/gpu/test-bench.js # bench hash rate
```

`Ctrl+C` untuk stop.

---

## Config (.env)

### Wajib
```env
RPC_URL=https://mainnet.base.org
```

### GPU Settings
```env
USE_GPU=true                # false = CPU only
MULTI_GPU=true              # true = pakai SEMUA GPU detected
MAX_GPUS=4                  # cap jumlah GPU (default 99 = semua)
GPU_BATCH=33554432          # nonces per kernel launch (32M optimal untuk 3090/4090)
```

### CPU Hybrid (GPU + CPU bareng)
```env
USE_CPU_HYBRID=true         # CPU ikut mining bareng GPU
WORKER_THREADS=180          # jumlah CPU thread (set = jumlah core - 6)
```

### Gas
```env
GAS_MULTIPLIER=1.2
PRIORITY_GWEI=0.01
MAX_GAS_GWEI=5
```

### Lainnya
```env
PARALLEL_WORKERS=1          # wallet concurrent (biarin 1, GPU shared)
TARGET_MINTS_PER_WALLET=0   # 0 = unlimited
DRY_RUN=false               # true = simulate, gak broadcast
```

---

## Performance

| Setup | Hash Rate | Find Time (diff 2^218) |
|---|---|---|
| RTX 3050 Laptop (1 GPU) | ~300 MH/s | ~15 min |
| RTX 3090 (1 GPU) | ~1.8 GH/s | ~2.5 min |
| 4x RTX 3090 | ~7.2 GH/s | ~40 sec |
| 4x RTX 3090 + 96 CPU | ~8.5 GH/s | ~35 sec |
| RTX 5090 (1 GPU) | ~5.7 GH/s | ~1 min |

GPU_BATCH tuning:
- RTX 3050 (4GB): `GPU_BATCH=4194304` (4M)
- RTX 3090 (24GB): `GPU_BATCH=33554432` (32M)
- RTX 4090/5090: `GPU_BATCH=67108864` (64M)

---

## Multi-GPU Setup (VPS/Server)

### Linux (Ubuntu/Debian)
```bash
# Install OpenCL runtime
sudo apt install -y ocl-icd-libopencl1 clinfo
sudo apt install -y libnvidia-compute-570   # sesuaikan versi driver

# Kalau clinfo gak detect GPU:
sudo mkdir -p /etc/OpenCL/vendors
echo "libnvidia-opencl.so.1" | sudo tee /etc/OpenCL/vendors/nvidia.icd

# Verify
clinfo -l    # harus list semua GPU
```

### .env untuk multi-GPU
```env
USE_GPU=true
MULTI_GPU=true
MAX_GPUS=4
GPU_BATCH=33554432
USE_CPU_HYBRID=true
WORKER_THREADS=90
```

---

## Math

- Algoritma: `keccak256(abi.encode(challenge, nonce)) < currentDifficulty`
- Challenge: `keccak256(abi.encode(chainId, contract, miner, epoch))`
- Epoch: 600 blocks (~20 menit di Base)
- Block cap: 10 mints/block
- Reward: 100 NONCE per mint (halving tiap 100k mints)

---

## Files

```
src/
├── index.js          # CLI (stats, mine)
├── miner.js          # Wallet orchestrator + tx submit
├── config.js         # env loader, ABI, constants
├── hash.js           # Native CPU keccak
├── worker.js         # CPU worker thread
├── rpc.js            # viem RPC pool + failover
├── gpu/
│   ├── kernel.cl     # OpenCL keccak256 kernel
│   ├── gpuMiner.js   # OpenCL host (FFI via koffi)
│   ├── gpuMulti.js   # Multi-GPU orchestrator (Worker Threads)
│   ├── gpuThread.js  # Per-GPU worker thread
│   ├── gpuWorker.js  # Single-GPU wrapper
│   └── test-bench.js # Hash rate benchmark
└── cpu/
    ├── cpuMiner.js   # CPU thread pool manager
    └── cpuThread.js  # Per-CPU worker thread
```

---

## Troubleshooting

**`Cannot load OpenCL library`** → install GPU driver + OpenCL runtime (lihat Multi-GPU Setup)

**`GPU init failed, falling back to CPU`** → `.env` inline comments breaking parser. Hapus komentar di baris yang sama dengan value.

**`balance too low`** → top up wallet di Base (bridge/Coinbase)

**Hash rate rendah** → naikin `GPU_BATCH`, tutup program lain yang pakai GPU

**`MULTI_GPU=true` tapi cuma 1 GPU jalan** → pastikan `clinfo -l` detect semua GPU. Kalau gak, fix OpenCL ICD registration.

---

## Disclaimer

⚠️ Use at your own risk. Private key lo gak pernah dikirim kemana-mana — semua local. Jangan commit `.env` atau `wallets.txt`.

## License

MIT — **KYYCODE**
