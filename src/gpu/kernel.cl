// OpenCL kernel: keccak256 PoW for $NONCE
//
// Input:
//   challenge[4]  -- bytes32 challenge as 4x ulong (LE lane order = native state words)
//   diff_be[4]    -- difficulty as 4x ulong, each lane = 8 bytes of diff in BE-numeric order
//                   (so direct unsigned compare lane-by-lane works)
//   start_nonce   -- base nonce for this batch (uint64)
//   result        -- output buffer: [winning_nonce_lo, winning_nonce_hi, target_hi_be]
//                   sentinel = ulong_max = no result
//
// Each work-item: nonce = start_nonce + get_global_id(0)
// hash = keccak256(challenge[0..31] || nonce_be_uint256[0..31])
// target_be < diff_be → atomic claim result.

#define ROTL64(x, n) (((x) << (n)) | ((x) >> (64 - (n))))

__constant ulong RC[24] = {
    0x0000000000000001UL, 0x0000000000008082UL, 0x800000000000808AUL, 0x8000000080008000UL,
    0x000000000000808BUL, 0x0000000080000001UL, 0x8000000080008081UL, 0x8000000000008009UL,
    0x000000000000008AUL, 0x0000000000000088UL, 0x0000000080008009UL, 0x000000008000000AUL,
    0x000000008000808BUL, 0x800000000000008BUL, 0x8000000000008089UL, 0x8000000000008003UL,
    0x8000000000008002UL, 0x8000000000000080UL, 0x000000000000800AUL, 0x800000008000000AUL,
    0x8000000080008081UL, 0x8000000000008080UL, 0x0000000080000001UL, 0x8000000080008008UL
};

__constant uint ROTC[24] = {
     1,  3,  6, 10, 15, 21, 28, 36, 45, 55,  2, 14,
    27, 41, 56,  8, 25, 43, 62, 18, 39, 61, 20, 44
};

__constant uint PILN[24] = {
    10,  7, 11, 17, 18,  3,  5, 16,  8, 21, 24,  4,
    15, 23, 19, 13, 12,  2, 20, 14, 22,  9,  6,  1
};

inline void keccakf(ulong* st) {
    ulong bc[5];
    ulong t;
    for (int r = 0; r < 24; r++) {
        // Theta
        for (int i = 0; i < 5; i++)
            bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
        for (int i = 0; i < 5; i++) {
            t = bc[(i + 4) % 5] ^ ROTL64(bc[(i + 1) % 5], 1);
            for (int j = 0; j < 25; j += 5) st[j + i] ^= t;
        }
        // Rho + Pi
        t = st[1];
        for (int i = 0; i < 24; i++) {
            uint j = PILN[i];
            bc[0] = st[j];
            st[j] = ROTL64(t, ROTC[i]);
            t = bc[0];
        }
        // Chi
        for (int j = 0; j < 25; j += 5) {
            ulong t0 = st[j];
            ulong t1 = st[j + 1];
            ulong t2 = st[j + 2];
            ulong t3 = st[j + 3];
            ulong t4 = st[j + 4];
            st[j    ] ^= (~t1) & t2;
            st[j + 1] ^= (~t2) & t3;
            st[j + 2] ^= (~t3) & t4;
            st[j + 3] ^= (~t4) & t0;
            st[j + 4] ^= (~t0) & t1;
        }
        // Iota
        st[0] ^= RC[r];
    }
}

// byteswap 64-bit
inline ulong bswap64(ulong x) {
    x = ((x & 0x00000000FFFFFFFFUL) << 32) | ((x >> 32) & 0x00000000FFFFFFFFUL);
    x = ((x & 0x0000FFFF0000FFFFUL) << 16) | ((x >> 16) & 0x0000FFFF0000FFFFUL);
    x = ((x & 0x00FF00FF00FF00FFUL) <<  8) | ((x >>  8) & 0x00FF00FF00FF00FFUL);
    return x;
}

__kernel void mine(
    __global const ulong* challenge,    // 4 lanes (state-order)
    __global const ulong* diff_be,      // 4 lanes (BE-numeric order, MSB-first)
    const ulong start_nonce,
    __global uint* result_flag,          // [0]=found-flag (0/1), atomic
    __global ulong* result_nonce,        // [0]=winning nonce
    __global ulong* result_hash         // 4 lanes: target in BE-numeric order
) {
    ulong gid = (ulong)get_global_id(0);
    ulong nonce = start_nonce + gid;

    ulong st[25];
    // absorb 64-byte input into first 8 lanes
    st[0] = challenge[0];
    st[1] = challenge[1];
    st[2] = challenge[2];
    st[3] = challenge[3];
    // nonce occupies bytes 32..63 in BE-uint256 form
    // For nonce that fits in 64 bits: bytes[32..55]=0, bytes[56..63] = nonce_be8.
    // Lane[7] (bytes 56..63 read LE) = bswap64(nonce).
    st[4] = 0UL;
    st[5] = 0UL;
    st[6] = 0UL;
    st[7] = bswap64(nonce);
    // pad: byte 64 = 0x01, byte 135 = 0x80
    st[8]  = 0x0000000000000001UL;
    st[9]  = 0UL; st[10] = 0UL; st[11] = 0UL; st[12] = 0UL;
    st[13] = 0UL; st[14] = 0UL; st[15] = 0UL;
    st[16] = 0x8000000000000000UL;
    st[17] = 0UL; st[18] = 0UL; st[19] = 0UL;
    st[20] = 0UL; st[21] = 0UL; st[22] = 0UL; st[23] = 0UL; st[24] = 0UL;

    keccakf(st);

    // target_be[0] = bswap64(st[0])  (most significant 64 bits of hash)
    // Compare lane-by-lane. Most random hashes fail at lane 0.
    ulong t0 = bswap64(st[0]);
    ulong d0 = diff_be[0];
    if (t0 > d0) return;
    if (t0 == d0) {
        ulong t1 = bswap64(st[1]);
        ulong d1 = diff_be[1];
        if (t1 > d1) return;
        if (t1 == d1) {
            ulong t2 = bswap64(st[2]);
            ulong d2 = diff_be[2];
            if (t2 > d2) return;
            if (t2 == d2) {
                ulong t3 = bswap64(st[3]);
                ulong d3 = diff_be[3];
                if (t3 >= d3) return;
            }
        }
    }
    // FOUND. Atomic claim using 32-bit atomic -- first finder wins.
    if (atomic_cmpxchg(result_flag, 0u, 1u) == 0u) {
        result_nonce[0] = nonce;
        result_hash[0] = bswap64(st[0]);
        result_hash[1] = bswap64(st[1]);
        result_hash[2] = bswap64(st[2]);
        result_hash[3] = bswap64(st[3]);
    }
}
