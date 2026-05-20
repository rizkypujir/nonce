#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  $NONCE Miner — One-click VPS Setup
#  Supports: Ubuntu/Debian, NVIDIA/AMD GPU, fresh VPS
#  Run: bash setup.sh
# ═══════════════════════════════════════════════════════════

# Don't exit on error — handle failures gracefully
set +e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
GRAY='\033[0;90m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
skip() { echo -e "${GRAY}[~] $1 (already installed)${NC}"; }

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  \$NONCE GPU Miner — Auto Setup${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo ""

# ─── 1. System update ──────────────────────────────────────
echo -e "${YELLOW}[1/7] System packages...${NC}"
if command -v apt &>/dev/null; then
  apt-get update -qq || true
  apt-get install -y curl wget git build-essential ca-certificates || true
  log "apt packages ready"
elif command -v yum &>/dev/null; then
  yum install -y curl wget git gcc gcc-c++ make ca-certificates || true
  log "yum packages ready"
else
  warn "Unknown package manager — skipping system packages"
fi

# ─── 2. Node.js ───────────────────────────────────────────
echo ""
echo -e "${YELLOW}[2/7] Node.js...${NC}"
if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  NODE_MAJOR=$(echo $NODE_VER | cut -d. -f1 | tr -d 'v')
  if [ "$NODE_MAJOR" -ge 20 ]; then
    skip "Node.js $NODE_VER"
  else
    warn "Node.js $NODE_VER too old, upgrading..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>/dev/null
    apt-get install -y -qq nodejs 2>/dev/null
    log "Node.js $(node --version) installed"
  fi
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>/dev/null
  apt-get install -y -qq nodejs 2>/dev/null
  log "Node.js $(node --version) installed"
fi

# ─── 3. GPU Driver detection ──────────────────────────────
echo ""
echo -e "${YELLOW}[3/7] GPU driver...${NC}"
GPU_TYPE="none"

if command -v nvidia-smi &>/dev/null; then
  GPU_TYPE="nvidia"
  DRIVER_VER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
  GPU_COUNT=$(nvidia-smi --query-gpu=name --format=csv,noheader | wc -l)
  skip "NVIDIA driver $DRIVER_VER ($GPU_COUNT× $GPU_NAME)"
elif lspci 2>/dev/null | grep -qi nvidia; then
  GPU_TYPE="nvidia"
  warn "NVIDIA GPU detected but driver not installed"
  echo "  Installing NVIDIA driver..."
  apt-get install -y -qq nvidia-driver-570 2>/dev/null || apt-get install -y -qq nvidia-driver-535 2>/dev/null
  log "NVIDIA driver installed (reboot may be needed)"
elif lspci 2>/dev/null | grep -qi amd; then
  GPU_TYPE="amd"
  skip "AMD GPU detected"
fi

if [ "$GPU_TYPE" = "none" ]; then
  warn "No GPU detected — will use CPU only"
fi

# ─── 4. OpenCL runtime ────────────────────────────────────
echo ""
echo -e "${YELLOW}[4/7] OpenCL runtime...${NC}"

if [ -f /usr/lib/x86_64-linux-gnu/libOpenCL.so.1 ] || [ -f /usr/lib64/libOpenCL.so.1 ]; then
  skip "libOpenCL.so.1"
else
  apt-get install -y -qq ocl-icd-libopencl1 ocl-icd-opencl-dev 2>/dev/null
  log "OpenCL loader installed"
fi

# Register NVIDIA ICD if needed
if [ "$GPU_TYPE" = "nvidia" ]; then
  if [ ! -f /etc/OpenCL/vendors/nvidia.icd ]; then
    mkdir -p /etc/OpenCL/vendors
    echo "libnvidia-opencl.so.1" | tee /etc/OpenCL/vendors/nvidia.icd >/dev/null
    log "NVIDIA OpenCL ICD registered"
  else
    skip "NVIDIA ICD"
  fi

  # Install libnvidia-compute if missing
  if ! ldconfig -p 2>/dev/null | grep -q libnvidia-opencl; then
    DRIVER_PKG=$(dpkg -l | grep -oP 'nvidia-driver-\d+' | head -1 | sed 's/driver/compute/')
    if [ -n "$DRIVER_PKG" ]; then
      apt-get install -y -qq "$DRIVER_PKG" 2>/dev/null
    else
      apt-get install -y -qq libnvidia-compute-570 2>/dev/null || apt-get install -y -qq libnvidia-compute-535 2>/dev/null
    fi
    log "libnvidia-compute installed"
  else
    skip "libnvidia-compute"
  fi
fi

# AMD OpenCL
if [ "$GPU_TYPE" = "amd" ]; then
  if ! ldconfig -p 2>/dev/null | grep -q libMesaOpenCL; then
    apt-get install -y -qq mesa-opencl-icd 2>/dev/null
    log "AMD Mesa OpenCL installed"
  else
    skip "AMD OpenCL"
  fi
fi

# Verify OpenCL
echo ""
if command -v clinfo &>/dev/null; then
  DEVICES=$(clinfo -l 2>/dev/null | grep -c "Device" || echo "0")
  if [ "$DEVICES" -gt 0 ]; then
    log "OpenCL: $DEVICES device(s) detected"
    clinfo -l 2>/dev/null | head -10
  else
    warn "OpenCL installed but no devices found (driver issue?)"
  fi
else
  apt-get install -y -qq clinfo 2>/dev/null
  clinfo -l 2>/dev/null | head -10 || warn "clinfo failed"
fi

# ─── 5. npm install ───────────────────────────────────────
echo ""
echo -e "${YELLOW}[5/7] npm dependencies...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  skip "node_modules"
else
  npm install --no-audit --no-fund 2>/dev/null
  log "npm install done"
fi

# ─── 6. .env setup ───────────────────────────────────────
echo ""
echo -e "${YELLOW}[6/7] Config (.env)...${NC}"
if [ ! -f .env ]; then
  cp .env.example .env
  log ".env created from .env.example"
else
  skip ".env exists"
fi

# ─── 7. wallets.txt ──────────────────────────────────────
echo ""
echo -e "${YELLOW}[7/7] Wallets...${NC}"
if [ ! -f wallets.txt ]; then
  cp wallets.txt.example wallets.txt
  warn "wallets.txt created — EDIT THIS: add your private key(s)"
else
  WALLET_COUNT=$(grep -c "^0x" wallets.txt 2>/dev/null || echo "0")
  if [ "$WALLET_COUNT" -gt 0 ]; then
    skip "wallets.txt ($WALLET_COUNT wallet(s))"
  else
    warn "wallets.txt exists but empty — add private key(s)"
  fi
fi

# ─── Done ─────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Setup complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${GRAY}Next steps:${NC}"
echo -e "  1. Edit wallets.txt (add private key)"
echo -e "  2. node src/index.js stats   ${GRAY}← verify${NC}"
echo -e "  3. node src/index.js mine    ${GRAY}← start mining${NC}"
echo ""
