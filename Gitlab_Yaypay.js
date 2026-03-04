// ==UserScript==
// @name         Gitlab_Yaypay
// @namespace    http://tampermonkey.net/
// @version      8
// @description  Automatically clicks the "Expand jobs" button and scrolls to "deploy_yp02"
// @author       yevgeniy.movsesov@gmail.com
// @match        *://*.gitlab.yaypay.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = true;
    const TARGET_JOB_NAME = 'deploy_yp02';

    function log(...args) {
        if (DEBUG) {
            console.log('[Gitlab_Yaypay]', getCurrentTime(), ...args);
        }
    }

    // Function to click the "Expand jobs" button if it exists
    function clickExpandJobsButton(element_to_expand, attempt = 1) {
        log(`Attempting to click: ${element_to_expand} (Attempt ${attempt})`);
        // Find the button with title="Expand jobs"
        const button = document.querySelector(element_to_expand);
        if (button) {
            log(`Button found:`, button);
            // Dispatch a full set of events for max compatibility, especially in Firefox
            button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            button.click(); // Standard click fallback

            log(`Clicked ${element_to_expand} button`);

            // Wait 3000ms for the target to appear, if not, retry the click
            log(`Waiting for span[title="${TARGET_JOB_NAME}"] to appear...`);
            waitForElement(`span[title="${TARGET_JOB_NAME}"]`, 3000).then(() => {
                // Scroll to the element after clicking the button
                log(`Element span[title="${TARGET_JOB_NAME}"] found, waiting for animation...`);
                setTimeout(() => {
                    scrollToElement(`span[title="${TARGET_JOB_NAME}"]`);
                }, 800); // Wait for potential expansion animation
            }).catch(() => {
                log(`Timeout waiting for element span[title="${TARGET_JOB_NAME}"], retrying click...`);
                if (attempt < 5) {
                    // Slight delay before retry to ensure the page has settled
                    setTimeout(() => {
                        clickExpandJobsButton(element_to_expand, attempt + 1);
                    }, 500);
                } else {
                    log(`Max retries reached. Element span[title="${TARGET_JOB_NAME}"] did not appear.`);
                }
            });
        } else {
            log(`Button ${element_to_expand} not found!`);
        }
    }

    // Function to scroll to the element with title="${TARGET_JOB_NAME}"
    function scrollToElement(element_to_scroll) {
        log(`Attempting to scroll to: ${element_to_scroll}`);
        // Find the element
        const targetElement = document.querySelector(element_to_scroll);

        if (targetElement) {
            // Check if element is effectively visible
            if (targetElement.offsetParent === null) {
                console.warn(`[Gitlab_Yaypay] Element ${element_to_scroll} found but appears hidden/not rendered (offsetParent is null). Scroll might fail.`);
            }

            // Make focusable and focus (helps with horizontal positioning in some cases)
            targetElement.setAttribute('tabindex', '-1');
            targetElement.focus({ preventScroll: true });

            // Scroll the element into view
            targetElement.scrollIntoView({
                behavior: 'auto', // Instant instead of smooth to ensure it happens
                block: 'center',
                inline: 'center'
            });
            log(`Successfully scrolled to element ${element_to_scroll}`);
        } else {
            log(`Element ${element_to_scroll} not found for scrolling`);
        }
    }

    function waitForElement(selector, timeout = 10000) {
        log(`Started wait for element: ${selector}`);
        return new Promise((resolve, reject) => {
            const intervalTime = 200;
            let elapsed = 0;
            const interval = setInterval(() => {
                const element = document.querySelector(selector);

                // We just check for element existence now.
                // Checking offsetWidth is sometimes unreliable during SVG render in Firefox.
                if (element) {
                    log(`waitForElement found element: ${selector}`);
                    clearInterval(interval);
                    resolve(element);
                } else {
                    elapsed += intervalTime;
                    if (elapsed >= timeout) {
                        log(`waitForElement timed out looking for: ${selector}`);
                        clearInterval(interval);
                        reject();
                    }
                }
            }, intervalTime);
        });
    }

    function getCurrentTime() {
        return new Date().toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
    }

    function Processing_when_page_loaded() {
        let currentURL = window.location.href;
        log(`Processing_when_page_loaded called. URL: ${currentURL}`);

        if (currentURL.includes('/environments')) {
            waitForElement('a[title="yp02"]').then(() => {
                scrollToElement('a[title="yp02"]');
            });
        } else {
            // Let's use both title="Expand jobs" and data-testid just in case
            const expandSelector = 'button[title="Expand jobs"], button[data-testid="expand-pipeline-button"]';
            log(`Waiting for expand button using selector: ${expandSelector}`);
            waitForElement(expandSelector).then((element) => {
                log(`Initiating click...`);
                clickExpandJobsButton(expandSelector);
            }).catch(() => {
                log(`Timeout in Processing_when_page_loaded for expand selector`);
            });
        }
    }

    function autoReloadEvery5Minutes() {
        setTimeout(() => {
            log(`Auto-reloading page...`);
            location.reload();
        }, 5 * 60 * 1000); // 5 minutes in milliseconds
    }

    autoReloadEvery5Minutes();

    // SPA Route change detector
    // Gitlab often loads pages via JS rather than reloading the HTML
    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            log(`URL changed to ${url}, re-running processing...`);
            Processing_when_page_loaded();
        }
    }).observe(document, { body: true, subtree: true, childList: true });

    log(`Script initialized. Checking readyState...`);
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        log(`Document already loaded (readyState: ${document.readyState}), firing immediately.`);
        setTimeout(Processing_when_page_loaded, 500);
    } else {
        log(`Document not ready, waiting for load event.`);
        window.addEventListener('load', Processing_when_page_loaded);
    }

})();
