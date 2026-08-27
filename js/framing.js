'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// FRAME BUILDING AND PARSING
//
// Frame format (42 bits, padded to 48 = 6 symbols):
//   SYNC (7)  |  SEQ (1)  |  Hamming_codeword (30)  |  END (4)  |  padding (6 zeros)
//
// SEQ is a 1-bit alternating sequence number (stop-and-wait style). It lets the
// receiver recognize a retransmitted frame (e.g. the sender re-showed the frame
// because our final ACK was lost) and avoid decoding/displaying it twice.
//
// Hamming data block (25 bits):
//   LENGTH (5 bits, MSB first, value = L ≤ 20)  |  PAYLOAD (20 bits, zero-padded)
//
// Color encoding per cell (2 bits → color):
//   00 = WHITE  (#FFFFFF)
//   01 = RED    (#FF0000)
//   10 = GREEN  (#00FF00)
//   11 = BLUE   (#0000FF)
//
// One symbol = 8 bits = 4 cells (raster order TL TR BL BR, MSB first per cell).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    const SYNC = Object.freeze([1,1,1,0,0,1,0]);  // 7 bits (Barker-like)
    const END  = Object.freeze([0,1,1,1]);          // 4 bits
    const FRAME_BITS   = 42;                        // 7 (SYNC) + 1 (SEQ) + 30 (codeword) + 4 (END)
    const PADDED_BITS  = 48;                        // 6 symbols × 8 bits
    const NUM_SYMBOLS  = 6;
    const COLOR_NAMES  = Object.freeze(['WHITE', 'RED', 'GREEN', 'BLUE']);
    const COLOR_HEX    = Object.freeze(['#FFFFFF', '#FF0000', '#00FF00', '#0000FF']);

    /** Build a 48-bit frame (as a bit array) from a message.
     *  @param {number[]} messageBits      – Array of L bits (L ≤ 20)
     *  @param {number|null} errorMsgBit   – 0-indexed bit to flip AFTER encoding, or null
     *  @param {number} seq                – 1-bit alternating sequence number (0 or 1)
     *  @returns {number[]}                – 48 bits (6 symbols worth)
     */
    function buildFrame(messageBits, errorMsgBit = null, seq = 0) {
        const L = messageBits.length;
        if (L > 20) throw new Error('Message exceeds 20 bits');

        // 5-bit length field, MSB first
        const lenBits = [];
        for (let i = 4; i >= 0; i--) lenBits.push((L >> i) & 1);

        // 20-bit payload: message left-justified, zero-padded on right
        const payload = [...messageBits, ...new Array(20 - L).fill(0)];

        // Hamming encode the 25-bit data block
        let codeword = Hamming.encode([...lenBits, ...payload]);

        // Inject simulated error (spec: after encoding, before transmission)
        codeword = Hamming.injectError(codeword, errorMsgBit);

        // Assemble: SYNC | SEQ | codeword | END | padding
        const frame = [
            ...SYNC,          // 7 bits
            (seq & 1),        // 1 bit
            ...codeword,      // 30 bits
            ...END,           // 4 bits
            ...new Array(PADDED_BITS - FRAME_BITS).fill(0),  // 6 padding bits
        ];
        return frame;  // 48 bits
    }

    /** Convert a 48-bit frame into 6 symbols.
     *  Each symbol is an array of 4 color indices [TL, TR, BL, BR] ∈ {0,1,2,3}.
     *  @param {number[]} bits48  – Output of buildFrame()
     *  @returns {number[][]}
     */
    function bitsToSymbols(bits48) {
        const symbols = [];
        for (let s = 0; s < NUM_SYMBOLS; s++) {
            const cells = [];
            for (let c = 0; c < 4; c++) {
                const base = s * 8 + c * 2;
                cells.push((bits48[base] << 1) | bits48[base + 1]);
            }
            symbols.push(cells);
        }
        return symbols;
    }

    /** Search bitBuf for a valid SYNC..END frame and decode it.
     *  Performs a sliding-window search (not just at symbol boundaries).
     *  @param {number[]} bitBuf  – Accumulated received bits (may be longer than 1 frame)
     *  @returns {{ messageBits: number[], L: number,
     *              errorDataIdx: number|null, errorMsgBitIdx: number|null,
     *              startPos: number } | null}
     *    errorMsgBitIdx – 0-indexed position in the original message of a corrected bit,
     *                     or null (no error / parity-only error)
     */
    function parseFrame(bitBuf) {
        const syncStr = SYNC.join('');
        const endStr  = END.join('');
        const need    = FRAME_BITS;

        for (let i = 0; i <= bitBuf.length - need; i++) {
            // Check SYNC
            if (bitBuf.slice(i, i + 7).join('') !== syncStr) continue;

            // SEQ bit sits right after SYNC
            const seq = bitBuf[i + 7];

            // Check END (shifted by 1 to make room for SEQ)
            const endSlice = bitBuf.slice(i + 38, i + 42);
            if (endSlice.join('') !== endStr) continue;

            // Hamming decode
            const codeword = bitBuf.slice(i + 8, i + 38);
            const r = Hamming.decode(codeword);

            // Decode length field
            let L = 0;
            for (const b of r.lengthBits) L = (L << 1) | b;
            if (L < 1 || L > 20) continue; // invalid — keep searching

            // errorDataIdx: -1=parity, 0-4=length, 5-24=payload
            // errorMsgBitIdx: maps payload errors (dataIdx 5..24) to message bit (0..L-1)
            const eMsgBit = (r.errorDataIdx !== null && r.errorDataIdx >= 5)
                ? r.errorDataIdx - 5
                : null;

            return {
                messageBits:    r.payloadBits.slice(0, L),
                L,
                seq,
                errorDataIdx:   r.errorDataIdx,
                errorMsgBitIdx: eMsgBit,
                startPos:       i,
            };
        }
        return null;
    }

    window.Framing = {
        buildFrame, bitsToSymbols, parseFrame,
        SYNC, END, FRAME_BITS, PADDED_BITS, NUM_SYMBOLS,
        COLOR_NAMES, COLOR_HEX,
    };
})();
