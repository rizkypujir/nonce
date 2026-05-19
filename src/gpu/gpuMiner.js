/**
 * gpuMiner.js — OpenCL GPU miner (zero-Python, zero-compiler)
 *
 * Uses koffi FFI to call OpenCL.dll directly.
 * Compiles keccak256 kernel at runtime, executes massive parallel nonce search.
 */

import koffi from 'koffi';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ----- OpenCL constants -----
const CL_DEVICE_TYPE_GPU            = 4n;
const CL_DEVICE_NAME                = 0x102B;
const CL_DEVICE_MAX_COMPUTE_UNITS   = 0x1002;
const CL_DEVICE_GLOBAL_MEM_SIZE     = 0x101F;
const CL_PROGRAM_BUILD_LOG          = 0x1183;
const CL_MEM_READ_ONLY              = 4n;
const CL_MEM_WRITE_ONLY             = 2n;
const CL_MEM_READ_WRITE             = 1n;
const CL_MEM_COPY_HOST_PTR          = 32n;
const CL_TRUE                       = 1;

let lib = null;
let cl  = null;

function bind() {
  if (cl) return cl;
  lib = koffi.load('OpenCL');
  cl = {
    GetPlatformIDs:   lib.func('clGetPlatformIDs',   'int', ['uint32', 'void *', '_Out_ uint32 *']),
    GetPlatformInfo:  lib.func('clGetPlatformInfo',  'int', ['void *', 'uint32', 'size_t', 'void *', '_Out_ size_t *']),
    GetDeviceIDs:     lib.func('clGetDeviceIDs',     'int', ['void *', 'uint64', 'uint32', 'void *', '_Out_ uint32 *']),
    GetDeviceInfo:    lib.func('clGetDeviceInfo',    'int', ['void *', 'uint32', 'size_t', 'void *', '_Out_ size_t *']),
    CreateContext:    lib.func('clCreateContext',    'void *', ['void *', 'uint32', 'void *', 'void *', 'void *', '_Out_ int *']),
    CreateCommandQueueWithProperties: lib.func('clCreateCommandQueueWithProperties', 'void *', ['void *', 'void *', 'void *', '_Out_ int *']),
    CreateBuffer:     lib.func('clCreateBuffer',     'void *', ['void *', 'uint64', 'size_t', 'void *', '_Out_ int *']),
    CreateProgramWithSource: lib.func('clCreateProgramWithSource', 'void *', ['void *', 'uint32', 'void *', 'void *', '_Out_ int *']),
    BuildProgram:     lib.func('clBuildProgram',     'int', ['void *', 'uint32', 'void *', 'string', 'void *', 'void *']),
    GetProgramBuildInfo: lib.func('clGetProgramBuildInfo', 'int', ['void *', 'void *', 'uint32', 'size_t', 'void *', '_Out_ size_t *']),
    CreateKernel:     lib.func('clCreateKernel',     'void *', ['void *', 'string', '_Out_ int *']),
    SetKernelArg:     lib.func('clSetKernelArg',     'int', ['void *', 'uint32', 'size_t', 'void *']),
    EnqueueNDRangeKernel: lib.func('clEnqueueNDRangeKernel', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *', 'void *', 'uint32', 'void *', 'void *']),
    EnqueueWriteBuffer: lib.func('clEnqueueWriteBuffer', 'int', ['void *', 'void *', 'uint32', 'size_t', 'size_t', 'void *', 'uint32', 'void *', 'void *']),
    EnqueueReadBuffer:  lib.func('clEnqueueReadBuffer',  'int', ['void *', 'void *', 'uint32', 'size_t', 'size_t', 'void *', 'uint32', 'void *', 'void *']),
    Finish:           lib.func('clFinish',           'int', ['void *']),
    Flush:            lib.func('clFlush',            'int', ['void *']),
    ReleaseMemObject: lib.func('clReleaseMemObject', 'int', ['void *']),
    ReleaseKernel:    lib.func('clReleaseKernel',    'int', ['void *']),
    ReleaseProgram:   lib.func('clReleaseProgram',   'int', ['void *']),
    ReleaseCommandQueue: lib.func('clReleaseCommandQueue', 'int', ['void *']),
    ReleaseContext:   lib.func('clReleaseContext',   'int', ['void *']),
  };
  return cl;
}

function check(rc, where) {
  if (rc !== 0) throw new Error(`OpenCL ${where}: error ${rc}`);
}

function getStringInfo(infoFn, handle, paramName) {
  const sz = [0n];
  let rc = infoFn(handle, paramName, 0, null, sz);
  if (rc !== 0) return `[err ${rc}]`;
  const buf = Buffer.alloc(Number(sz[0]));
  rc = infoFn(handle, paramName, buf.length, buf, null);
  if (rc !== 0) return `[err ${rc}]`;
  return buf.toString('utf8').replace(/\0+$/, '');
}

/**
 * Auto-pick the best NVIDIA/AMD GPU. Returns { platform, device, name }.
 */
export function pickBestDevice() {
  bind();
  const cnt = [0];
  let rc = cl.GetPlatformIDs(0, null, cnt);
  check(rc, 'GetPlatformIDs(count)');
  if (cnt[0] === 0) throw new Error('No OpenCL platforms');

  const platArr = koffi.alloc('void *', cnt[0]);
  rc = cl.GetPlatformIDs(cnt[0], platArr, null);
  check(rc, 'GetPlatformIDs(fetch)');
  const plats = koffi.decode(platArr, koffi.array('void *', cnt[0]));

  let best = null;
  let bestScore = -1;
  for (const plat of plats) {
    const dCnt = [0];
    rc = cl.GetDeviceIDs(plat, CL_DEVICE_TYPE_GPU, 0, null, dCnt);
    if (rc !== 0 || dCnt[0] === 0) continue;
    const devArr = koffi.alloc('void *', dCnt[0]);
    cl.GetDeviceIDs(plat, CL_DEVICE_TYPE_GPU, dCnt[0], devArr, null);
    const devs = koffi.decode(devArr, koffi.array('void *', dCnt[0]));
    for (const dev of devs) {
      const name = getStringInfo(cl.GetDeviceInfo, dev, CL_DEVICE_NAME);
      // Prefer NVIDIA > AMD > Intel; score by compute units
      const cuBuf = Buffer.alloc(4);
      cl.GetDeviceInfo(dev, CL_DEVICE_MAX_COMPUTE_UNITS, 4, cuBuf, null);
      const cu = cuBuf.readUInt32LE(0);
      let prio = 0;
      if (/nvidia|geforce|rtx|gtx/i.test(name)) prio = 1000;
      else if (/amd|radeon/i.test(name))        prio = 500;
      else if (/intel/i.test(name))             prio = 100;
      const score = prio + cu;
      if (score > bestScore) {
        bestScore = score;
        best = { platform: plat, device: dev, name, computeUnits: cu };
      }
    }
  }
  if (!best) throw new Error('No GPU device available');
  return best;
}

export class GPUMiner {
  constructor() {
    bind();
    this.ctx = null;
    this.queue = null;
    this.program = null;
    this.kernel = null;
    this.deviceName = '';
    this.computeUnits = 0;
    this.batchSize = 1024 * 1024; // 1M nonces per batch (can scale up)

    // Persistent buffers
    this.bufChallenge = null;
    this.bufDiff = null;
    this.bufFlag  = null;
    this.bufNonce = null;
    this.bufHash = null;
    this.hostFlagBuf  = Buffer.alloc(4);    // 1 uint32
    this.hostNonceBuf = Buffer.alloc(8);    // 1 ulong
    this.hostHashBuf  = Buffer.alloc(32);   // 4 ulongs
  }

  init() {
    const dev = pickBestDevice();
    this.deviceName = dev.name;
    this.computeUnits = dev.computeUnits;

    // Create context
    const errRef = [0];
    // device list is a buffer holding 1 pointer (cl_device_id)
    const devPtrBuf = Buffer.alloc(8);
    devPtrBuf.writeBigUInt64LE(BigInt(dev.device), 0);
    this.devicePtrBuf = devPtrBuf; // keep for later (BuildProgram)
    this.deviceAddr   = BigInt(dev.device);

    this.ctx = cl.CreateContext(null, 1, devPtrBuf, null, null, errRef);
    check(errRef[0], 'CreateContext');

    // Command queue — pass device handle (pointer) as direct argument.
    // koffi accepts BigInt for pointer args
    this.queue = cl.CreateCommandQueueWithProperties(this.ctx, dev.device, null, errRef);
    check(errRef[0], 'CreateCommandQueue');

    // Compile kernel
    const src = fs.readFileSync(path.join(__dirname, 'kernel.cl'), 'utf8');
    this._kernelSrcBuf = Buffer.from(src + '\0', 'utf8'); // keep alive
    const srcByteLen   = Buffer.byteLength(src, 'utf8');  // UTF-8 byte count, not JS char count

    // strings[] = pointer-array of length 1 → 8 bytes containing addr of source buffer
    const srcAddr = koffi.address(this._kernelSrcBuf);
    const srcArr = Buffer.alloc(8);
    srcArr.writeBigUInt64LE(BigInt(srcAddr), 0);
    // lengths[] = 1 size_t (in BYTES, not JS chars)
    const lenArr = Buffer.alloc(8);
    lenArr.writeBigUInt64LE(BigInt(srcByteLen), 0);

    this.program = cl.CreateProgramWithSource(this.ctx, 1, srcArr, lenArr, errRef);
    check(errRef[0], 'CreateProgramWithSource');

    const buildRc = cl.BuildProgram(this.program, 1, devPtrBuf, '-cl-mad-enable -cl-fast-relaxed-math', null, null);
    if (buildRc !== 0) {
      // get build log
      const sz = [0n];
      cl.GetProgramBuildInfo(this.program, dev.device, CL_PROGRAM_BUILD_LOG, 0, null, sz);
      const logBuf = Buffer.alloc(Number(sz[0]));
      cl.GetProgramBuildInfo(this.program, dev.device, CL_PROGRAM_BUILD_LOG, logBuf.length, logBuf, null);
      const log = logBuf.toString('utf8');
      throw new Error(`BuildProgram failed (rc=${buildRc}):\n${log}`);
    }

    this.kernel = cl.CreateKernel(this.program, 'mine', errRef);
    check(errRef[0], 'CreateKernel');

    // Allocate persistent buffers
    this.bufChallenge = cl.CreateBuffer(this.ctx, CL_MEM_READ_ONLY,  32n, null, errRef); check(errRef[0], 'CreateBuffer challenge');
    this.bufDiff      = cl.CreateBuffer(this.ctx, CL_MEM_READ_ONLY,  32n, null, errRef); check(errRef[0], 'CreateBuffer diff');
    this.bufFlag      = cl.CreateBuffer(this.ctx, CL_MEM_READ_WRITE,  4n, null, errRef); check(errRef[0], 'CreateBuffer flag');
    this.bufNonce     = cl.CreateBuffer(this.ctx, CL_MEM_WRITE_ONLY,  8n, null, errRef); check(errRef[0], 'CreateBuffer nonce');
    this.bufHash      = cl.CreateBuffer(this.ctx, CL_MEM_WRITE_ONLY, 32n, null, errRef); check(errRef[0], 'CreateBuffer hash');

    return { name: dev.name, computeUnits: dev.computeUnits };
  }

  /**
   * Set the challenge (32-byte Buffer) and difficulty (BigInt).
   * Call once per epoch.
   */
  setChallenge(challengeBuf, difficulty) {
    if (!Buffer.isBuffer(challengeBuf) || challengeBuf.length !== 32)
      throw new Error('challenge must be 32-byte Buffer');

    // Upload challenge as-is (4 lanes of LE uint64)
    let rc = cl.EnqueueWriteBuffer(this.queue, this.bufChallenge, CL_TRUE, 0n, 32n, challengeBuf, 0, null, null);
    check(rc, 'WriteBuffer challenge');

    // Pack difficulty as 4 BE-numeric uint64 (MSB first)
    const d = BigInt(difficulty);
    const diffBuf = Buffer.alloc(32);
    diffBuf.writeBigUInt64LE(d >> 192n & 0xFFFFFFFFFFFFFFFFn, 0);
    diffBuf.writeBigUInt64LE(d >> 128n & 0xFFFFFFFFFFFFFFFFn, 8);
    diffBuf.writeBigUInt64LE(d >>  64n & 0xFFFFFFFFFFFFFFFFn, 16);
    diffBuf.writeBigUInt64LE(d         & 0xFFFFFFFFFFFFFFFFn, 24);

    rc = cl.EnqueueWriteBuffer(this.queue, this.bufDiff, CL_TRUE, 0n, 32n, diffBuf, 0, null, null);
    check(rc, 'WriteBuffer diff');
  }

  /**
   * Run one batch. Returns { found, nonce, attempts, ms }.
   */
  runBatch(startNonce) {
    // Clear flag buffer (atomic flag = 0)
    const zero4 = Buffer.alloc(4);
    let rc = cl.EnqueueWriteBuffer(this.queue, this.bufFlag, CL_TRUE, 0n, 4n, zero4, 0, null, null);
    check(rc, 'WriteBuffer flag-reset');

    // Bind args
    function memArg(memHandle) {
      const b = Buffer.alloc(8);
      // memHandle is a bigint pointer value (koffi v3) — write directly
      b.writeBigUInt64LE(BigInt(memHandle), 0);
      return b;
    }

    rc = cl.SetKernelArg(this.kernel, 0, 8n, memArg(this.bufChallenge)); check(rc, 'SetKernelArg 0');
    rc = cl.SetKernelArg(this.kernel, 1, 8n, memArg(this.bufDiff));      check(rc, 'SetKernelArg 1');

    const nonceArg = Buffer.alloc(8);
    nonceArg.writeBigUInt64LE(BigInt(startNonce), 0);
    rc = cl.SetKernelArg(this.kernel, 2, 8n, nonceArg);                  check(rc, 'SetKernelArg 2');

    rc = cl.SetKernelArg(this.kernel, 3, 8n, memArg(this.bufFlag));      check(rc, 'SetKernelArg 3');
    rc = cl.SetKernelArg(this.kernel, 4, 8n, memArg(this.bufNonce));     check(rc, 'SetKernelArg 4');
    rc = cl.SetKernelArg(this.kernel, 5, 8n, memArg(this.bufHash));      check(rc, 'SetKernelArg 5');

    // Launch
    const globalSize = Buffer.alloc(8);
    globalSize.writeBigUInt64LE(BigInt(this.batchSize), 0);
    const localSize = Buffer.alloc(8);
    localSize.writeBigUInt64LE(256n, 0);

    const t0 = Date.now();
    rc = cl.EnqueueNDRangeKernel(this.queue, this.kernel, 1, null, globalSize, localSize, 0, null, null);
    check(rc, 'EnqueueNDRangeKernel');

    rc = cl.Finish(this.queue);
    check(rc, 'Finish');

    // Read flag
    rc = cl.EnqueueReadBuffer(this.queue, this.bufFlag, CL_TRUE, 0n, 4n, this.hostFlagBuf, 0, null, null);
    check(rc, 'ReadBuffer flag');

    const ms = Date.now() - t0;
    const flag = this.hostFlagBuf.readUInt32LE(0);
    if (flag === 1) {
      cl.EnqueueReadBuffer(this.queue, this.bufNonce, CL_TRUE, 0n, 8n,  this.hostNonceBuf, 0, null, null);
      cl.EnqueueReadBuffer(this.queue, this.bufHash,  CL_TRUE, 0n, 32n, this.hostHashBuf,  0, null, null);
      const winNonce = this.hostNonceBuf.readBigUInt64LE(0);
      const h0 = this.hostHashBuf.readBigUInt64LE(0);
      const h1 = this.hostHashBuf.readBigUInt64LE(8);
      const h2 = this.hostHashBuf.readBigUInt64LE(16);
      const h3 = this.hostHashBuf.readBigUInt64LE(24);
      const target = (h0 << 192n) | (h1 << 128n) | (h2 << 64n) | h3;
      return { found: true, nonce: winNonce, target, attempts: this.batchSize, ms };
    }
    return { found: false, attempts: this.batchSize, ms };
  }

  destroy() {
    try { if (this.bufChallenge) cl.ReleaseMemObject(this.bufChallenge); } catch {}
    try { if (this.bufDiff)      cl.ReleaseMemObject(this.bufDiff);      } catch {}
    try { if (this.bufFlag)      cl.ReleaseMemObject(this.bufFlag);      } catch {}
    try { if (this.bufNonce)     cl.ReleaseMemObject(this.bufNonce);     } catch {}
    try { if (this.bufHash)      cl.ReleaseMemObject(this.bufHash);      } catch {}
    try { if (this.kernel)       cl.ReleaseKernel(this.kernel);          } catch {}
    try { if (this.program)      cl.ReleaseProgram(this.program);        } catch {}
    try { if (this.queue)        cl.ReleaseCommandQueue(this.queue);     } catch {}
    try { if (this.ctx)          cl.ReleaseContext(this.ctx);            } catch {}
  }
}

/**
 * Build the challenge bytes (32) for a given (chainId, contract, miner, epoch).
 * Identical to hash.js challenge derivation, but exposed for GPU host code.
 */
import keccak from 'keccak';
export function buildChallenge(chainId, contractAddr, minerAddr, epoch) {
  // Solidity abi.encode → each arg padded to 32 bytes = 128 bytes total
  const inner = Buffer.alloc(128);
  const chainHex = BigInt(chainId).toString(16).padStart(64, '0');
  inner.write(chainHex, 0, 32, 'hex');
  const cAddr = contractAddr.toLowerCase().replace(/^0x/, '').padStart(40, '0');
  inner.write(cAddr.padStart(64, '0'), 32, 32, 'hex');
  const mAddr = minerAddr.toLowerCase().replace(/^0x/, '').padStart(40, '0');
  inner.write(mAddr.padStart(64, '0'), 64, 32, 'hex');
  const epochHex = BigInt(epoch).toString(16).padStart(64, '0');
  inner.write(epochHex, 96, 32, 'hex');
  return keccak('keccak256').update(inner).digest();
}
