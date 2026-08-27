'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// MAIN — Stop-and-Wait ARQ with adaptive (RTT-estimated) timing + SEQ numbers
//
// SENDER protocol:
//   1. Show calibration frame → wait for READY tone from receiver.
//   2. Encode message into 6 symbols (frame carries a 1-bit alternating SEQ).
//   3. For each symbol (0..5):
//      - Display symbol.
//      - Wait for ACK. There is no fixed timeout — the deadline is derived from
//        a running estimate of the round-trip time (symbol shown → ACK heard),
//        so it self-adjusts to how fast/slow the acoustic link actually is.
//      - ACK in time → small gap → show next symbol.
//      - No ACK in time → assume the link dropped a tone → restart from
//        calibration (retransmitting the *same* frame, SEQ unchanged, error
//        bit re-injected the same way — nothing about the message changes).
//   4. The ACK for the LAST symbol doubles as the receiver's "I decoded this
//      frame successfully" signal — there is no separate final-ACK phase.
//      A NACK at that point means the receiver's decode failed → restart.
//   5. Only once the whole frame is acknowledged does the sender flip its SEQ
//      bit, so a retransmit of the same message keeps the same SEQ.
//
// RECEIVER protocol:
//   1. After calibration → send READY → enter LISTEN (also starts measuring
//      RTT from the moment READY is sent to the first symbol received).
//   2. On each new symbol: accumulate bits.
//      - If we don't yet have all 6 symbols → ACK it and restart a
//        re-ACK interval (based on the estimated RTT) that keeps re-sending
//        our last ACK in case the sender never heard it.
//      - Once all 48 bits are in, try to parse the frame:
//          - Parse fails → send NACK, go back to LISTEN.
//          - Parse succeeds and SEQ matches the last frame we already
//            decoded → this is a duplicate (our previous final ACK was
//            lost) → just re-ACK, don't re-display the result.
//          - Parse succeeds and it's a new SEQ → show the result, ACK it,
//            remember the SEQ.
//   3. If nothing decodes within an overall (RTT-derived) listen timeout,
//      give up and send a final NACK.
// ─────────────────────────────────────────────────────────────────────────────
(function () {

    // ── Small helper utilities ────────────────────────────────────────────────

    function show(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(id).classList.add('active');
    }

    function log(panelId, msg, type) {
        const el = document.getElementById(panelId);
        if (!el) return;
        const line = document.createElement('div');
        line.className = 'log-line' + (type ? ' ' + type : '');
        const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        line.textContent = '[' + ts + '] ' + msg;
        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
        // Keep log from growing forever
        while (el.children.length > 80) el.removeChild(el.firstChild);
    }

    function setBadge(id, text, type) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = text;
        el.className   = 'status-badge ' + (type || 'idle');
    }

    function setDot(dotId, stateId, ok, label) {
        const dot = document.getElementById(dotId);
        const st  = document.getElementById(stateId);
        if (dot) dot.className = 'sys-dot ' + (ok === null ? 'loading' : ok ? 'ok' : 'fail');
        if (st)  st.textContent = label;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  HOME — permissions + OpenCV status
    // ═══════════════════════════════════════════════════════════════════════════
    let _permGranted = false, _cvOk = false;

    function checkUnlock() {
        const ready = _permGranted && _cvOk;
        document.getElementById('btn-role-sender').disabled   = !ready;
        document.getElementById('btn-role-receiver').disabled = !ready;
        if (ready) document.getElementById('perm-gate').classList.add('hidden');
    }

    function initCvStatus() {
        setDot('cv-dot', 'cv-state', null, 'loading');
        if (window._cvReady) {
            _cvOk = true;
            setDot('cv-dot', 'cv-state', true, 'ready');
            checkUnlock();
        }
        document.addEventListener('opencv-ready', () => {
            _cvOk = true;
            setDot('cv-dot', 'cv-state', true, 'ready');
            checkUnlock();
        });
        // Fallback poll in case the event already fired before we registered
        const poll = setInterval(() => {
            if (window._cvReady) {
                clearInterval(poll);
                if (!_cvOk) {
                    _cvOk = true;
                    setDot('cv-dot', 'cv-state', true, 'ready');
                    checkUnlock();
                }
            }
        }, 500);
    }

    document.getElementById('btn-grant-perms').onclick = async () => {
        const btn  = document.getElementById('btn-grant-perms');
        const hint = document.getElementById('perm-hint');
        btn.disabled = true;
        btn.textContent = 'Requesting…';
        hint.textContent = '';

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            stream.getTracks().forEach(t => t.stop());
            setDot('cam-dot', 'cam-state', true, 'granted');
            setDot('mic-dot', 'mic-state', true, 'granted');
            _permGranted = true;
            hint.textContent = 'Permissions granted';
            hint.style.color = 'var(--success)';
            checkUnlock();
        } catch (e) {
            // Try individually
            let camOk = false, micOk = false;
            try { const cs = await navigator.mediaDevices.getUserMedia({ video: true }); cs.getTracks().forEach(t => t.stop()); camOk = true; } catch (_) {}
            try { const ms = await navigator.mediaDevices.getUserMedia({ audio: true }); ms.getTracks().forEach(t => t.stop()); micOk = true; } catch (_) {}
            setDot('cam-dot', 'cam-state', camOk, camOk ? 'granted' : 'denied');
            setDot('mic-dot', 'mic-state', micOk, micOk ? 'granted' : 'denied');
            if (camOk && micOk) {
                _permGranted = true;
                hint.textContent = 'Permissions granted';
                hint.style.color = 'var(--success)';
                checkUnlock();
            } else {
                btn.disabled = false;
                btn.textContent = 'Grant Camera & Microphone Access';
                hint.textContent = 'Permission denied — enable in browser settings.';
                hint.style.color = 'var(--error)';
            }
        }
    };

    initCvStatus();

    // ═══════════════════════════════════════════════════════════════════════════
    //  SENDER
    // ═══════════════════════════════════════════════════════════════════════════

    // A "round trip" here is: symbol shown → receiver detects it → receiver
    // plays ACK → sender hears ACK. We keep a running estimate of that RTT and
    // wait 10× it before assuming a tone got lost and restarting from
    // calibration. The estimate is clamped so a couple of bad/missing samples
    // can't make the timeout unreasonably short or long.
    const SENDER_ACK_RTT_MULTIPLIER = 10;
    const RTT_MIN_MS = 5000 / SENDER_ACK_RTT_MULTIPLIER;   // timeout floor: 5s
    const RTT_MAX_MS = 15000 / SENDER_ACK_RTT_MULTIPLIER;  // timeout ceiling: 15s (unused directly, kept for symmetry with getSenderTimeout)

    let TX   = null;  // PhysicalTX
    let SARX = null;  // AudioRX (sender side, listening for ACK/NACK/READY)

    // Sender state machine
    let sState       = 'IDLE';
    let sMsgBits     = [];
    let sErrBit      = null;
    let sRetransmit  = false;   // true once we've had to restart at least once
    let sSeq         = 0;       // 1-bit alternating sequence number for this message
    let sSymbols     = [];      // 6 encoded symbols
    let sSymIdx      = 0;       // which symbol we are currently showing
    let sSymShowTime = 0;       // Date.now() when the current symbol was displayed
    let sRttEstimate = 1500;    // running estimate of symbol→ACK round-trip time (ms)
    let sAckTimer    = null;    // fires if ACK not received in time → restart

    function getSenderTimeout() {
        return Math.max(5000, Math.min(15000, SENDER_ACK_RTT_MULTIPLIER * sRttEstimate));
    }

    function initSender() {
        const canvas = document.getElementById('tx-canvas');
        const S = Math.min(window.innerWidth, window.innerHeight) * 0.88;
        canvas.width = canvas.height = Math.floor(S);

        TX   = new PhysicalTX(canvas);
        SARX = new AudioRX();
        TX.drawIdle();

        SARX.onTone = onSenderTone;
        SARX.start().then(ok => {
            log('sender-log', ok ? 'Microphone ready.' : 'Mic unavailable — ACK detection disabled.', ok ? '' : 'warn');
        });

        document.getElementById('msg-bits').oninput  = () => { sanitizeBits(); validateSender(); };
        document.getElementById('error-bit').oninput = validateSender;
        document.getElementById('btn-show-calib').onclick   = onSenderStart;
        document.getElementById('btn-reset-sender').onclick = resetSender;
        document.getElementById('sender-back').onclick      = () => { cleanupSender(); show('screen-role'); };

        document.getElementById('btn-fullscreen').onclick = () => {
            const w = document.getElementById('tx-canvas-wrapper');
            if (!document.fullscreenElement) w.requestFullscreen && w.requestFullscreen().catch(() => {});
            else document.exitFullscreen && document.exitFullscreen();
        };

        setSenderState('IDLE');
        validateSender();
        log('sender-log', 'Sender ready. Use fullscreen for best detection.');
    }

    function sanitizeBits() {
        const el = document.getElementById('msg-bits');
        el.value = el.value.replace(/[^01]/g, '').slice(0, 20);
    }

    function validateSender() {
        const bits = document.getElementById('msg-bits').value;
        document.getElementById('btn-show-calib').disabled =
            !(bits.length > 0 && bits.length <= 20 && sState === 'IDLE');
    }

    function setSenderState(st) {
        sState = st;
        const labels = {
            IDLE:      ['IDLE',        'idle'],
            CALIBRATE: ['CALIBRATING', 'calib'],
            ENCODE:    ['ENCODING',    'active'],
            TRANSMIT:  ['SENDING',     'active'],
            SYM_GAP:   ['GAP',         'active'],
            DONE:      ['DONE',        'success'],
        };
        const [text, type] = labels[st] || [st, 'idle'];
        setBadge('sender-status-badge', text, type);
        validateSender();
    }

    function onSenderStart() {
        const bitsStr = document.getElementById('msg-bits').value;
        const errVal  = document.getElementById('error-bit').value.trim();
        sMsgBits     = bitsStr.split('').map(Number);
        sErrBit      = errVal !== '' ? parseInt(errVal, 10) : null;
        sRetransmit  = false;
        sRttEstimate = 1500;

        if (sErrBit !== null && (sErrBit < 0 || sErrBit >= sMsgBits.length)) {
            alert('Error bit index ' + sErrBit + ' is out of range (0–' + (sMsgBits.length - 1) + ')');
            return;
        }

        log('sender-log', 'Message: ' + bitsStr + '  L=' + sMsgBits.length + '  error-bit: ' + (sErrBit !== null ? sErrBit : 'none'));
        showCalibFrame();
    }

    function showCalibFrame() {
        clearTimeout(sAckTimer);
        setSenderState('CALIBRATE');
        TX.drawCalibration();
        log('sender-log', 'Calibration frame shown. Waiting for READY tone from receiver…');
        // No timeout on calibration — wait indefinitely for receiver to be ready.
    }

    function onSenderTone(tone) {
        log('sender-log', 'Heard tone: ' + tone);

        if (sState === 'CALIBRATE') {
            if (tone === 'READY') {
                // Receiver is calibrated and ready — start encoding and sending
                doEncode();
            }
            // Ignore anything else during calibration

        } else if (sState === 'TRANSMIT') {
            if (tone === 'ACK') {
                clearTimeout(sAckTimer);

                // Update our RTT estimate from how long this symbol took to ACK.
                const measuredRtt = Date.now() - sSymShowTime;
                if (measuredRtt > 0 && measuredRtt < 15000) {
                    sRttEstimate = 0.7 * sRttEstimate + 0.3 * measuredRtt;
                }

                sSymIdx++;
                if (sSymIdx >= sSymbols.length) {
                    // The ACK for the last symbol IS the receiver's "frame decoded
                    // successfully" signal — there's no separate final-ACK phase.
                    setSenderState('DONE');
                    TX.drawIdle();
                    sSeq ^= 1; // frame fully delivered — next message uses the other SEQ
                    log('sender-log', 'Final symbol acknowledged — transmission complete!', 'success');
                    setTimeout(() => {
                        if (sState === 'DONE') setSenderState('IDLE');
                    }, 3000);
                } else {
                    log('sender-log', 'ACK received for symbol ' + sSymIdx + ' (RTT: ' + measuredRtt + 'ms).', 'success');
                    setSenderState('SYM_GAP');
                    // Short gap so the receiver's microphone doesn't pick up our tone
                    // from the previous symbol's ACK again
                    setTimeout(doTransmitNextSymbol, 500);
                }
            } else if (tone === 'NACK') {
                // Receiver finished collecting all 6 symbols but failed to decode
                // the frame (bad SYNC/END or uncorrectable error) — retransmit.
                clearTimeout(sAckTimer);
                log('sender-log', 'NACK received — receiver could not decode the frame. Restarting…', 'warn');
                doFullRestart();
            }
            // Ignore READY during per-symbol transmission

        } else if (sState === 'SYM_GAP') {
            // Deaf period — ignore all tones
        }
    }

    function doEncode() {
        setSenderState('ENCODE');
        // Build the 48-bit frame (SYNC | SEQ | Hamming codeword | END | padding)
        // and split it into 6 symbols. The simulated error bit is injected on
        // every attempt, retransmits included — retrying doesn't change the
        // message, so it shouldn't change what error we asked to simulate.
        const bits48 = Framing.buildFrame(sMsgBits, sErrBit, sSeq);
        sSymbols     = Framing.bitsToSymbols(bits48);
        sSymIdx      = 0;
        log('sender-log', 'Encoded ' + sSymbols.length + ' symbols (SEQ=' + sSeq + ', error@bit ' + (sErrBit !== null ? sErrBit : 'none') + ')');

        TX.drawIdle();
        setTimeout(doTransmitNextSymbol, 300);
    }

    function doTransmitNextSymbol() {
        if (sSymIdx >= sSymbols.length) {
            setSenderState('DONE');
            TX.drawIdle();
            return;
        }

        setSenderState('TRANSMIT');
        TX.showSymbol(sSymbols[sSymIdx]);
        sSymShowTime = Date.now();

        const timeout = getSenderTimeout();
        log('sender-log', 'Showing symbol ' + (sSymIdx + 1) + '/' + sSymbols.length +
            '  cells=[' + sSymbols[sSymIdx].join(',') + ']');

        // Wait for an ACK. The deadline adapts to the measured RTT instead of
        // a fixed value, so it self-tunes to how responsive the acoustic link
        // actually is. If nothing arrives in time, assume the link dropped a
        // tone and restart the whole handshake from calibration.
        sAckTimer = setTimeout(() => {
            if (sState === 'TRANSMIT') {
                log('sender-log', 'Symbol ' + (sSymIdx + 1) + ' timeout (' + Math.round(timeout / 1000) + 's). Restarting…', 'warn');
                doFullRestart();
            }
        }, timeout);
    }

    function doFullRestart() {
        clearTimeout(sAckTimer);
        sRetransmit = true;
        log('sender-log', 'Retransmitting frame…', 'warn');
        showCalibFrame();
    }

    function resetSender() {
        clearTimeout(sAckTimer);
        setSenderState('IDLE');
        if (TX) { TX.stop(); TX.drawIdle(); }
        sRetransmit  = false;
        sRttEstimate = 1500;
        sSymIdx      = 0;
        document.getElementById('sender-log').innerHTML = '';
        log('sender-log', 'Reset.');
        validateSender();
    }

    function cleanupSender() {
        clearTimeout(sAckTimer);
        if (TX)   TX.stop();
        if (SARX) SARX.stop();
    }

    // Redraw canvas on fullscreen / resize
    document.addEventListener('fullscreenchange', () => {
        if (TX && document.querySelector('#screen-sender.active')) {
            const canvas = document.getElementById('tx-canvas');
            const isFs   = !!document.fullscreenElement;
            const S = isFs
                ? Math.min(window.screen.width, window.screen.height)
                : Math.min(window.innerWidth, window.innerHeight) * 0.88;
            canvas.width = canvas.height = Math.floor(S);
            if (sState === 'CALIBRATE') TX.drawCalibration();
            else TX.drawIdle();
        }
    });
    window.addEventListener('resize', () => {
        if (TX && document.querySelector('#screen-sender.active') && !document.fullscreenElement) {
            const canvas = document.getElementById('tx-canvas');
            const S = Math.min(window.innerWidth, window.innerHeight) * 0.88;
            canvas.width = canvas.height = Math.floor(S);
            if (sState === 'CALIBRATE') TX.drawCalibration();
            else TX.drawIdle();
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  RECEIVER
    // ═══════════════════════════════════════════════════════════════════════════

    // How long (relative to the estimated RTT) to wait before re-sending an
    // ACK for the current symbol, and how long overall to listen for a full
    // frame before giving up and sending a final NACK. Both scale with the
    // measured RTT instead of a fixed manual dwell time, so they self-tune to
    // however fast/slow the acoustic link actually turns out to be.
    const RECEIVER_REACK_RTT_MULTIPLIER = 2;
    const RECEIVER_LISTEN_RTT_MULTIPLIER = 10;

    let RX          = null;   // PhysicalRX
    let rState      = 'IDLE';
    let rBitBuf     = [];     // accumulated bits from all received symbols
    let rSymCount   = 0;      // how many symbols we've received
    let rReAckTimer = null;   // timer to re-send ACK if clock doesn't change
    let rListenTimer = null;  // timer that gives up (sends NACK) if no full frame arrives
    let rScreenFound = false; // whether the quad marker is currently locked
    let rRttEstimate = 1500;  // running estimate of READY→first-symbol RTT (ms)
    let rReadyTime   = 0;     // Date.now() when READY was last sent
    let rLastDecodedSeq = null; // SEQ of the last frame we successfully decoded/displayed
    let _overlayCtx = null;

    function initReceiver() {
        RX = null; rState = 'IDLE'; rBitBuf = []; rSymCount = 0;
        _overlayCtx = document.getElementById('rx-overlay').getContext('2d');

        document.getElementById('btn-start-camera').onclick   = startCamera;
        document.getElementById('btn-calibrate').onclick      = startCalibration;
        document.getElementById('btn-reset-receiver').onclick = resetReceiver;
        document.getElementById('receiver-back').onclick      = () => { cleanupReceiver(); show('screen-role'); };

        setRxState('IDLE');
        log('receiver-log', 'Receiver ready. Start camera first.');
    }

    function setRxState(st) {
        rState = st;
        const labels = {
            IDLE:        ['IDLE',        'idle'],
            'CAMERA ON': ['CAMERA ON',   'active'],
            CALIBRATING: ['CALIBRATING', 'calib'],
            LISTEN:      ['LISTENING',   'active'],
            DONE:        ['DONE',        'success'],
        };
        const [text, type] = labels[st] || [st, 'idle'];
        setBadge('receiver-status-badge', text, type);
    }

    async function startCamera() {
        document.getElementById('btn-start-camera').disabled = true;
        const video = document.getElementById('rx-video');
        RX = new PhysicalRX(video);
        RX.onDebug     = updateDebugPanel;
        RX.onNewSymbol = onNewSymbol;

        const ok = await RX.start();
        if (ok) {
            document.getElementById('btn-calibrate').disabled = false;
            document.getElementById('camera-hint').style.display = 'none';
            setRxState('CAMERA ON');
            log('receiver-log', 'Camera started. Aim at the sender screen, then press Calibrate.');
        } else {
            log('receiver-log', 'Camera access denied.', 'error');
            document.getElementById('btn-start-camera').disabled = false;
        }
    }

    function startCalibration() {
        if (!RX) return;
        if (!window._cvReady) {
            log('receiver-log', 'OpenCV not ready yet.', 'warn');
            return;
        }
        document.getElementById('btn-calibrate').disabled = true;
        setRxState('CALIBRATING');
        log('receiver-log', 'Sampling calibration colours (30 frames)…');
        RX.startCalibration(() => {
            log('receiver-log', 'Calibration done.', 'success');
            log('receiver-log', 'Clock midpoint luma: ' + RX.clockMidLuma.toFixed(1));
            if (RX.refColors) {
                RX.refColors.forEach((c, i) => {
                    log('receiver-log', 'Ref[' + Framing.COLOR_NAMES[i] + ']: R=' +
                        c.r.toFixed(0) + ' G=' + c.g.toFixed(0) + ' B=' + c.b.toFixed(0));
                });
            }
            log('receiver-log', 'Sending READY tone to sender…');
            rReadyTime = Date.now();
            AudioTX.playTone('READY').then(() => {
                log('receiver-log', 'READY sent. Listening for symbols…');
                startListening();
            });
        });
    }

    function startListening() {
        setRxState('LISTEN');
        rBitBuf   = [];
        rSymCount = 0;
        RX.resetClock();
        clearTimeout(rReAckTimer);
        document.getElementById('rx-result-area').classList.add('hidden');
        log('receiver-log', 'Listening. Sender should now start transmitting symbols.');
        startListenTimer();
    }

    function stopListenTimer() {
        if (rListenTimer !== null) {
            clearTimeout(rListenTimer);
            rListenTimer = null;
        }
    }

    function startListenTimer() {
        stopListenTimer();
        const timeout = Math.max(5000, Math.min(15000, RECEIVER_LISTEN_RTT_MULTIPLIER * rRttEstimate));
        rListenTimer = setTimeout(() => {
            if (rState === 'LISTEN') {
                log('receiver-log', 'Listen timeout (' + Math.round(timeout / 1000) + 's) — no full frame arrived. Sending NACK.', 'warn');
                sendFinalNack();
            }
        }, timeout);
    }

    // Called by PhysicalRX every time it detects a new symbol (clock edge).
    function onNewSymbol(cells) {
        if (rState !== 'LISTEN') return;

        // PhysicalRX fires on a clock edge regardless of warp quality.
        // If the camera didn't have a solid quad lock at capture time,
        // the cell colours are garbage — drop the symbol, don't ACK.
        // The re-ACK timer (scheduleReAck) will keep nudging the sender
        // with our last ACK until we get a clean read of the next symbol.
        if (!RX || !RX._lastWarpOk) {
            log('receiver-log', 'Symbol ignored — no quad lock at capture time.', 'warn');
            return;
        }

        rSymCount++;

        // The first symbol gives us a real measurement of READY→symbol RTT,
        // which we use to size the re-ACK and overall listen timeouts.
        if (rSymCount === 1 && rReadyTime > 0) {
            const firstRtt = Date.now() - rReadyTime;
            if (firstRtt > 0 && firstRtt < 15000) {
                rRttEstimate = firstRtt;
                log('receiver-log', 'Measured RTT: ' + Math.round(rRttEstimate) + 'ms');
            }
        }

        // Each cell is a color index 0-3 = 2 bits.
        for (const c of cells) {
            rBitBuf.push((c >> 1) & 1);
            rBitBuf.push(c & 1);
        }

        log('receiver-log', 'Symbol ' + rSymCount + ' received: [' +
            cells.map(c => Framing.COLOR_NAMES[c]).join(', ') + ']');

        document.getElementById('dbg-symbols').textContent = rSymCount;
        document.getElementById('dbg-bits').textContent =
            (rBitBuf.length > 40 ? '…' : '') + rBitBuf.slice(-40).join('');

        if (rBitBuf.length >= Framing.PADDED_BITS) {
            // All 6 symbols are in — stop re-ACKing/listening and try to decode.
            // (No plain per-symbol ACK is sent for this last symbol: the ACK the
            // sender needs now is the "frame decoded" ACK produced below.)
            clearTimeout(rReAckTimer);
            stopListenTimer();
            tryFinalDecode();
        } else {
            // Not done yet — ACK this symbol so the sender advances, and reset
            // the overall listen timeout since we're clearly still connected.
            stopListenTimer();
            startListenTimer();
            sendSymbolAck();
            clearTimeout(rReAckTimer);
            scheduleReAck();
        }
    }

    function sendSymbolAck() {
        AudioTX.playTone('ACK').then(() => {
            log('receiver-log', 'ACK sent (symbol ' + rSymCount + ').');
        });
    }

    function scheduleReAck() {
        // If the clock doesn't change within this window, the sender probably
        // didn't hear our ACK, so we send it again. The window scales with
        // the measured RTT rather than a fixed manual dwell time.
        const reAckMs = Math.max(1500, Math.min(6000, RECEIVER_REACK_RTT_MULTIPLIER * rRttEstimate));

        rReAckTimer = setTimeout(() => {
            if (rState !== 'LISTEN') return;
            if (!rScreenFound) {
                log('receiver-log', 'ACK retransmit deferred — screen tracking lost.', 'warn');
                scheduleReAck();
                return;
            }
            // Clock hasn't changed — sender is probably stuck waiting for our ACK.
            log('receiver-log', 'Clock unchanged for ' + Math.round(reAckMs) + 'ms — re-sending ACK.', 'warn');
            sendSymbolAck();
            // Keep re-ACKing until we get a new symbol or finish.
            scheduleReAck();
        }, reAckMs);
    }

    function tryFinalDecode() {
        // Check that we got exactly the right number of bits.
        // PADDED_BITS = 48 (6 symbols × 8 bits each).
        if (rBitBuf.length !== Framing.PADDED_BITS) {
            log('receiver-log',
                'Bit count wrong: got ' + rBitBuf.length + ' expected ' + Framing.PADDED_BITS +
                ' — sending NACK.', 'warn');
            sendFinalNack();
            return;
        }

        // Try to find and decode the frame in the bit buffer.
        const result = Framing.parseFrame(rBitBuf);
        if (!result || result.L < 1 || result.L > 20 || result.messageBits.length !== result.L) {
            log('receiver-log', 'Frame validation failed (SYNC/END/parity error) — sending NACK.', 'error');
            sendFinalNack();
            return;
        }

        if (result.seq === rLastDecodedSeq) {
            // We've already shown this exact frame — the sender must be
            // retransmitting because our earlier final ACK got lost. Just
            // re-ACK it; don't process or re-display the result.
            log('receiver-log', 'Duplicate frame detected (SEQ=' + result.seq + '). Re-ACKing.', 'warn');
            AudioTX.playTone('ACK');
            document.getElementById('btn-calibrate').disabled = false;
            return;
        }

        // A genuinely new frame — success!
        rLastDecodedSeq = result.seq;
        setRxState('DONE');
        log('receiver-log', 'Frame decoded! SEQ=' + result.seq + '  L=' + result.L + '  msg=' + result.messageBits.join(''), 'success');

        if (result.errorMsgBitIdx !== null) {
            log('receiver-log', 'Error corrected at message bit ' + result.errorMsgBitIdx, 'warn');
        } else if (result.errorDataIdx !== null) {
            log('receiver-log', 'Parity-bit error corrected (message itself is intact).', 'warn');
        } else {
            log('receiver-log', 'No errors detected.');
        }

        showResult(result);

        AudioTX.playTone('ACK').then(() => {
            log('receiver-log', 'Final ACK sent. Ready for next transmission.', 'success');
            document.getElementById('btn-calibrate').disabled = false;
        });
    }

    function sendFinalNack() {
        clearTimeout(rReAckTimer);
        stopListenTimer();
        setRxState('CAMERA ON');
        AudioTX.playTone('NACK').then(() => {
            log('receiver-log', 'NACK sent. Waiting for sender to restart…', 'warn');
            rBitBuf   = [];
            rSymCount = 0;
            if (RX) RX.resetClock();
            document.getElementById('btn-calibrate').disabled = false;
        });
    }

    function showResult(result) {
        const area   = document.getElementById('rx-result-area');
        const msgEl  = document.getElementById('rx-message');
        const errEl  = document.getElementById('rx-err-info');
        const metaEl = document.getElementById('rx-meta');
        area.classList.remove('hidden');

        const bits   = result.messageBits;
        const errIdx = result.errorMsgBitIdx;

        if (errIdx !== null && errIdx < bits.length) {
            let html = '';
            bits.forEach((b, i) => {
                if (i === errIdx) {
                    html += '<span class="err-bit" title="bit ' + i + ' corrected">' + b + '</span>';
                } else {
                    html += b;
                }
            });
            msgEl.innerHTML = html;
            errEl.textContent = 'Bit ' + errIdx + ' (0-indexed) was in error and has been corrected.';
            errEl.className   = 'rx-err-info error';
        } else {
            msgEl.textContent = bits.join('');
            errEl.textContent = 'No error detected.';
            errEl.className   = 'rx-err-info ok';
        }

        metaEl.textContent = 'Length: ' + bits.length + ' bit' + (bits.length !== 1 ? 's' : '') +
                             '  |  Symbols received: ' + rSymCount;
    }

    // ── Debug panel helpers ───────────────────────────────────────────────────

    function updateDebugPanel(info) {
        const found = info.screenFound;
        rScreenFound = found;
        document.getElementById('dbg-markers').textContent =
            found ? '4/4 detected' : 'searching… (' + (info.candidateCount || 0) + ' candidates)';

        if (info.clockState !== undefined) {
            const pending = info.newSymbol ? ' ★ SYMBOL' : (info.cooldown > 0 ? ' [cd:' + info.cooldown + ']' : '');
            document.getElementById('dbg-clock').textContent =
                info.clockState + '  luma=' + info.luma + '  mid=' + info.midLuma + pending;
        }
        if (info.cellColors !== undefined) {
            document.getElementById('dbg-cells').textContent = info.cellColors.join(' ');
        }
        if (info.cellRgb !== undefined) {
            const el = document.getElementById('dbg-rgb');
            if (el) el.textContent = info.cellRgb.join(' ');
        }

        if (_overlayCtx) drawQuadOverlay(info.quad || null);
    }

    function drawQuadOverlay(quad) {
        const overlay = document.getElementById('rx-overlay');
        const video   = document.getElementById('rx-video');
        overlay.width  = overlay.offsetWidth  || video.offsetWidth;
        overlay.height = overlay.offsetHeight || video.offsetHeight;
        const ctx = _overlayCtx;
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        if (!quad || !video.videoWidth) return;

        const sx = overlay.width  / video.videoWidth;
        const sy = overlay.height / video.videoHeight;
        const pts = [quad.TL, quad.TR, quad.BR, quad.BL].map(p => ({
            x: p.x * sx, y: p.y * sy
        }));

        ctx.fillStyle = 'rgba(34,211,165,0.10)';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#22d3a5';
        ctx.lineWidth   = 2;
        ctx.stroke();
        pts.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#22d3a5';
            ctx.fill();
        });
    }

    function resetReceiver() {
        clearTimeout(rReAckTimer);
        stopListenTimer();
        rLastDecodedSeq = null;
        rBitBuf      = [];
        rSymCount    = 0;
        rRttEstimate = 1500;
        setRxState('IDLE');
        document.getElementById('rx-result-area').classList.add('hidden');
        document.getElementById('receiver-log').innerHTML = '';
        ['dbg-markers', 'dbg-clock', 'dbg-cells', 'dbg-rgb', 'dbg-symbols', 'dbg-bits']
            .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
        if (_overlayCtx) {
            const o = document.getElementById('rx-overlay');
            _overlayCtx.clearRect(0, 0, o.width, o.height);
        }
        if (RX) {
            RX.reset();
            document.getElementById('btn-calibrate').disabled = false;
        }
        log('receiver-log', 'Reset. Press Calibrate to restart.');
    }

    function cleanupReceiver() {
        clearTimeout(rReAckTimer);
        stopListenTimer();
        if (RX) RX.stop();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  DEBUG CONSOLE  (unchanged from original)
    // ═══════════════════════════════════════════════════════════════════════════
    let debugAudioRX = null, debugRX = null, _dbgWarpCtx = null, _dbgWarpTimer = null;

    function initDebugLab() {
        document.getElementById('btn-dbg-ready').onclick = () => {
            AudioTX.playTone('READY');
            log('debug-log', 'Playing READY (1150+1450 Hz)');
        };
        document.getElementById('btn-dbg-ack').onclick = () => {
            AudioTX.playTone('ACK');
            log('debug-log', 'Playing ACK (1750+2150 Hz)');
        };
        document.getElementById('btn-dbg-nack').onclick = () => {
            AudioTX.playTone('NACK');
            log('debug-log', 'Playing NACK (2550+2950 Hz)');
        };

        const btnStart = document.getElementById('btn-dbg-listen-start');
        const btnStop  = document.getElementById('btn-dbg-listen-stop');

        btnStart.onclick = async () => {
            debugAudioRX = new AudioRX();
            debugAudioRX.onTone = (name) => {
                document.getElementById('dbg-tone-name').textContent = name;
                log('debug-log', 'Detected: ' + name, 'success');
            };
            debugAudioRX.onDebugPoll = (info) => {
                const el = document.getElementById('dbg-fft-info');
                if (!el) return;
                const lines = [];
                for (const [name, data] of Object.entries(info)) {
                    const passStr = data.pass ? 'PASS' : '----';
                    lines.push(name.padEnd(6) + ' peaks=[' + data.peaks.join(', ') + '] dB' +
                        '  prom=[' + data.prominences.join(', ') + '] dB' +
                        '  twist=' + data.twist + ' dB  ' + passStr);
                }
                el.textContent = lines.join('\n');
            };
            const ok = await debugAudioRX.start();
            if (ok) {
                btnStart.disabled = true;
                btnStop.disabled  = false;
                log('debug-log', 'Mic detector started.');
            } else {
                log('debug-log', 'Mic start failed.', 'error');
            }
        };

        btnStop.onclick = () => {
            if (debugAudioRX) { debugAudioRX.stop(); debugAudioRX = null; }
            btnStart.disabled = false;
            btnStop.disabled  = true;
            log('debug-log', 'Detector stopped.');
        };

        // Vision debug
        const btnCamStart = document.getElementById('btn-dbg-cam-start');
        const btnCamStop  = document.getElementById('btn-dbg-cam-stop');
        const btnDbgCalib = document.getElementById('btn-dbg-calib');
        _dbgWarpCtx = document.getElementById('dbg-warp-canvas').getContext('2d');
        const dbgBinaryCtx  = document.getElementById('dbg-binary-canvas').getContext('2d');

        btnCamStart.onclick = async () => {
            const video = document.getElementById('dbg-video');
            debugRX = new PhysicalRX(video);
            debugRX.onDebug = updateDebugVision;
            const ok = await debugRX.start();
            if (ok) {
                btnCamStart.disabled = true;
                btnCamStop.disabled  = false;
                if (btnDbgCalib) btnDbgCalib.disabled = false;
                log('debug-log', 'Debug camera started.');
                _dbgWarpTimer = setInterval(() => {
                    if (!debugRX) return;
                    const wc = debugRX.getWarpedCanvas();
                    if (wc && _dbgWarpCtx) {
                        const dc = document.getElementById('dbg-warp-canvas');
                        _dbgWarpCtx.drawImage(wc, 0, 0, dc.width, dc.height);
                    }
                    const bc = debugRX.getBinaryCanvas();
                    if (bc && dbgBinaryCtx) {
                        const bEl = document.getElementById('dbg-binary-canvas');
                        dbgBinaryCtx.drawImage(bc, 0, 0, bEl.width, bEl.height);
                    }
                }, 60);
            } else {
                log('debug-log', 'Camera start failed.', 'error');
            }
        };

        if (btnDbgCalib) {
            btnDbgCalib.onclick = () => {
                if (!debugRX) return;
                btnDbgCalib.disabled = true;
                log('debug-log', 'Sampling 25 calibration frames…');
                debugRX.startCalibration(() => {
                    btnDbgCalib.disabled = false;
                    log('debug-log', 'Debug calibration done!', 'success');
                    log('debug-log', 'Clock midpoint luma: ' + debugRX.clockMidLuma.toFixed(1));
                    if (debugRX.refColors) {
                        debugRX.refColors.forEach((c, i) => {
                            log('debug-log', 'Ref[' + Framing.COLOR_NAMES[i] + ']: R=' +
                                c.r.toFixed(0) + ' G=' + c.g.toFixed(0) + ' B=' + c.b.toFixed(0));
                        });
                    }
                });
            };
        }

        btnCamStop.onclick = () => {
            if (debugRX) { debugRX.stop(); debugRX = null; }
            if (_dbgWarpTimer) { clearInterval(_dbgWarpTimer); _dbgWarpTimer = null; }
            btnCamStart.disabled = false;
            btnCamStop.disabled  = true;
            if (btnDbgCalib) btnDbgCalib.disabled = true;
            log('debug-log', 'Debug camera stopped.');
        };

        document.getElementById('debug-back').onclick = () => {
            if (debugAudioRX) { debugAudioRX.stop(); debugAudioRX = null; }
            if (debugRX) { debugRX.stop(); debugRX = null; }
            if (_dbgWarpTimer) { clearInterval(_dbgWarpTimer); _dbgWarpTimer = null; }
            show('screen-role');
        };
    }

    function updateDebugVision(info) {
        const el = (id) => document.getElementById(id);
        const video   = document.getElementById('dbg-video');
        const overlay = document.getElementById('dbg-overlay');

        if (overlay && video && video.videoWidth) {
            overlay.width  = overlay.offsetWidth  || video.offsetWidth;
            overlay.height = overlay.offsetHeight || video.offsetHeight;
            const ctx = overlay.getContext('2d');
            ctx.clearRect(0, 0, overlay.width, overlay.height);
            if (info.quad) {
                const sx = overlay.width  / video.videoWidth;
                const sy = overlay.height / video.videoHeight;
                const pts = [info.quad.TL, info.quad.TR, info.quad.BR, info.quad.BL].map(p => ({
                    x: p.x * sx, y: p.y * sy
                }));
                ctx.fillStyle = 'rgba(34,211,165,0.12)';
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
                ctx.closePath();
                ctx.fill();
                ctx.strokeStyle = '#22d3a5';
                ctx.lineWidth   = 2;
                ctx.stroke();
                pts.forEach((p, idx) => {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
                    ctx.fillStyle = idx === 0 ? '#f472b6' : '#22d3a5';
                    ctx.fill();
                });
            }
        }

        el('dbg-v-markers').textContent = info.screenFound ? 'Locked (4/4)' : 'Searching…';
        el('dbg-v-candidates').textContent = (info.candidateCount || 0) + ' candidates  |  ' + (info.fps || 0) + ' fps';

        if (info.clockState !== undefined) {
            const pending = info.newSymbol ? ' ★ SYMBOL' : (info.cooldown > 0 ? ' [cooldown:' + info.cooldown + ']' : '');
            el('dbg-v-clock').textContent =
                (info.clockState === 'B' ? 'BLACK' : 'WHITE') +
                ' (luma=' + info.luma + ', mid=' + info.midLuma + ')' + pending;
        }

        if (info.cellColors !== undefined) {
            const COLOR_BITS = ['00', '01', '10', '11'];
            const COLOR_HEX  = ['#FFFFFF', '#FF2222', '#22DD22', '#2266FF'];
            const POS_NAMES  = ['TL', 'TR', 'BL', 'BR'];
            let bits8 = '';
            info.cellColors.forEach((cName, i) => {
                const cIdx = ['WHITE', 'RED', 'GREEN', 'BLUE'].indexOf(cName);
                const idx  = cIdx >= 0 ? cIdx : 0;
                const bits = COLOR_BITS[idx];
                bits8 += (i > 0 ? ' ' : '') + bits;
                const colEl = document.getElementById('dbg-swatch-color-' + i);
                const lblEl = document.getElementById('dbg-swatch-name-' + i);
                const bitEl = document.getElementById('dbg-swatch-bits-' + i);
                if (colEl) colEl.style.backgroundColor = COLOR_HEX[idx];
                if (lblEl) lblEl.textContent = POS_NAMES[i] + ': ' + cName;
                if (bitEl) bitEl.textContent = bits;
            });
            const symEl = document.getElementById('dbg-v-symbol-bits');
            if (symEl) symEl.textContent = bits8;
        }

        if (info.cellRgb !== undefined) {
            el('dbg-v-rgb').textContent = info.cellRgb.join(' ');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  ROLE SELECTION
    // ═══════════════════════════════════════════════════════════════════════════
    document.getElementById('btn-role-sender').onclick = () => {
        show('screen-sender');
        initSender();
    };
    document.getElementById('btn-role-receiver').onclick = () => {
        show('screen-receiver');
        initReceiver();
    };
    document.getElementById('btn-role-debug').onclick = () => {
        show('screen-debug');
        initDebugLab();
    };

})();
