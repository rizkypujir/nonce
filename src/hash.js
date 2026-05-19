/**
 * hash.js — Fast keccak256 using native C++ binding
 *
 * Replaces viem's pure-JS keccak with native module.
 * Speedup: 5-10x on x64 Windows/Linux.
 */

import keccak from 'keccak';

/**
 * Fast keccak256 of a Buffer or hex bytes.
 * @param {Buffer} buf
 * @returns {Buffer} 32-byte digest
 */
export function fastKeccak256(buf) {
  return keccak('keccak256').update(buf).digest();
}

/**
 * Pre-encode the challenge prefix (chainId + contract + miner + epoch) once,
 * then for each nonce only hash (challenge_hash || nonce_be32).
 *
 * Returns a function that takes nonce (BigInt) and returns target (BigInt).
 */
export function makeChallengeHasher(chainId, contractAddr, minerAddr, epoch) {
  // Solidity uses abi.encode (NOT encodePacked) → each arg padded to 32 bytes
  // Layout: chainId(32) + contract(32, left-padded) + miner(32, left-padded) + epoch(32) = 128 bytes
  const inner = Buffer.alloc(128);

  // chainId (uint256, 32 bytes BE)
  const chainHex = BigInt(chainId).toString(16).padStart(64, '0');
  inner.write(chainHex, 0, 32, 'hex');

  // contract (address padded to 32 bytes, address occupies last 20 bytes)
  const cAddr = contractAddr.toLowerCase().replace(/^0x/, '').padStart(40, '0');
  inner.write(cAddr.padStart(64, '0'), 32, 32, 'hex');

  // miner (address padded to 32 bytes)
  const mAddr = minerAddr.toLowerCase().replace(/^0x/, '').padStart(40, '0');
  inner.write(mAddr.padStart(64, '0'), 64, 32, 'hex');

  // epoch (uint256, 32 bytes BE)
  const epochHex = BigInt(epoch).toString(16).padStart(64, '0');
  inner.write(epochHex, 96, 32, 'hex');

  // Compute challenge = keccak256(inner)
  const challenge = fastKeccak256(inner);

  // Outer hash: keccak256(abi.encode(challenge, nonce))
  // Layout: challenge(32) + nonce(32) = 64 bytes
  const outerBuf = Buffer.alloc(64);
  challenge.copy(outerBuf, 0);

  /**
   * Given a nonce (BigInt), compute target (BigInt).
   */
  return function tryNonce(nonce) {
    // Write nonce as uint256 big-endian into bytes 32-63
    let n = BigInt(nonce);
    for (let i = 63; i >= 32; i--) {
      outerBuf[i] = Number(n & 0xffn);
      n >>= 8n;
    }

    const out = fastKeccak256(outerBuf);

    // Convert 32-byte digest to BigInt
    let result = 0n;
    for (let i = 0; i < 32; i++) {
      result = (result << 8n) | BigInt(out[i]);
    }
    return result;
  };
}
