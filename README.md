# $NONCE GPU Miner

Multi-wallet PoW miner untuk **$NONCE** token di Base chain.
GPU OpenCL kernel (zero Python, zero compiler) — **~300 MH/s di RTX 3050 Laptop**.

Contract: [`0xE7bADd12bdf070e925A55A98c981f3aBAB4f20cc`](https://basescan.org/address/0xE7bADd12bdf070e925A55A98c981f3aBAB4f20cc)
Site: https://nonceagent8004.com

---

## Requirements

- **Node.js 20+** ([download](https://nodejs.org))
- **GPU NVIDIA / AMD / Intel** dengan driver terbaru (OpenCL.dll harus ada di `C:\Windows\System32\` — biasanya udah otomatis pas install GPU driver)
- **Git** ([download](https://git-scm.com))
- **ETH di Base** ≥ 0.001 ETH per wallet buat gas (gas Base murah parah, ~$0.001/tx)

Cek GPU kebaca atau gak:
```cmd
nvidia-smi
```

---

## Install

### 1. Clone repo

```cmd
git clone https://github.com/rizkypujir/nonce.git
cd nonce
```

### 2. Install dependencies

```cmd
npm install
```

### 3. Setup config

Copy file template:
```cmd
copy .env.example .env
copy wallets.txt.example wallets.txt
```

### 4. Edit `.env`

Buka pakai text editor, isi minimal:

```env
RPC_URL=https://mainnet.base.org
USE_GPU=true
DRY_RUN=false
```

**Recommended**: pakai RPC pribadi (Alchemy/QuickNode/Ankr) buat latency lebih rendah:
```env
RPC_URL=https://rpc.ankr.com/base/YOUR_API_KEY
```

### 5. Edit `wallets.txt`

Satu private key per baris. Hapus baris contoh, ganti dengan PK lo:

```
0xYOUR_PRIVATE_KEY_HERE_64_HEX_CHARS
```

⚠️ **Pastikan wallet udah punya minimal 0.001 ETH di Base mainnet**.

---

## Run

### Cek state contract dulu (gak mining):
```cmd
node src/index.js stats
```

Output bakal kayak gini:
```
Contract state:
  Total mints  : 7484
  Difficulty   : 2^218.0
  Block        : 46209525
  Epoch        : 77015
  Genesis      : ✓ complete (mining live)
1 wallet(s) loaded
```

### Bench GPU lo dulu (optional):
```cmd
node src/gpu/test-bench.js
```

Expected hash rate:
- RTX 3050 Laptop: ~300 MH/s
- RTX 4060: ~700 MH/s
- RTX 4090: ~3 GH/s
- AMD RX 7900: ~2 GH/s
- CPU fallback (i5-12500H): ~720 KH/s (400x lebih lambat)

### Mulai mining:
```cmd
node src/index.js mine
```

Output:
```
[w1] 0x3F8f997E... balance=0.00268 ETH
⛏  [w1] epoch 77015 GPU NVIDIA GeForce RTX 3050 Laptop GPU (16 CUs) (diff 2^218.0)...
   [w1] 620.8M tries · 308.4 MH/s · 2s
   [w1] 1241.5M tries · 309.1 MH/s · 4s
   ...
✓ [w1] FOUND nonce after 18000.5M hashes in 60s @ 300 MH/s
📤 [w1] submitting tx... ✓ 0x1a2b3c4d5e6f...
   https://basescan.org/tx/0x1a2b3c4d5e6f...
```

`Ctrl+C` untuk stop.

---

## Config Tweaks

Edit `.env`:

| Variable | Default | Function |
|---|---|---|
| `USE_GPU` | `true` | `false` = pakai CPU 14 thread |
| `GPU_BATCH` | `4194304` | Nonces per kernel launch (4M). 8M kalau GPU lo ≥8GB VRAM |
| `GAS_MULTIPLIER` | `1.2` | Multiplier base fee (1.0 = bare minimum, 2.0 = aggressive) |
| `PRIORITY_GWEI` | `0.01` | Tip — naikin kalau lambat confirm |
| `MAX_GAS_GWEI` | `5` | Cap total gas (Base biasanya <0.1 gwei) |
| `PARALLEL_WORKERS` | `1` | Wallet parallel — biarin 1 (GPU shared, gak ada gunanya parallel) |
| `WORKER_THREADS` | `14` | CPU thread count (kalau USE_GPU=false) |
| `TARGET_MINTS_PER_WALLET` | `0` | 0 = unlimited, >0 = stop setelah N successful |
| `DRY_RUN` | `false` | `true` = simulate, gak broadcast |

---

## Multi-Wallet

Tambah private key di `wallets.txt`:
```
0xWALLET1_PRIVATE_KEY
0xWALLET2_PRIVATE_KEY
0xWALLET3_PRIVATE_KEY
```

Setiap wallet punya **per-address challenge** (unstealable from mempool). Bakal mining giliran (1 GPU shared). Total reward = jumlah wallet × reward per wallet.

---

## Math

- Algoritma: `keccak256(abi.encode(challenge, nonce)) < currentDifficulty`
- Challenge: `keccak256(abi.encode(chainId, contract, miner, epoch))`
- Per-(miner, epoch) → unstealable
- Block cap: 10 mints/block
- Epoch: 600 blocks (~20 menit di Base)
- Reward halving tiap 100k mints (era)

Expected find time @ 300 MH/s:
- Diff 2^218 (current): **~15 menit avg**, range 5-45 min
- Diff 2^220: ~3-5 menit
- Diff 2^222: ~12-20 menit

---

## Troubleshooting

**`OpenCL.dll not loadable`** → install/update GPU driver:
- NVIDIA: https://www.nvidia.com/Download/index.aspx
- AMD: https://www.amd.com/en/support
- Intel: https://www.intel.com/content/www/us/en/download-center/home.html

**`No GPU device available`** → driver gak include OpenCL runtime. Reinstall driver lengkap.

**`balance too low`** → top up wallet di Base mainnet (bridge dari L1, Coinbase Base bridge, dll).

**RPC error 500** → ganti RPC. Free yang stabil:
- `https://mainnet.base.org`
- `https://base.llamarpc.com`
- `https://base-rpc.publicnode.com`

**Hash rate kecil (< 50 MH/s di GPU bagus)** → GPU lo lagi kepake program lain (browser, game). Tutup yang gak perlu.

---

## Files

```
src/
├── index.js          # CLI entry (stats, mine)
├── miner.js          # Wallet orchestrator + tx submit
├── hash.js           # Native CPU keccak (fallback)
├── worker.js         # CPU worker thread
├── rpc.js            # viem RPC pool with failover
├── config.js         # env loader, ABI, EPOCH_BLOCKS=600
└── gpu/
    ├── kernel.cl     # OpenCL keccak256 kernel (compiled at runtime)
    ├── gpuMiner.js   # OpenCL host code via koffi FFI
    ├── gpuWorker.js  # GPU mining loop wrapper
    └── test-bench.js # Hash rate benchmark
```

---

## Disclaimer

⚠️ **Use at your own risk**. Lo bertanggung jawab atas private key sendiri. Repo ini gak nyimpan/transmit PK ke server manapun — semua local. Tapi tetep:
- Jangan commit `.env` atau `wallets.txt`
- Jangan share screenshot terminal kalau ada PK keliatan
- Backup wallet di tempat aman

Mining gas burn nyata. Kalau diff naik gila-gilaan, biaya gas bisa lebih besar dari reward — pantau terus.

## License

MIT — author **KYYCODE**
