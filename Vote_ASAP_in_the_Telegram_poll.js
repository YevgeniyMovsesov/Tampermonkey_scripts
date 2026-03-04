// ==UserScript==
// @name         Vote ASAP in the Telegram poll
// @namespace    http://tampermonkey.net/
// @version      20
// @description  Monitors a specific Telegram channel and automatically votes in new polls
// @author       yevgeniy.movsesov@gmail.com
// @match        https://web.telegram.org/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ─── BROWSER DETECTION ───────────────────────────────────────────────────────
    const IS_FIREFOX = /Firefox/i.test(navigator.userAgent);
    // ─────────────────────────────────────────────────────────────────────────────

    // ─── SETTINGS ────────────────────────────────────────────────────────────────
    // Monitoring mode:
    //   "LOOK_BY_NUMBER_OF_POLL_OPTION" — vote by position (1, 2, 3)
    //   "LOOK_BY_NAME_OF_POLL_OPTION"   — vote by the exact text of the option
    const MONITORING_MODE = "LOOK_BY_NUMBER_OF_POLL_OPTION";
    // used in LOOK_BY_NUMBER_OF_POLL_OPTION mode
    const ANSWER_INDEX = 1;
    // used in LOOK_BY_NAME_OF_POLL_OPTION mode (case-insensitive)
    const ANSWER_NAME = "12:00 - 14:00";
    // How often (ms) to scan for a new unvoted poll
    const POLL_INTERVAL_MS = 100;
    // How long (minutes) to keep monitoring after Ctrl+/ is pressed
    const MONITORING_DURATION_MIN = 10;
    // Delay (ms) after Ctrl+/ before starting scan loop (Chrome only)
    const STARTUP_DELAY_MS = 3000;
    const DEBUG = true;
    // ─────────────────────────────────────────────────────────────────────────────

    // ── common helpers ───────────────────────────────────────────────────────────

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

    // ═══════════════════════════════════════════════════════════════════════════════
    // ══  FIREFOX implementation  ══════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════════════

    // NOTE: Firefox / Telegram Web K uses:
    //   polls      → .poll-answers
    //   message ID → [data-message-id]
    //   answers    → direct children of .poll-answers

    // Polls that existed when Ctrl+/ was pressed — never vote in these.
    // Uses stable string IDs so virtual-DOM recycling cannot fool us.
    const ff_seenAtStart = new Set();
    // Polls we have already voted in during this session.
    const ff_votedPolls = new Set();
    // The highest data-message-id at the moment monitoring started.
    let ff_maxMidAtStart = -1;

    /** Returns a stable string ID for a .poll-answers element. */
    function ff_getPollId(pollAnswers) {
        const msgEl = pollAnswers.closest('[data-message-id]');
        if (msgEl) return 'msgid:' + msgEl.getAttribute('data-message-id');
        const all = Array.from(document.querySelectorAll('.poll-answers'));
        return 'idx:' + all.indexOf(pollAnswers);
    }

    /** Returns the numeric data-message-id of a poll's message, or NaN. */
    function ff_getPollMsgId(pollAnswers) {
        const msgEl = pollAnswers.closest('[data-message-id]');
        if (!msgEl) return NaN;
        return parseInt(msgEl.getAttribute('data-message-id'), 10);
    }

    /** True if the poll already shows vote results (voted / closed state). */
    function ff_isPollVoted(pollAnswers) {
        let el = pollAnswers.parentElement;
        while (el && el !== document.body) {
            if (el.classList.contains('is-voted')) return true;
            el = el.parentElement;
        }
        return false;
    }

    /** Extract the visible question/title text from a .poll-answers element. */
    function ff_getPollTitle(pollAnswers) {
        const container = pollAnswers.parentElement;
        if (!container) return '(no parent)';
        const el = container.querySelector('.poll-title, .poll-question, .media-title, .title, p, h3, h4');
        if (el) return el.textContent.trim();
        return container.textContent.trim().slice(0, 80).replace(/\s+/g, ' ');
    }

    /**
     * Print a DOM structure diagnostic to the console.
     * Runs once at Ctrl+/ press when DEBUG is true.
     */
    function ff_debugDumpDom() {
        if (!DEBUG) return;

        const probes = [
            '.poll-answers', 'poll-element',
            '[data-message-id]', '[data-mid]', '[data-peer-id]',
            '.bubble', '.message',
            '.poll-answer', 'div.circle-hover',
        ];
        console.groupCollapsed(ts() + ' [VoteMonitoringBot] 🔍 DOM diagnostics (Firefox)');
        probes.forEach(sel => {
            const cnt = document.querySelectorAll(sel).length;
            console.log(cnt > 0 ? `  ✅ "${sel}" → ${cnt}` : `  ❌ "${sel}" → 0`);
        });

        const firstMsg = document.querySelector('[data-message-id]');
        if (firstMsg) {
            const attrs = Array.from(firstMsg.attributes).map(a => `${a.name}="${a.value.slice(0, 40)}"`).join(', ');
            console.log('  First [data-message-id] attrs:', attrs);
        }

        const polls = Array.from(document.querySelectorAll('.poll-answers'));
        console.log(`  .poll-answers count: ${polls.length}`);
        polls.forEach((p, i) => {
            const id = ff_getPollId(p);
            const title = ff_getPollTitle(p);
            const nc = p.children.length;
            const voted = ff_isPollVoted(p);
            console.log(`  poll[${i}]: id=${id}  children=${nc}  voted=${voted}  title="${title}"`);
            if (nc > 0) {
                const fc = p.children[0];
                const fcAttrs = Array.from(fc.attributes).map(a => `${a.name}="${a.value.slice(0, 30)}"`).join(', ');
                console.log(`    answer[0] <${fc.tagName.toLowerCase()}> ${fcAttrs}`);
                console.log(`    answer[0] text: "${fc.textContent.trim().slice(0, 60)}"`);
            }
        });

        const lastPoll = polls[polls.length - 1];
        if (lastPoll) {
            console.log('  Last poll title on page: "' + ff_getPollTitle(lastPoll) + '"');
        } else {
            console.log('  No .poll-answers found in DOM at this moment.');
        }
        console.groupEnd();
    }

    /**
     * On startup: mark every poll currently in the DOM as "pre-existing".
     */
    function ff_initSeenPolls() {
        ff_maxMidAtStart = -1;

        // Scan ALL [data-message-id] elements to get a reliable baseline.
        document.querySelectorAll('[data-message-id]').forEach((el) => {
            const n = parseInt(el.getAttribute('data-message-id'), 10);
            if (!isNaN(n) && n > ff_maxMidAtStart) ff_maxMidAtStart = n;
        });

        const polls = Array.from(document.querySelectorAll('.poll-answers'));
        polls.forEach((poll) => {
            const id = ff_getPollId(poll);
            ff_seenAtStart.add(id);
            if (DEBUG) console.log(ts(), `[VoteMonitoringBot]   → pre-existing: ${id} "${ff_getPollTitle(poll)}"`);
        });

        console.log(ts(), `[VoteMonitoringBot] initSeenPolls: ${polls.length} poll(s) marked, maxMidAtStart=${ff_maxMidAtStart}. Waiting for new ones…`);
    }

    /**
     * Find the newest unvoted new poll. Returns at most 1.
     */
    function ff_findNewUnvotedPoll() {
        const pollContainers = Array.from(document.querySelectorAll('.poll-answers'));

        for (let i = pollContainers.length - 1; i >= 0; i--) {
            const pollAnswers = pollContainers[i];
            const id = ff_getPollId(pollAnswers);

            if (ff_seenAtStart.has(id)) continue;

            // Skip old polls that scrolled into view after monitoring started.
            if (ff_maxMidAtStart >= 0) {
                const mid = ff_getPollMsgId(pollAnswers);
                if (!isNaN(mid) && mid <= ff_maxMidAtStart) {
                    ff_seenAtStart.add(id);
                    continue;
                }
            }

            if (ff_votedPolls.has(id)) continue;
            if (ff_isPollVoted(pollAnswers)) continue;
            if (pollAnswers.children.length === 0) continue;

            if (DEBUG) console.log(ts(), `[VoteMonitoringBot] ✅ New poll found — id=${id}, title="${ff_getPollTitle(pollAnswers)}"`);
            return pollAnswers;
        }

        return null;
    }

    /** Click the Nth answer (1-based) inside the given poll element (Firefox). */
    function ff_voteInPoll(pollAnswers) {
        const answers = Array.from(pollAnswers.children);
        if (DEBUG) console.log(ts(), `[VoteMonitoringBot] voteInPoll: ${answers.length} answer(s) in .poll-answers, targeting #${ANSWER_INDEX}`);

        if (answers.length < ANSWER_INDEX) {
            console.warn(ts(), `[VoteMonitoringBot] ❌ Not enough answers: found ${answers.length}, need #${ANSWER_INDEX}`);
            return false;
        }

        const answerEl = answers[ANSWER_INDEX - 1];
        const clickTarget = answerEl.querySelector(
            'label, button, input[type="radio"], [role="button"], [role="radio"]'
        ) || answerEl;

        const label = answerEl.textContent.trim().slice(0, 60);
        if (DEBUG) console.log(ts(), `[VoteMonitoringBot] voteInPoll: answerEl=`, answerEl, `clickTarget=`, clickTarget);
        console.log(ts(), `[VoteMonitoringBot] ✅ Clicking answer #${ANSWER_INDEX}: "${label}"`);
        clickTarget.click();
        ff_votedPolls.add(ff_getPollId(pollAnswers));
        return true;
    }

    /** Click the answer matching ANSWER_NAME (Firefox). */
    function ff_voteInPollByName(pollAnswers) {
        const answers = Array.from(pollAnswers.children);
        if (DEBUG) console.log(ts(), `[VoteMonitoringBot] voteInPollByName: ${answers.length} answer(s), looking for "${ANSWER_NAME}"`);

        let clickTarget = null;

        for (const answerEl of answers) {
            const text = answerEl.textContent.trim();
            if (DEBUG) console.log(ts(), `[VoteMonitoringBot]   option: "${text.slice(0, 60)}" — match=${text.toLowerCase() === ANSWER_NAME.toLowerCase()}`);
            if (text.toLowerCase() === ANSWER_NAME.toLowerCase()) {
                clickTarget = answerEl.querySelector(
                    'label, button, input[type="radio"], [role="button"], [role="radio"]'
                ) || answerEl;
                if (DEBUG) console.log(ts(), `[VoteMonitoringBot]   clickTarget=`, clickTarget);
                break;
            }
        }

        if (!clickTarget) {
            console.warn(ts(), `[VoteMonitoringBot] ❌ Could not find answer named "${ANSWER_NAME}"`);
            return false;
        }

        console.log(ts(), `[VoteMonitoringBot] ✅ Clicking answer "${ANSWER_NAME}":`, clickTarget);
        clickTarget.click();
        ff_votedPolls.add(ff_getPollId(pollAnswers));
        return true;
    }

    function ff_tick() {
        const poll = ff_findNewUnvotedPoll();
        if (!poll) return;

        if (MONITORING_MODE === "LOOK_BY_NAME_OF_POLL_OPTION") {
            ff_voteInPollByName(poll);
        } else {
            ff_voteInPoll(poll);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ══  CHROME implementation  ═══════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════════════

    // NOTE: Chrome / Telegram Web A uses:
    //   polls   → poll-element  (custom element)
    //   answers → div.circle-hover  inside .poll-answer rows
    //   voted   → .is-voted on .bubble or poll-element itself

    const ch_seenAtStart = new WeakSet();
    const ch_votedPolls = new WeakSet();

    /**
     * On startup: mark every poll currently in the DOM as "pre-existing".
     */
    function ch_initSeenPolls() {
        document.querySelectorAll('poll-element').forEach((poll) => {
            ch_seenAtStart.add(poll);
        });
        console.log(ts(), '[VoteMonitoringBot] (Chrome) Pre-marked existing polls as seen. Waiting for new ones…');
    }

    /**
     * Find the newest unvoted new poll. Returns at most 1.
     */
    function ch_findNewUnvotedPoll() {
        const pollElements = Array.from(document.querySelectorAll('poll-element'));

        for (let i = pollElements.length - 1; i >= 0; i--) {
            const poll = pollElements[i];

            if (ch_seenAtStart.has(poll)) continue;
            if (ch_votedPolls.has(poll)) continue;

            const bubble = poll.closest('.bubble');
            if (bubble && bubble.classList.contains('is-voted')) continue;
            if (poll.classList.contains('is-voted')) continue;

            const answers = poll.querySelectorAll('div.circle-hover');
            if (answers.length === 0) continue;

            return poll;
        }

        return null;
    }

    /** Click the Nth answer (1-based) inside the given poll element (Chrome). */
    function ch_voteInPoll(poll) {
        const answerRows = poll.querySelectorAll('.poll-answer');

        let target = null;

        if (answerRows.length >= ANSWER_INDEX) {
            const row = answerRows[ANSWER_INDEX - 1];
            target = row.querySelector('div.circle-hover > div') ||
                row.querySelector('div.circle-hover');
        } else {
            const circles = poll.querySelectorAll('div.circle-hover > div');
            if (circles.length >= ANSWER_INDEX) {
                target = circles[ANSWER_INDEX - 1];
            }
        }

        if (!target) {
            console.warn(ts(), `[VoteMonitoringBot] (Chrome) Could not find answer #${ANSWER_INDEX} in poll:`, poll);
            return false;
        }

        console.log(ts(), `[VoteMonitoringBot] (Chrome) ✅ Voting for answer #${ANSWER_INDEX} in poll:`, poll);
        target.click();
        ch_votedPolls.add(poll);
        return true;
    }

    /** Click the answer matching ANSWER_NAME (Chrome). */
    function ch_voteInPollByName(poll) {
        const answerRows = poll.querySelectorAll('.poll-answer');

        let target = null;

        for (const row of answerRows) {
            const textEl = row.querySelector('.poll-answer-text') || row;
            const text = textEl.textContent.trim();
            if (DEBUG) console.log(ts(), `[VoteMonitoringBot] (Chrome) Answer option: "${text}"`);
            if (text.toLowerCase() === ANSWER_NAME.toLowerCase()) {
                target = row.querySelector('div.circle-hover > div') ||
                    row.querySelector('div.circle-hover');
                break;
            }
        }

        if (!target) {
            console.warn(ts(), `[VoteMonitoringBot] (Chrome) Could not find answer named "${ANSWER_NAME}" in poll:`, poll);
            return false;
        }

        console.log(ts(), `[VoteMonitoringBot] (Chrome) ✅ Voting for answer "${ANSWER_NAME}":`, target);
        target.click();
        ch_votedPolls.add(poll);
        return true;
    }

    function ch_tick() {
        const poll = ch_findNewUnvotedPoll();
        if (!poll) return;

        if (MONITORING_MODE === "LOOK_BY_NAME_OF_POLL_OPTION") {
            ch_voteInPollByName(poll);
        } else {
            ch_voteInPoll(poll);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ══  SHARED: keyboard trigger  ════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════════════
    //
    // Telegram Web is an SPA: Tampermonkey may re-inject this script on every
    // navigation, creating multiple IIFE instances — each with its own closure
    // and its own keydown listener on the same document.  To prevent the
    // "already running" false-positive we store both flags on `window` so every
    // instance shares the same state.

    if (window._voteBotStarted === undefined) window._voteBotStarted = false;

    if (!window._voteBotListenerAdded) {
        window._voteBotListenerAdded = true;

        document.addEventListener('keydown', (e) => {
            // Ctrl+/ (key '/' with Ctrl held, no other modifiers)
            if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey &&
                (e.key === '/' || e.code === 'Slash')) {

                e.preventDefault();

                if (e.repeat) return;

                // Debounce: Telegram re-dispatches keyboard events synthetically.
                const now = Date.now();
                if (now - (window._voteBotLastTrigger || 0) < 500) return;
                window._voteBotLastTrigger = now;

                if (window._voteBotStarted) {
                    console.log(ts(), '[VoteMonitoringBot] Monitoring already running — ignoring Ctrl+/');
                    showToast('⚡ VoteMonitoringBot: Monitoring already running — ignoring Ctrl+/');
                    return;
                }

                window._voteBotStarted = true;
                const browser = IS_FIREFOX ? 'Firefox' : 'Chrome';
                console.log(ts(), `[VoteMonitoringBot] (${browser}) Now monitoring during ${MONITORING_DURATION_MIN} min.`);
                showToast(`VoteMonitoringBot (${browser}): Monitoring for ${MONITORING_DURATION_MIN} min.`, 7000);

                if (IS_FIREFOX) {
                    // Firefox: snapshot polls right now, then start polling immediately.
                    ff_initSeenPolls();
                    if (DEBUG) ff_debugDumpDom();
                    const intervalId = setInterval(ff_tick, POLL_INTERVAL_MS);

                    setTimeout(() => {
                        clearInterval(intervalId);
                        window._voteBotStarted = false;
                        console.log(ts(), `[VoteMonitoringBot] (Firefox) Monitoring stopped after ${MONITORING_DURATION_MIN} min.`);
                        showToast(`⏹ VoteMonitoringBot (Firefox): Monitoring stopped after ${MONITORING_DURATION_MIN} min.`, 7000);
                    }, MONITORING_DURATION_MIN * 60 * 1000);

                } else {
                    // Chrome: wait STARTUP_DELAY_MS for the page to settle, then start.
                    setTimeout(() => {
                        ch_initSeenPolls();
                        const intervalId = setInterval(ch_tick, POLL_INTERVAL_MS);

                        setTimeout(() => {
                            clearInterval(intervalId);
                            window._voteBotStarted = false;
                            console.log(ts(), `[VoteMonitoringBot] (Chrome) Monitoring stopped after ${MONITORING_DURATION_MIN} min.`);
                            showToast(`⏹ VoteMonitoringBot (Chrome): Monitoring stopped after ${MONITORING_DURATION_MIN} min.`, 7000);
                        }, MONITORING_DURATION_MIN * 60 * 1000);
                    }, STARTUP_DELAY_MS);
                }
            }
        });
    }

    const browser = IS_FIREFOX ? 'Firefox' : 'Chrome';
    console.log(ts(), `[VoteMonitoringBot] Script loaded (${browser}). Press "Ctrl+/" to start monitoring.`);
    console.log(ts(), '[VoteMonitoringBot] Mode:', MONITORING_MODE,
        '| Answer index:', ANSWER_INDEX, '| Answer name:', ANSWER_NAME,
        '| Scan interval:', POLL_INTERVAL_MS, 'ms');

})();
