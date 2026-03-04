// ==UserScript==
// @name         Vote ASAP in the Telegram poll
// @namespace    http://tampermonkey.net/
// @version      18
// @description  Monitors a specific Telegram channel and automatically votes in new polls
// @author       yevgeniy.movsesov@gmail.com
// @match        https://web.telegram.org/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ─── SETTINGS ────────────────────────────────────────────────────────────────
    // Monitoring mode:
    //   "LOOK_BY_NUMBER_OF_POLL_OPTION" — vote by position (1, 2, 3)
    //   "LOOK_BY_NAME_OF_POLL_OPTION"   — vote by the exact text of the option
    const MONITORING_MODE = "LOOK_BY_NUMBER_OF_POLL_OPTION";
    // used in LOOK_BY_NUMBER_OF_POLL_OPTION mode
    const ANSWER_INDEX = 1;
    // How often (ms) to scan for a new unvoted poll
    const POLL_INTERVAL_MS = 100;
    // How long (minutes) to keep monitoring after Ctrl+/ is pressed
    const MONITORING_DURATION_MIN = 10;
    const DEBUG = true;
    // ─────────────────────────────────────────────────────────────────────────────
    // used in LOOK_BY_NAME_OF_POLL_OPTION mode (case-insensitive)
    const ANSWER_NAME = "12:00 - 14:00";
    // ─────────────────────────────────────────────────────────────────────────────

    // Polls that existed when the script first loaded — we ignore them.
    // Uses stable message-ID strings (data-mid) so Telegram's virtual-DOM
    // recycling cannot fool us into voting in an old re-rendered poll.
    const seenAtStart = new Set();
    // Polls we have already voted in during this session.
    const votedPolls = new Set();
    // The highest Telegram message-ID (data-mid) that existed when monitoring
    // started.  Any poll whose mid is ≤ this value is definitively OLD, even
    // if it was scrolled off-screen and not in the DOM during initSeenPolls().
    let maxMidAtStart = -1;

    // ── helpers ──────────────────────────────────────────────────────────────────

    // NOTE: after DOM diagnostics, real Telegram Web selectors are:
    //   polls      → .poll-answers  (was: poll-element)
    //   message ID → [data-message-id]  (was: [data-mid])
    //   answers    → direct children of .poll-answers  (was: .poll-answer / div.circle-hover)

    /** Returns a stable string ID for a .poll-answers element. */
    function getPollId(pollAnswers) {
        const msgEl = pollAnswers.closest('[data-message-id]');
        if (msgEl) return 'msgid:' + msgEl.getAttribute('data-message-id');
        const all = Array.from(document.querySelectorAll('.poll-answers'));
        return 'idx:' + all.indexOf(pollAnswers);
    }

    /** Returns the numeric data-message-id of a poll’s message, or NaN. */
    function getPollMsgId(pollAnswers) {
        const msgEl = pollAnswers.closest('[data-message-id]');
        if (!msgEl) return NaN;
        return parseInt(msgEl.getAttribute('data-message-id'), 10);
    }

    /** True if the poll already shows vote results (voted / closed state). */
    function isPollVoted(pollAnswers) {
        let el = pollAnswers.parentElement;
        while (el && el !== document.body) {
            if (el.classList.contains('is-voted')) return true;
            el = el.parentElement;
        }
        return false;
    }

    /** Extract the visible question/title text from a .poll-answers element. */
    function getPollTitle(pollAnswers) {
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
    function debugDumpDom() {
        if (!DEBUG) return;

        const probes = [
            '.poll-answers', 'poll-element',
            '[data-message-id]', '[data-mid]', '[data-peer-id]',
            '.bubble', '.message',
            '.poll-answer', 'div.circle-hover',
        ];
        console.groupCollapsed(ts() + ' [VoteMonitoringBot] 🔍 DOM diagnostics');
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
            const id = getPollId(p);
            const title = getPollTitle(p);
            const nc = p.children.length;
            const voted = isPollVoted(p);
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
            console.log('  Last poll title on page: “' + getPollTitle(lastPoll) + '”');
        } else {
            console.log('  No .poll-answers found in DOM at this moment.');
        }
        console.groupEnd();
    }

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
        maxMidAtStart = -1;

        // Scan ALL [data-message-id] elements (all visible messages) to get
        // a reliable baseline even when no polls are visible at Ctrl+/ press.
        document.querySelectorAll('[data-message-id]').forEach((el) => {
            const n = parseInt(el.getAttribute('data-message-id'), 10);
            if (!isNaN(n) && n > maxMidAtStart) maxMidAtStart = n;
        });

        // Mark every .poll-answers currently in DOM as pre-existing.
        const polls = Array.from(document.querySelectorAll('.poll-answers'));
        polls.forEach((poll) => {
            const id = getPollId(poll);
            seenAtStart.add(id);
            if (DEBUG) console.log(ts(), `[VoteMonitoringBot]   → pre-existing: ${id} "${getPollTitle(poll)}"`);
        });

        console.log(ts(), `[VoteMonitoringBot] initSeenPolls: ${polls.length} poll(s) marked, maxMidAtStart=${maxMidAtStart}. Waiting for new ones…`);
    }

    /**
     * Find poll elements that appeared AFTER the script loaded and have not
     * been voted in yet. Returns at most 1 — the newest one (last in DOM).
     */
    function findNewUnvotedPoll() {
        const pollContainers = Array.from(document.querySelectorAll('.poll-answers'));

        // Walk from bottom (newest message) upward.
        for (let i = pollContainers.length - 1; i >= 0; i--) {
            const pollAnswers = pollContainers[i];
            const id = getPollId(pollAnswers);

            if (seenAtStart.has(id)) continue;

            // Skip old polls that scrolled into view after monitoring started.
            if (maxMidAtStart >= 0) {
                const mid = getPollMsgId(pollAnswers);
                if (!isNaN(mid) && mid <= maxMidAtStart) {
                    seenAtStart.add(id); // cache to skip next time
                    continue;
                }
            }

            if (votedPolls.has(id)) continue;
            if (isPollVoted(pollAnswers)) continue;
            if (pollAnswers.children.length === 0) continue;

            if (DEBUG) console.log(ts(), `[VoteMonitoringBot] ✅ New poll found — id=${id}, title="${getPollTitle(pollAnswers)}"`);
            return pollAnswers;
        }

        return null;
    }

    /**
     * Click the Nth answer (1-based) inside the given poll element.
     */
    function voteInPoll(pollAnswers) {
        const answers = Array.from(pollAnswers.children);
        if (DEBUG) console.log(ts(), `[VoteMonitoringBot] voteInPoll: ${answers.length} answer(s) in .poll-answers, targeting #${ANSWER_INDEX}`);

        if (answers.length < ANSWER_INDEX) {
            console.warn(ts(), `[VoteMonitoringBot] ❌ Not enough answers: found ${answers.length}, need #${ANSWER_INDEX}`);
            return false;
        }

        const answerEl = answers[ANSWER_INDEX - 1];
        // Prefer an explicitly clickable child; fall back to the row itself.
        const clickTarget = answerEl.querySelector(
            'label, button, input[type="radio"], [role="button"], [role="radio"]'
        ) || answerEl;

        const label = answerEl.textContent.trim().slice(0, 60);
        if (DEBUG) console.log(ts(), `[VoteMonitoringBot] voteInPoll: answerEl=`, answerEl, `clickTarget=`, clickTarget);
        console.log(ts(), `[VoteMonitoringBot] ✅ Clicking answer #${ANSWER_INDEX}: "${label}"`);
        clickTarget.click();
        votedPolls.add(getPollId(pollAnswers));
        return true;
    }

    /**
     * Click the answer whose visible text matches ANSWER_NAME (case-insensitive)
     * inside the given poll element.
     */
    function voteInPollByName(pollAnswers) {
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
        votedPolls.add(getPollId(pollAnswers));
        return true;
    }

    // ── main loop ─────────────────────────────────────────────────────────────────

    function tick() {
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

                // Snapshot polls that exist RIGHT NOW (at the moment Ctrl+/ is pressed).
                // Any poll appearing after this point — even milliseconds later — will be voted in.
                initSeenPolls();
                if (DEBUG) debugDumpDom();
                const intervalId = setInterval(tick, POLL_INTERVAL_MS);

                // Auto-stop after MONITORING_DURATION_MIN minutes.
                setTimeout(() => {
                    clearInterval(intervalId);
                    window._voteBotStarted = false;
                    console.log(ts(), `[VoteMonitoringBot] Monitoring stopped after ${MONITORING_DURATION_MIN} min.`);
                    showToast(`⏹ VoteMonitoringBot: Monitoring stopped after ${MONITORING_DURATION_MIN} min.`, 7000);
                }, MONITORING_DURATION_MIN * 60 * 1000);
            }
        });
    }

    console.log(ts(), '[VoteMonitoringBot] Script loaded. Press combination "Ctrl+/" for monitoring.');
    console.log(ts(), '[VoteMonitoringBot] Mode:', MONITORING_MODE,
        '| Answer index:', ANSWER_INDEX, '| Answer name:', ANSWER_NAME,
        '| Scan interval:', POLL_INTERVAL_MS, 'ms');

})();
