// ==UserScript==
// @name         Vote ASAP in the Telegram poll
// @namespace    http://tampermonkey.net/
// @version      31
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
    const ANSWER_INDEX = 1;

    // const MONITORING_MODE = "LOOK_BY_NAME_OF_POLL_OPTION";
    // const ANSWER_NAME = "12:00 - 14:00";

    // Fallback definitions to prevent ReferenceErrors if settings are commented out
    if (typeof ANSWER_NAME === 'undefined') window.ANSWER_NAME = "N/A";

    // Random human-like delay (ms) before clicking
    const MIN_CLICK_DELAY_MS = 90;
    const MAX_CLICK_DELAY_MS = 110;

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

    function normalize(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function parseTimestampCandidate(rawValue) {
        const value = String(rawValue || '').trim();
        if (!value || value.length > 96 || !/\d/.test(value)) return null;
        if (/^\d{1,2}:\d{2}$/.test(value)) return null;

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;

        const year = date.getFullYear();
        const nowYear = new Date().getFullYear();
        if (year < 2014 || year > nowYear + 1) return null;

        return date;
    }

    function extractTimestamp(messageElement) {
        if (!messageElement) return null;

        const candidates = [];
        const nodes = [
            messageElement,
            ...messageElement.querySelectorAll(
                'time[datetime], time, [datetime], [title], [aria-label], [class*="time"], [class*="timestamp"], [class*="meta"]'
            ),
        ];

        nodes.forEach((node) => {
            if (!(node instanceof Element)) return;

            const classText = String(node.className || '').toLowerCase();
            const isLikelyTimeNode =
                node.tagName === 'TIME' ||
                classText.includes('time') ||
                classText.includes('timestamp') ||
                classText.includes('meta');

            [node.getAttribute('datetime'), node.getAttribute('title'), node.getAttribute('aria-label')]
                .filter(Boolean)
                .forEach((value) => candidates.push(value));

            if (isLikelyTimeNode) {
                const text = String(node.textContent || '').trim();
                if (text.length > 0 && text.length <= 48) candidates.push(text);
            }
        });

        for (const candidate of candidates) {
            const parsed = parseTimestampCandidate(candidate);
            if (parsed) return parsed;
        }

        return null;
    }

    function extractTimeOnly(messageElement) {
        if (!messageElement) return null;

        const candidates = [
            messageElement.getAttribute?.('aria-label'),
            messageElement.getAttribute?.('title'),
            messageElement.textContent,
            ...Array.from(
                messageElement.querySelectorAll(
                    'time, [title], [aria-label], [class*="time"], [class*="timestamp"], [class*="meta"]'
                )
            ).flatMap((node) => [
                node.getAttribute('aria-label'),
                node.getAttribute('title'),
                node.textContent,
            ]),
        ].filter(Boolean);

        for (const candidate of candidates) {
            const match = String(candidate).match(/\b(\d{1,2}):(\d{2})\b/);
            if (!match) continue;

            const hours = Number(match[1]);
            const minutes = Number(match[2]);
            if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
                return { hours, minutes, raw: match[0] };
            }
        }

        return null;
    }

    function resolveMonthName(text) {
        const months = {
            january: 0, jan: 0, 'января': 0, 'январь': 0, 'січня': 0, 'січень': 0,
            february: 1, feb: 1, 'февраля': 1, 'февраль': 1, 'лютого': 1, 'лютий': 1,
            march: 2, mar: 2, 'марта': 2, 'март': 2, 'березня': 2, 'березень': 2,
            april: 3, apr: 3, 'апреля': 3, 'апрель': 3, 'квітня': 3, 'квітень': 3,
            may: 4, 'мая': 4, 'травня': 4, 'травень': 4,
            june: 5, jun: 5, 'июня': 5, 'июнь': 5, 'червня': 5, 'червень': 5,
            july: 6, jul: 6, 'июля': 6, 'июль': 6, 'липня': 6, 'липень': 6,
            august: 7, aug: 7, 'августа': 7, 'август': 7, 'серпня': 7, 'серпень': 7,
            september: 8, sep: 8, sept: 8, 'сентября': 8, 'сентябрь': 8, 'вересня': 8, 'вересень': 8,
            october: 9, oct: 9, 'октября': 9, 'октябрь': 9, 'жовтня': 9, 'жовтень': 9,
            november: 10, nov: 10, 'ноября': 10, 'ноябрь': 10, 'листопада': 10, 'листопад': 10,
            december: 11, dec: 11, 'декабря': 11, 'декабрь': 11, 'грудня': 11, 'грудень': 11,
        };

        const normalized = normalize(text);
        for (const [name, index] of Object.entries(months)) {
            if (normalized.includes(name)) return index;
        }
        return null;
    }

    function parseDateLabel(text) {
        const raw = String(text || '').trim();
        const normalized = normalize(raw);
        if (!normalized) return null;

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        if (['today', 'сегодня', 'сьогодні'].includes(normalized)) return today;
        if (['yesterday', 'вчера', 'учора', 'вчора'].includes(normalized)) {
            return new Date(today.getTime() - 24 * 60 * 60 * 1000);
        }

        const numericDateMatch = normalized.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/);
        if (numericDateMatch) {
            const day = Number(numericDateMatch[1]);
            const month = Number(numericDateMatch[2]) - 1;
            let year = numericDateMatch[3] ? Number(numericDateMatch[3]) : now.getFullYear();
            if (year < 100) year += 2000;

            const candidate = new Date(year, month, day);
            if (candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === day) {
                if (!numericDateMatch[3] && candidate.getTime() > today.getTime() + 24 * 60 * 60 * 1000) {
                    candidate.setFullYear(candidate.getFullYear() - 1);
                }
                return candidate;
            }
        }

        const monthIndex = resolveMonthName(normalized);
        const dayMatch = normalized.match(/\b(\d{1,2})\b/) || raw.match(/\b(\d{1,2})\b/);
        if (monthIndex !== null && dayMatch) {
            let year = now.getFullYear();
            const explicitYearMatch = normalized.match(/\b(20\d{2}|19\d{2})\b/);
            if (explicitYearMatch) year = Number(explicitYearMatch[1]);

            const candidate = new Date(year, monthIndex, Number(dayMatch[1]));
            if (candidate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
                candidate.setFullYear(year - 1);
            }
            return candidate;
        }

        return null;
    }

    function findChatScope() {
        return document.querySelector('#MiddleColumn, .messages-container, .MessageList, main') || document.body;
    }

    function compareDomOrder(a, b) {
        if (!a || !b || a === b) return 0;
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
    }

    function findDateMarkers(scope) {
        return Array.from(scope.querySelectorAll('div, span, p, h4, h5, time'))
            .map((element) => {
                const text = String(element.textContent || '').trim();
                if (!text || text.length > 36 || text.includes(':') || text.split(/\s+/).length > 5) return null;

                const date = parseDateLabel(text);
                if (!date) return null;

                return { element, label: text, date };
            })
            .filter(Boolean);
    }

    function resolveFallbackDate(messageElement, dateMarkers) {
        let resolved = null;
        for (const marker of dateMarkers) {
            if (compareDomOrder(marker.element, messageElement) <= 0) {
                resolved = marker.date;
            }
        }
        return resolved;
    }

    function getPollMessageElement(pollEl) {
        return pollEl.closest('[data-message-id], [data-mid], .message, .Message, .message-list-item') || pollEl;
    }

    function getPollTimestamp(pollEl) {
        const messageEl = getPollMessageElement(pollEl);
        const directTimestamp = extractTimestamp(messageEl);
        if (directTimestamp) return directTimestamp;

        const timeOnly = extractTimeOnly(messageEl);
        if (!timeOnly) return null;

        const scope = findChatScope();
        const fallbackDate = resolveFallbackDate(messageEl, findDateMarkers(scope));
        if (!fallbackDate) return null;

        return new Date(
            fallbackDate.getFullYear(),
            fallbackDate.getMonth(),
            fallbackDate.getDate(),
            timeOnly.hours,
            timeOnly.minutes,
            0,
            0
        );
    }

    function isPollNewSinceStart(pollEl) {
        if (!window._voteBotStartedAtMs) return true;

        const pollTimestamp = getPollTimestamp(pollEl);
        if (!pollTimestamp || Number.isNaN(pollTimestamp.getTime())) {
            if (DEBUG) console.warn(ts(), '[VoteMonitoringBot] Could not parse poll timestamp, falling back to DOM/message-id heuristics.');
            return true;
        }

        const isNew = pollTimestamp.getTime() > window._voteBotStartedAtMs;
        if (DEBUG) {
            console.log(
                ts(),
                `[VoteMonitoringBot] Poll timestamp check: poll=${pollTimestamp.toISOString()} start=${new Date(window._voteBotStartedAtMs).toISOString()} isNew=${isNew}`
            );
        }
        return isNew;
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

    function webK_getModernPollContainers() {
        return Array.from(document.querySelectorAll('.message-content.poll'));
    }

    function webK_getModernPollId(pollEl) {
        const msgEl = pollEl.closest('[data-message-id], [data-mid]');
        if (msgEl) {
            const mid = msgEl.getAttribute('data-message-id') || msgEl.getAttribute('data-mid');
            if (mid) return 'modern-msg:' + mid;
        }
        const all = webK_getModernPollContainers();
        return 'modern-idx:' + all.indexOf(pollEl);
    }

    function webK_getModernPollMsgId(pollEl) {
        const msgEl = pollEl.closest('[data-message-id], [data-mid]');
        if (!msgEl) return NaN;
        const raw = msgEl.getAttribute('data-message-id') || msgEl.getAttribute('data-mid');
        return parseInt(raw, 10);
    }

    function webK_isModernPollVoted(pollEl) {
        if (pollEl.classList.contains('is-voted')) return true;
        if (pollEl.querySelector('.icon-check, .poll-voters, .quiz-explanation')) return true;

        const checkedInputs = pollEl.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked');
        if (checkedInputs.length > 0) return true;

        return false;
    }

    function webK_getModernPollTitle(pollEl) {
        const el = pollEl.querySelector('.KaaEAUOh, .poll-title, .poll-question, .media-title, .title, p, h3, h4');
        if (el) return el.textContent.trim();
        return pollEl.textContent.trim().slice(0, 80).replace(/\s+/g, ' ');
    }

    function webK_getModernAnswerElements(pollEl) {
        let answers = Array.from(pollEl.querySelectorAll('.CNKyLQ3u'));
        if (answers.length === 0) {
            answers = Array.from(pollEl.querySelectorAll('input.HAwjpZIq'))
                .map((input) => input.closest('.CNKyLQ3u') || input.closest('label') || input.parentElement)
                .filter(Boolean);
        }
        return answers;
    }

    function webK_getModernAnswerText(answerEl) {
        const textEl = answerEl.querySelector('.asX1G2oq');
        if (textEl) return textEl.textContent.trim();
        return answerEl.textContent.trim().replace(/\s+/g, ' ');
    }

    function webK_getModernClickTarget(answerEl) {
        return answerEl.querySelector('input[type="radio"], input[type="checkbox"]') ||
            answerEl.querySelector('label, [role="radio"], [role="checkbox"], .Transition_slide, .HlcWfAnb') ||
            answerEl;
    }

    function webK_debugDumpDom() {
        if (!DEBUG) return;

        const probes = [
            '.poll-answers', 'poll-element',
            '.message-content.poll', '.message-content.poll .CNKyLQ3u', 'input.HAwjpZIq',
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

        const modernPolls = webK_getModernPollContainers();
        if (modernPolls.length > 0) {
            console.log(`  .message-content.poll count: ${modernPolls.length}`);
            modernPolls.forEach((p, i) => {
                const id = webK_getModernPollId(p);
                console.log(`  modernPoll[${i}]: id=${id} title="${webK_getModernPollTitle(p)}"`);
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
        const modernPolls = webK_getModernPollContainers();
        modernPolls.forEach((poll) => {
            const id = webK_getModernPollId(poll);
            webK_seenAtStart.add(id);
        });
        if (polls.length > 0 || document.querySelectorAll('[data-message-id]').length > 0) {
            console.log(ts(), `[VoteMonitoringBot] (WebK logic) Init: classic=${polls.length}, modern=${modernPolls.length}, maxMidAtStart=${webK_maxMidAtStart}.`);
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
            if (!isPollNewSinceStart(pollAnswers)) {
                webK_seenAtStart.add(id);
                continue;
            }

            return pollAnswers;
        }

        const modernPolls = webK_getModernPollContainers();
        for (let i = modernPolls.length - 1; i >= 0; i--) {
            const pollEl = modernPolls[i];
            const id = webK_getModernPollId(pollEl);

            if (webK_seenAtStart.has(id)) continue;

            if (webK_maxMidAtStart >= 0) {
                const mid = webK_getModernPollMsgId(pollEl);
                if (!isNaN(mid) && mid <= webK_maxMidAtStart) {
                    webK_seenAtStart.add(id);
                    continue;
                }
            }

            if (webK_votedPolls.has(id)) continue;
            if (webK_isModernPollVoted(pollEl)) continue;
            if (webK_getModernAnswerElements(pollEl).length === 0) continue;
            if (!isPollNewSinceStart(pollEl)) {
                webK_seenAtStart.add(id);
                continue;
            }

            return pollEl;
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
        if (pollAnswers.matches('.message-content.poll')) {
            const answers = webK_getModernAnswerElements(pollAnswers);
            if (answers.length < ANSWER_INDEX) return false;

            const answerEl = answers[ANSWER_INDEX - 1];
            const clickTarget = webK_getModernClickTarget(answerEl);
            const label = webK_getModernAnswerText(answerEl).slice(0, 60);

            const delay = Math.floor(Math.random() * (MAX_CLICK_DELAY_MS - MIN_CLICK_DELAY_MS + 1)) + MIN_CLICK_DELAY_MS;
            console.log(ts(), `[VoteMonitoringBot] (WebK modern) Found answer #${ANSWER_INDEX}: "${label}". Delaying click for ${delay}ms...`);

            webK_votedPolls.add(webK_getModernPollId(pollAnswers));

            setTimeout(() => {
                if (clickTarget && clickTarget.isConnected) {
                    clickTarget.click();
                    console.log(ts(), `[VoteMonitoringBot] (WebK modern) Clicked answer #${ANSWER_INDEX}`);
                } else {
                    console.error(ts(), '[VoteMonitoringBot] (WebK modern) Click target lost during delay');
                }
            }, delay);

            return true;
        }

        const answers = webK_getAnswerElements(pollAnswers);
        if (answers.length < ANSWER_INDEX) return false;

        const answerEl = answers[ANSWER_INDEX - 1];
        const clickTarget = answerEl.querySelector('input[type="radio"]') || answerEl;
        const labelEl = answerEl.querySelector('span.label, .Radio-main');
        const label = (labelEl || answerEl).textContent.trim().slice(0, 60);

        const delay = Math.floor(Math.random() * (MAX_CLICK_DELAY_MS - MIN_CLICK_DELAY_MS + 1)) + MIN_CLICK_DELAY_MS;
        console.log(ts(), `[VoteMonitoringBot] (WebK) ✅ Found answer #${ANSWER_INDEX}: "${label}". Delaying click for ${delay}ms...`);

        webK_votedPolls.add(webK_getPollId(pollAnswers));

        setTimeout(() => {
            if (clickTarget && clickTarget.isConnected) {
                clickTarget.click();
                console.log(ts(), `[VoteMonitoringBot] (WebK) 🖱️ Clicked answer #${ANSWER_INDEX}`);
            } else {
                console.error(ts(), '[VoteMonitoringBot] (WebK) ❌ Click target lost during delay');
            }
        }, delay);

        return true;
    }

    function webK_voteInPollByName(pollAnswers) {
        if (pollAnswers.matches('.message-content.poll')) {
            const answers = webK_getModernAnswerElements(pollAnswers);
            let clickTarget = null;
            let matchedText = '';
            for (const answerEl of answers) {
                const text = webK_getModernAnswerText(answerEl);
                if (text.toLowerCase() === ANSWER_NAME.toLowerCase()) {
                    clickTarget = webK_getModernClickTarget(answerEl);
                    matchedText = text;
                    break;
                }
            }
            if (!clickTarget) return false;

            const delay = Math.floor(Math.random() * (MAX_CLICK_DELAY_MS - MIN_CLICK_DELAY_MS + 1)) + MIN_CLICK_DELAY_MS;
            console.log(ts(), `[VoteMonitoringBot] (WebK modern) Found answer "${matchedText}". Human-like delay: ${delay}ms...`);

            webK_votedPolls.add(webK_getModernPollId(pollAnswers));

            setTimeout(() => {
                if (clickTarget && clickTarget.isConnected) {
                    clickTarget.click();
                    console.log(ts(), `[VoteMonitoringBot] (WebK modern) Clicked answer "${matchedText}"`);
                } else {
                    console.error(ts(), '[VoteMonitoringBot] (WebK modern) Click target lost during delay');
                }
            }, delay);

            return true;
        }

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

        const delay = Math.floor(Math.random() * (MAX_CLICK_DELAY_MS - MIN_CLICK_DELAY_MS + 1)) + MIN_CLICK_DELAY_MS;
        console.log(ts(), `[VoteMonitoringBot] (WebK) ✅ Found answer "${matchedText}". Human-like delay: ${delay}ms...`);

        webK_votedPolls.add(webK_getPollId(pollAnswers));

        setTimeout(() => {
            clickTarget.click();
            console.log(ts(), `[VoteMonitoringBot] (WebK) 🖱️ Clicked answer "${matchedText}"`);
        }, delay);

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
            if (!isPollNewSinceStart(poll)) {
                webA_seenAtStart.add(poll);
                continue;
            }

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

        const delay = Math.floor(Math.random() * (MAX_CLICK_DELAY_MS - MIN_CLICK_DELAY_MS + 1)) + MIN_CLICK_DELAY_MS;
        console.log(ts(), `[VoteMonitoringBot] (WebA) ✅ Found answer #${ANSWER_INDEX}. Human-like delay: ${delay}ms...`);

        webA_votedPolls.add(poll);

        setTimeout(() => {
            target.click();
            console.log(ts(), `[VoteMonitoringBot] (WebA) 🖱️ Clicked answer #${ANSWER_INDEX}`);
        }, delay);

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

        const delay = Math.floor(Math.random() * (MAX_CLICK_DELAY_MS - MIN_CLICK_DELAY_MS + 1)) + MIN_CLICK_DELAY_MS;
        console.log(ts(), `[VoteMonitoringBot] (WebA) ✅ Found answer "${ANSWER_NAME}". Human-like delay: ${delay}ms...`);

        webA_votedPolls.add(poll);

        setTimeout(() => {
            target.click();
            console.log(ts(), `[VoteMonitoringBot] (WebA) 🖱️ Clicked answer "${ANSWER_NAME}"`);
        }, delay);

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
        window._voteBotStartedAtMs = Date.now();
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
        '| Answer index:', ANSWER_INDEX, '| Answer name:', (typeof ANSWER_NAME !== 'undefined' ? ANSWER_NAME : 'N/A'),
        '| Scan interval:', POLL_INTERVAL_MS, 'ms',
        '| Click delay:', `${MIN_CLICK_DELAY_MS}-${MAX_CLICK_DELAY_MS}ms`);

})();
