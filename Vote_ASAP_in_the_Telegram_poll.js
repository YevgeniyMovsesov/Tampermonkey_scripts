// ==UserScript==
// @name         Vote ASAP in the Telegram poll
// @namespace    http://tampermonkey.net/
// @version      28
// @description  Monitors a specific Telegram channel and automatically votes in new polls
// @author       yevgeniy.movsesov@gmail.com
// @match        https://web.telegram.org/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ─── SETTINGS ────────────────────────────────────────────────────────────────
    // Trigger mode — when the script should start monitoring:
    //   "HOTKEY" — wait for Ctrl+/ to be pressed (current behaviour)
    //   "INSTANTLY"   — start monitoring immediately when the page loads
    const TRIGGER_MODE = "INSTANTLY";
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
    // How long (minutes) to keep monitoring after start
    const MONITORING_DURATION_MIN = 10;
    // Delay (ms) before starting scan loop (useful for UI settling)
    const STARTUP_DELAY_MS = 1000;
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
    // ══  Telegram WebK implementation (.poll-answers, [data-message-id])  ══════════
    // ═══════════════════════════════════════════════════════════════════════════════

    const webK_seenAtStart = new Set();
    const webK_votedPolls = new Set();
    let webK_maxMidAtStart = -1;

    function webK_getPollId(pollAnswers) {
        const msgEl = pollAnswers.closest('[data-message-id]');
        if (msgEl) return 'msgid:' + msgEl.getAttribute('data-message-id');
        const all = Array.from(document.querySelectorAll('.poll-answers'));
        return 'idx:' + all.indexOf(pollAnswers);
    }

    function webK_getPollMsgId(pollAnswers) {
        const msgEl = pollAnswers.closest('[data-message-id]');
        if (!msgEl) return NaN;
        return parseInt(msgEl.getAttribute('data-message-id'), 10);
    }

    function webK_isPollVoted(pollAnswers) {
        let el = pollAnswers.parentElement;
        while (el && el !== document.body) {
            if (el.classList.contains('is-voted')) return true;
            el = el.parentElement;
        }
        return false;
    }

    function webK_getPollTitle(pollAnswers) {
        const container = pollAnswers.parentElement;
        if (!container) return '(no parent)';
        const el = container.querySelector('.poll-title, .poll-question, .media-title, .title, p, h3, h4');
        if (el) return el.textContent.trim();
        return container.textContent.trim().slice(0, 80).replace(/\s+/g, ' ');
    }

    function webK_debugDumpDom() {
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

        const firstMsg = document.querySelector('[data-message-id]') || document.querySelector('[data-mid]');
        if (firstMsg) {
            const attrs = Array.from(firstMsg.attributes).map(a => `${a.name}="${a.value.slice(0, 40)}"`).join(', ');
            console.log('  First msg element attrs:', attrs);
        }

        const polls = Array.from(document.querySelectorAll('.poll-answers'));
        if (polls.length > 0) {
            console.log(`  .poll-answers count: ${polls.length}`);
            polls.forEach((p, i) => {
                const id = webK_getPollId(p);
                console.log(`  poll[${i}]: id=${id} title="${webK_getPollTitle(p)}"`);
            });
        }
        console.groupEnd();
    }

    function webK_initSeenPolls() {
        webK_maxMidAtStart = -1;
        document.querySelectorAll('[data-message-id]').forEach((el) => {
            const n = parseInt(el.getAttribute('data-message-id'), 10);
            if (!isNaN(n) && n > webK_maxMidAtStart) webK_maxMidAtStart = n;
        });

        const polls = Array.from(document.querySelectorAll('.poll-answers'));
        polls.forEach((poll) => {
            const id = webK_getPollId(poll);
            webK_seenAtStart.add(id);
        });
        if (polls.length > 0 || document.querySelectorAll('[data-message-id]').length > 0) {
            console.log(ts(), `[VoteMonitoringBot] (WebK logic) Init: ${polls.length} poll(s) marked, maxMidAtStart=${webK_maxMidAtStart}.`);
        }
    }

    function webK_findNewUnvotedPoll() {
        const pollContainers = Array.from(document.querySelectorAll('.poll-answers'));
        for (let i = pollContainers.length - 1; i >= 0; i--) {
            const pollAnswers = pollContainers[i];
            const id = webK_getPollId(pollAnswers);

            if (webK_seenAtStart.has(id)) continue;

            if (webK_maxMidAtStart >= 0) {
                const mid = webK_getPollMsgId(pollAnswers);
                if (!isNaN(mid) && mid <= webK_maxMidAtStart) {
                    webK_seenAtStart.add(id);
                    continue;
                }
            }

            if (webK_votedPolls.has(id)) continue;
            if (webK_isPollVoted(pollAnswers)) continue;
            if (pollAnswers.children.length === 0) continue;

            return pollAnswers;
        }
        return null;
    }

    /** Find individual answer elements inside a .poll-answers container. */
    function webK_getAnswerElements(pollAnswers) {
        // Telegram WebK: answers are <label class="Radio"> inside a .radio-group
        let answers = Array.from(pollAnswers.querySelectorAll('label.Radio'));
        if (answers.length === 0) {
            answers = Array.from(pollAnswers.querySelectorAll('.poll-answer'));
        }
        if (answers.length === 0) {
            answers = Array.from(pollAnswers.children);
        }
        return answers;
    }

    function webK_voteInPoll(pollAnswers) {
        const answers = webK_getAnswerElements(pollAnswers);
        if (answers.length < ANSWER_INDEX) return false;

        const answerEl = answers[ANSWER_INDEX - 1];
        const clickTarget = answerEl.querySelector('input[type="radio"]') || answerEl;
        const labelEl = answerEl.querySelector('span.label, .Radio-main');
        const label = (labelEl || answerEl).textContent.trim().slice(0, 60);

        console.log(ts(), `[VoteMonitoringBot] (WebK) ✅ Clicking answer #${ANSWER_INDEX}: "${label}"`);
        clickTarget.click();
        webK_votedPolls.add(webK_getPollId(pollAnswers));
        return true;
    }

    function webK_voteInPollByName(pollAnswers) {
        const answers = webK_getAnswerElements(pollAnswers);
        let clickTarget = null;
        let matchedText = '';
        for (const answerEl of answers) {
            const labelEl = answerEl.querySelector('span.label, .Radio-main');
            const text = (labelEl || answerEl).textContent.trim();
            if (text.toLowerCase() === ANSWER_NAME.toLowerCase()) {
                clickTarget = answerEl.querySelector('input[type="radio"]') || answerEl;
                matchedText = text;
                break;
            }
        }
        if (!clickTarget) return false;

        console.log(ts(), `[VoteMonitoringBot] (WebK) ✅ Clicking answer "${matchedText}"`);
        clickTarget.click();
        webK_votedPolls.add(webK_getPollId(pollAnswers));
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ══  Telegram WebA implementation (poll-element, [data-mid])  ══════════════════
    // ═══════════════════════════════════════════════════════════════════════════════

    const webA_seenAtStart = new WeakSet();
    const webA_votedPolls = new WeakSet();

    function webA_initSeenPolls() {
        const polls = document.querySelectorAll('poll-element');
        polls.forEach((poll) => {
            webA_seenAtStart.add(poll);
        });
        if (polls.length > 0 || document.querySelectorAll('[data-mid]').length > 0) {
            console.log(ts(), `[VoteMonitoringBot] (WebA logic) Init: Pre-marked ${polls.length} existing polls as seen.`);
        }
    }

    function webA_findNewUnvotedPoll() {
        const pollElements = Array.from(document.querySelectorAll('poll-element'));
        for (let i = pollElements.length - 1; i >= 0; i--) {
            const poll = pollElements[i];

            if (webA_seenAtStart.has(poll)) continue;
            if (webA_votedPolls.has(poll)) continue;

            const bubble = poll.closest('.bubble');
            if (bubble && bubble.classList.contains('is-voted')) continue;
            if (poll.classList.contains('is-voted')) continue;

            const answers = poll.querySelectorAll('div.circle-hover');
            if (answers.length === 0) continue;

            return poll;
        }
        return null;
    }

    function webA_voteInPoll(poll) {
        const answerRows = poll.querySelectorAll('.poll-answer');
        let target = null;
        if (answerRows.length >= ANSWER_INDEX) {
            const row = answerRows[ANSWER_INDEX - 1];
            target = row.querySelector('div.circle-hover > div') || row.querySelector('div.circle-hover');
        } else {
            const circles = poll.querySelectorAll('div.circle-hover > div');
            if (circles.length >= ANSWER_INDEX) {
                target = circles[ANSWER_INDEX - 1];
            }
        }

        if (!target) return false;

        console.log(ts(), `[VoteMonitoringBot] (WebA) ✅ Voting for answer #${ANSWER_INDEX}`);
        target.click();
        webA_votedPolls.add(poll);
        return true;
    }

    function webA_voteInPollByName(poll) {
        const answerRows = poll.querySelectorAll('.poll-answer');
        let target = null;
        for (const row of answerRows) {
            const textEl = row.querySelector('.poll-answer-text') || row;
            const text = textEl.textContent.trim();
            if (text.toLowerCase() === ANSWER_NAME.toLowerCase()) {
                target = row.querySelector('div.circle-hover > div') || row.querySelector('div.circle-hover');
                break;
            }
        }
        if (!target) return false;

        console.log(ts(), `[VoteMonitoringBot] (WebA) ✅ Voting for answer "${ANSWER_NAME}"`);
        target.click();
        webA_votedPolls.add(poll);
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ══  SHARED: trigger & main loop  ══════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════════════

    function tick() {
        // Try WebK logic first (Telegram Web K)
        const pollK = webK_findNewUnvotedPoll();
        if (pollK) {
            let voted;
            if (MONITORING_MODE === "LOOK_BY_NAME_OF_POLL_OPTION") voted = webK_voteInPollByName(pollK);
            else voted = webK_voteInPoll(pollK);
            if (voted) return;
            // WebK found a poll but couldn't vote — dump structure once and try WebA
            if (!window._webK_dumpDone) {
                window._webK_dumpDone = true;
                console.warn(ts(), '[VoteMonitoringBot] (WebK) ⚠ Found poll but could not vote. Poll HTML:\n', pollK.innerHTML);
            }
        }

        // Fallback to WebA logic (Telegram Web A)
        const pollA = webA_findNewUnvotedPoll();
        if (pollA) {
            let voted;
            if (MONITORING_MODE === "LOOK_BY_NAME_OF_POLL_OPTION") voted = webA_voteInPollByName(pollA);
            else voted = webA_voteInPoll(pollA);
            if (voted) return;
            if (!window._webA_dumpDone) {
                window._webA_dumpDone = true;
                console.warn(ts(), '[VoteMonitoringBot] (WebA) ⚠ Found poll but could not vote. Poll HTML:\n', pollA.innerHTML);
            }
        }
    }

    /** Shared logic: initialises seen-polls, starts the scan loop, schedules auto-stop. */
    function startMonitoring(triggerLabel) {
        if (window._voteBotStarted) {
            console.log(ts(), `[VoteMonitoringBot] Monitoring already running — ignoring ${triggerLabel}`);
            showToast(`⚡ VoteMonitoringBot: Monitoring already running — ignoring ${triggerLabel}`);
            return;
        }

        window._voteBotStarted = true;
        console.log(ts(), `[VoteMonitoringBot] Now monitoring for ${MONITORING_DURATION_MIN} min. (trigger: ${triggerLabel})`);
        const endTime = new Date(Date.now() + MONITORING_DURATION_MIN * 60 * 1000);
        const endHH = String(endTime.getHours()).padStart(2, '0');
        const endMM = String(endTime.getMinutes()).padStart(2, '0');
        showToast(`VoteMonitoringBot: Monitoring for ${MONITORING_DURATION_MIN} min. until ${endHH}:${endMM} (trigger: ${triggerLabel})`, MONITORING_DURATION_MIN * 60 * 1000);

        if (DEBUG) webK_debugDumpDom();

        // Wait a tiny bit (STARTUP_DELAY_MS) in case the page needs to populate
        setTimeout(() => {
            webK_initSeenPolls();
            webA_initSeenPolls();

            const intervalId = setInterval(tick, POLL_INTERVAL_MS);

            setTimeout(() => {
                clearInterval(intervalId);
                window._voteBotStarted = false;
                console.log(ts(), `[VoteMonitoringBot] Monitoring stopped after ${MONITORING_DURATION_MIN} min.`);
                showToast(`⏹ VoteMonitoringBot: Monitoring stopped after ${MONITORING_DURATION_MIN} min.`, 7000);
            }, MONITORING_DURATION_MIN * 60 * 1000);
        }, STARTUP_DELAY_MS);
    }

    // ── Keyboard trigger (always registered so Ctrl+/ works in any mode) ──────────
    if (window._voteBotStarted === undefined) window._voteBotStarted = false;

    if (!window._voteBotListenerAdded) {
        window._voteBotListenerAdded = true;

        document.addEventListener('keydown', (e) => {
            // Ctrl+/ (key '/' with Ctrl held, no other modifiers)
            if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey &&
                (e.key === '/' || e.code === 'Slash')) {

                e.preventDefault();
                if (e.repeat) return;

                const now = Date.now();
                if (now - (window._voteBotLastTrigger || 0) < 500) return;
                window._voteBotLastTrigger = now;

                startMonitoring('Ctrl+/');
            }
        });
    }

    // ── Auto-start (if TRIGGER_MODE is "INSTANTLY") ────────────────────────────────────
    if (TRIGGER_MODE === "INSTANTLY") {
        console.log(ts(), '[VoteMonitoringBot] TRIGGER_MODE=INSTANTLY — starting monitoring automatically.');
        startMonitoring('INSTANTLY');
    } else {
        console.log(ts(), '[VoteMonitoringBot] TRIGGER_MODE=HOTKEY — press "Ctrl+/" to start monitoring.');
    }

    console.log(ts(), '[VoteMonitoringBot] Script loaded. Supports multiple Telegram structural versions.');
    console.log(ts(), '[VoteMonitoringBot] Trigger:', TRIGGER_MODE,
        '| Mode:', MONITORING_MODE,
        '| Answer index:', ANSWER_INDEX, '| Answer name:', ANSWER_NAME,
        '| Scan interval:', POLL_INTERVAL_MS, 'ms');

})();
