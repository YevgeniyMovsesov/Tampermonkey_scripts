// ==UserScript==
// @name         Vote ASAP in the Telegram poll
// @namespace    http://tampermonkey.net/
// @version      11
// @description  Monitors a specific Telegram channel and automatically votes in new polls
// @author       yevgeniy.movsesov@gmail.com
// @match        https://web.telegram.org/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ─── SETTINGS ────────────────────────────────────────────────────────────────
    // Voting mode:
    //   "LOOK_BY_NUMBER_OF_POLL_OPTION" — vote by position (1, 2, 3)
    //   "LOOK_BY_NAME_OF_POLL_OPTION"   — vote by the exact text of the option
    const MONITORING_MODE = "LOOK_BY_NUMBER_OF_POLL_OPTION";
    // used in LOOK_BY_NUMBER_OF_POLL_OPTION mode
    const ANSWER_INDEX = 1;
    // used in LOOK_BY_NAME_OF_POLL_OPTION mode (case-insensitive)
    const ANSWER_NAME = "Рева берёт уроки читерства у Кирчика";
    // How often (ms) to scan for a new unvoted poll
    const POLL_INTERVAL_MS = 100;
    // Delay (ms) after page load before the script starts monitoring
    const STARTUP_DELAY_MS = 3000;
    // How long (minutes) to keep monitoring after Ctrl+/ is pressed
    const MONITORING_DURATION_MIN = 10;
    const DEBUG = false;
    // ─────────────────────────────────────────────────────────────────────────────

    // Polls that existed when the script first loaded — we ignore them.
    const seenAtStart = new WeakSet();
    // Polls we have already voted in during this session.
    const votedPolls = new WeakSet();

    // ── helpers ──────────────────────────────────────────────────────────────────

    /** Returns current time as [hh:mm:ss.ms] string. */
    function ts() {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        const ms = String(d.getMilliseconds()).padStart(3, '0');
        return `[${hh}:${mm}:${ss}.${ms}]`;
    }

    /**
     * On startup: mark every poll currently in the DOM as "pre-existing".
     * We will never vote in these — only in polls that appear later.
     */
    function initSeenPolls() {
        document.querySelectorAll('poll-element').forEach((poll) => {
            seenAtStart.add(poll);
        });
        console.log(ts(), '[VoteMonitoringBot] Pre-marked existing polls as seen. Waiting for new ones…');
    }

    /**
     * Find poll elements that appeared AFTER the script loaded and have not
     * been voted in yet. Returns at most 1 — the newest one (last in DOM).
     */
    function findNewUnvotedPoll() {
        const pollElements = Array.from(document.querySelectorAll('poll-element'));

        // Walk from the bottom (newest message) upward and return the first
        // poll that is truly new and still awaiting a vote.
        for (let i = pollElements.length - 1; i >= 0; i--) {
            const poll = pollElements[i];

            // Skip polls that were already there when the script loaded.
            if (seenAtStart.has(poll)) continue;

            // Skip polls we already voted in.
            if (votedPolls.has(poll)) continue;

            // Skip polls whose bubble/element already shows results.
            const bubble = poll.closest('.bubble');
            if (bubble && bubble.classList.contains('is-voted')) continue;
            if (poll.classList.contains('is-voted')) continue;

            // Skip if there are no clickable answer circles yet (still loading).
            const answers = poll.querySelectorAll('div.circle-hover');
            if (answers.length === 0) continue;

            return poll; // newest actionable new poll found
        }

        return null;
    }

    /**
     * Click the Nth answer (1-based) inside the given poll element.
     */
    function voteInPoll(poll) {
        // Answers are nth divs inside .poll-answers (or direct children of the
        // answers container).  The recording used div:nth-of-type(3) > div.circle-hover > div
        const answerRows = poll.querySelectorAll('.poll-answer');

        let target = null;

        if (answerRows.length >= ANSWER_INDEX) {
            // Prefer the semantic .poll-answer list
            const row = answerRows[ANSWER_INDEX - 1];
            target = row.querySelector('div.circle-hover > div') ||
                row.querySelector('div.circle-hover');
        } else {
            // Fallback: nth circle-hover direct approach (matches recording selector)
            const circles = poll.querySelectorAll('div.circle-hover > div');
            if (circles.length >= ANSWER_INDEX) {
                target = circles[ANSWER_INDEX - 1];
            }
        }

        if (!target) {
            console.warn(ts(), `[VoteMonitoringBot] Could not find answer #${ANSWER_INDEX} in poll:`, poll);
            return false;
        }

        console.log(ts(), `[VoteMonitoringBot] Voting for answer #${ANSWER_INDEX} in poll:`, poll);
        target.click();
        votedPolls.add(poll);
        return true;
    }

    /**
     * Click the answer whose visible text matches ANSWER_NAME (case-insensitive)
     * inside the given poll element.
     */
    function voteInPollByName(poll) {
        const answerRows = poll.querySelectorAll('.poll-answer');

        let target = null;

        for (const row of answerRows) {
            const textEl = row.querySelector('.poll-answer-text') || row;
            const text = textEl.textContent.trim();
            if (DEBUG) console.log(ts(), `[VoteMonitoringBot] Answer option found: "${text}"`);
            if (text.toLowerCase() === ANSWER_NAME.toLowerCase()) {
                target = row.querySelector('div.circle-hover > div') ||
                    row.querySelector('div.circle-hover');
                break;
            }
        }

        if (!target) {
            console.warn(ts(), `[VoteMonitoringBot] Could not find answer named "${ANSWER_NAME}" in poll:`, poll);
            return false;
        }

        console.log(ts(), `[VoteMonitoringBot] Voting for answer "${ANSWER_NAME}" in poll:`, poll);
        target.click();
        votedPolls.add(poll);
        return true;
    }

    // ── main loop ─────────────────────────────────────────────────────────────────

    function tick() {
        if (DEBUG) console.log(ts(), '[VoteMonitoringBot] tick');
        const poll = findNewUnvotedPoll();
        if (!poll) return;

        if (MONITORING_MODE === "LOOK_BY_NAME_OF_POLL_OPTION") {
            voteInPollByName(poll);
        } else {
            voteInPoll(poll);
        }
    }

    // ── toast notification ────────────────────────────────────────────────────────

    /**
     * Show a brief toast message in the top-right corner for `durationMs` ms.
     */
    function showToast(message, durationMs = 7000) {
        const toast = document.createElement('div');
        toast.textContent = message;
        Object.assign(toast.style, {
            position: 'fixed',
            top: '24px',
            right: '24px',
            zIndex: '2147483647',
            padding: '14px 22px',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, #1a73e8 0%, #0d47a1 100%)',
            color: '#ffffff',
            fontSize: '15px',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontWeight: '600',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            opacity: '0',
            transform: 'translateY(-12px)',
            transition: 'opacity 0.3s ease, transform 0.3s ease',
            pointerEvents: 'none',
            userSelect: 'none',
        });
        document.body.appendChild(toast);

        // Fade in
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                toast.style.opacity = '1';
                toast.style.transform = 'translateY(0)';
            });
        });

        // Fade out and remove
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-12px)';
            setTimeout(() => toast.remove(), 350);
        }, durationMs);
    }

    // ── keyboard trigger ──────────────────────────────────────────────────────────
    //
    // Telegram Web is an SPA: Tampermonkey may re-inject this script on every
    // navigation, creating multiple IIFE instances — each with its own closure
    // and its own keydown listener on the same document.  To prevent the
    // "already running" false-positive we store both flags on `window` so every
    // instance shares the same state.

    // True while the scan loop is active.
    if (window._voteBotStarted === undefined) window._voteBotStarted = false;

    // Register the keydown listener only once, no matter how many times the
    // script is injected.
    if (!window._voteBotListenerAdded) {
        window._voteBotListenerAdded = true;

        document.addEventListener('keydown', (e) => {
            // Ctrl+/ (key '/' with Ctrl held, no other modifiers)
            if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey &&
                (e.key === '/' || e.code === 'Slash')) {

                e.preventDefault();

                // Ignore auto-repeat events (key held down).
                if (e.repeat) return;

                // Debounce: Telegram re-dispatches keyboard events synthetically,
                // which causes this handler to fire twice within the same ms.
                // Ignore any trigger that comes within 500 ms of the previous one.
                const now = Date.now();
                if (now - (window._voteBotLastTrigger || 0) < 500) return;
                window._voteBotLastTrigger = now;

                if (window._voteBotStarted) {
                    console.log(ts(), '[VoteMonitoringBot] Monitoring already running — ignoring Ctrl+/');
                    showToast('⚡ VoteMonitoringBot: Monitoring already running — ignoring Ctrl+/');
                    return;
                }

                window._voteBotStarted = true;
                console.log(ts(), `[VoteMonitoringBot] Now I am monitoring the channel during ${MONITORING_DURATION_MIN} min.`);
                showToast(`VoteMonitoringBot: Now I am monitoring the channel during ${MONITORING_DURATION_MIN} min.`, 7000);

                // Snapshot polls already in the DOM, then start the scan loop.
                setTimeout(() => {
                    initSeenPolls();
                    const intervalId = setInterval(tick, POLL_INTERVAL_MS);

                    // Auto-stop after MONITORING_DURATION_MIN minutes.
                    setTimeout(() => {
                        clearInterval(intervalId);
                        window._voteBotStarted = false;
                        console.log(ts(), `[VoteMonitoringBot] Monitoring stopped after ${MONITORING_DURATION_MIN} min.`);
                        showToast(`⏹ VoteMonitoringBot: Monitoring stopped after ${MONITORING_DURATION_MIN} min.`, 7000);
                    }, MONITORING_DURATION_MIN * 60 * 1000);
                }, STARTUP_DELAY_MS);
            }
        });
    }

    console.log(ts(), '[VoteMonitoringBot] Script loaded. Press combination "Ctrl+/" for monitoring.');
    console.log(ts(), '[VoteMonitoringBot] Mode:', MONITORING_MODE,
        '| Answer index:', ANSWER_INDEX, '| Answer name:', ANSWER_NAME,
        '| Scan interval:', POLL_INTERVAL_MS, 'ms');

})();
