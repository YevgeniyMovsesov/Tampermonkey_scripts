// ==UserScript==
// @name         Gitlab_Yaypay
// @namespace    http://tampermonkey.net/
// @version      13
// @description  Automatically clicks the "Expand jobs" button and scrolls to "deploy_yp02"
// @author       yevgeniy.movsesov@gmail.com
// @match        *://*.gitlab.yaypay.com/*

// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = true;
    const DOWNSTREAM_PIPELINE_JOB_NAME = 'deploy_ms';
    const TARGET_JOB_NAME_LOCATOR = 'h2[title="deploy_yp02"]';
    const AUTO_RELOAD_DELAY_MS = 2 * 60 * 1000;
    const AUTO_RELOAD_SESSION_KEY = 'gitlab_yaypay_auto_reload_after_target';
    let autoReloadTimeoutId = null;

    function log(...args) {
        if (DEBUG) {
            console.log(/*'[Gitlab_Yaypay]', getCurrentTime(), */...args);
        }
    }

    function dispatchClickSequence(button, log_prefix) {
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        button.click(); // Standard click fallback
        log(`[${log_prefix}]: Click sequence dispatched.`);
    }

    // Function to click the "Expand jobs" button if it exists
    function clickExpandJobsButton(element_to_expand, attempt = 1) {
        log(`[clickExpandJobsButton]: Attempting to click: ${element_to_expand} (Attempt ${attempt})`);
        // Find the button with title="Expand jobs"
        const button = document.querySelector(element_to_expand);
        if (button) {
            log(`[clickExpandJobsButton]: Button found:`, button);
            dispatchClickSequence(button, 'clickExpandJobsButton');
            log(`[clickExpandJobsButton]: Clicked ${element_to_expand} button`);
            waitForTargetJobAndScroll(() => clickExpandJobsButton(element_to_expand, attempt + 1), attempt);
        } else {
            log(`[clickExpandJobsButton]: Button ${element_to_expand} not found!`);
        }
    }

    function findDownstreamPipelineContainer(downstream_job_name) {
        const containers = document.querySelectorAll('[data-testid="linked-pipeline-container"]');
        return Array.from(containers).find((container) => {
            const titleElement = container.querySelector('[data-testid="downstream-title-content"]');
            return titleElement && titleElement.textContent.trim() === downstream_job_name;
        }) || null;
    }

    function scrollToDownstreamPipeline(downstream_job_name) {
        const container = findDownstreamPipelineContainer(downstream_job_name);
        if (!container) {
            log(`[scrollToDownstreamPipeline]: Downstream pipeline ${downstream_job_name} not found for scrolling.`);
            return null;
        }

        container.setAttribute('tabindex', '-1');
        container.focus({ preventScroll: true });
        container.scrollIntoView({
            behavior: 'auto',
            block: 'center',
            inline: 'center'
        });
        log(`[scrollToDownstreamPipeline]: Successfully scrolled to downstream pipeline ${downstream_job_name}.`);
        return container;
    }

    function clickDownstreamExpandJobsButton(downstream_job_name, attempt = 1) {
        log(`[clickDownstreamExpandJobsButton]: Attempting to click downstream pipeline ${downstream_job_name} (Attempt ${attempt})`);
        const container = scrollToDownstreamPipeline(downstream_job_name);
        if (!container) {
            return;
        }

        const button = container.querySelector('button[title="Expand jobs"], button[data-testid="expand-pipeline-button"]');
        if (!button) {
            log(`[clickDownstreamExpandJobsButton]: Expand button not found inside downstream pipeline ${downstream_job_name}.`);
            return;
        }

        log(`[clickDownstreamExpandJobsButton]: Expand button found for downstream pipeline ${downstream_job_name}.`, button);
        dispatchClickSequence(button, 'clickDownstreamExpandJobsButton');
        log(`[clickDownstreamExpandJobsButton]: Clicked expand button for downstream pipeline ${downstream_job_name}.`);
        waitForTargetJobAndScroll(() => clickDownstreamExpandJobsButton(downstream_job_name, attempt + 1), attempt);
    }

    function waitForDownstreamPipeline(downstream_job_name, timeout = 10000) {
        log(`[waitForDownstreamPipeline]: Started wait for downstream pipeline: ${downstream_job_name}`);
        return new Promise((resolve, reject) => {
            const intervalTime = 200;
            let elapsed = 0;
            const interval = setInterval(() => {
                const container = findDownstreamPipelineContainer(downstream_job_name);
                if (container) {
                    log(`[waitForDownstreamPipeline]: Found downstream pipeline: ${downstream_job_name}`);
                    clearInterval(interval);
                    resolve(container);
                } else {
                    elapsed += intervalTime;
                    if (elapsed >= timeout) {
                        log(`[waitForDownstreamPipeline]: Timed out looking for downstream pipeline: ${downstream_job_name}`);
                        clearInterval(interval);
                        reject();
                    }
                }
            }, intervalTime);
        });
    }

    function waitForTargetJobAndScroll(retry_action, attempt) {
        // Wait 3000ms for the target to appear, if not, retry the click
        log(`[waitForTargetJobAndScroll]: Waiting for ${TARGET_JOB_NAME_LOCATOR} to appear...`);
        waitForElement(TARGET_JOB_NAME_LOCATOR, 3000).then(() => {
            // Scroll to the element after clicking the button
            log(`[waitForTargetJobAndScroll]: Element ${TARGET_JOB_NAME_LOCATOR} found, waiting for animation...`);
            setTimeout(() => {
                scrollToElement(TARGET_JOB_NAME_LOCATOR);
            }, 800); // Wait for potential expansion animation
        }).catch(() => {
            log(`[waitForTargetJobAndScroll]: Timeout waiting for element ${TARGET_JOB_NAME_LOCATOR}, retrying click...`);
            if (attempt < 5) {
                // Slight delay before retry to ensure the page has settled
                setTimeout(() => {
                    retry_action();
                }, 500);
            } else {
                log(`[waitForTargetJobAndScroll]: Max retries reached. Element ${TARGET_JOB_NAME_LOCATOR} did not appear.`);
            }
        });
    }

    // Function to scroll to the element with locator TARGET_JOB_NAME_LOCATOR
    function scrollToElement(element_to_scroll) {
        log(`[scrollToElement]: Attempting to scroll to: ${element_to_scroll}`);
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
            log(`[scrollToElement]: Successfully scrolled to element ${element_to_scroll}`);
            handleAutoReloadAfterNavigation(element_to_scroll);
        } else {
            log(`[scrollToElement]: Element ${element_to_scroll} not found for scrolling`);
        }
    }

    function waitForElement(selector, timeout = 10000) {
        log(`[waitForElement]: Started wait for element: ${selector}`);
        return new Promise((resolve, reject) => {
            const intervalTime = 200;
            let elapsed = 0;
            const interval = setInterval(() => {
                const element = document.querySelector(selector);

                // We just check for element existence now.
                // Checking offsetWidth is sometimes unreliable during SVG render in Firefox.
                if (element) {
                    log(`[waitForElement]: Found element: ${selector}`);
                    clearInterval(interval);
                    resolve(element);
                } else {
                    elapsed += intervalTime;
                    if (elapsed >= timeout) {
                        log(`[waitForElement]: Timed out looking for: ${selector}`);
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
        log(`[Processing_when_page_loaded]: Called. URL: ${currentURL}`);

        if (currentURL.includes('/environments')) {
            waitForElement('a[title="yp02"]').then(() => {
                scrollToElement('a[title="yp02"]');
            });
        } else if (currentURL.includes('/pipelines/')) {
            log(`[Processing_when_page_loaded]: Waiting for downstream pipeline ${DOWNSTREAM_PIPELINE_JOB_NAME}.`);
            waitForDownstreamPipeline(DOWNSTREAM_PIPELINE_JOB_NAME).then(() => {
                log(`[Processing_when_page_loaded]: Initiating click for downstream pipeline ${DOWNSTREAM_PIPELINE_JOB_NAME}.`);
                clickDownstreamExpandJobsButton(DOWNSTREAM_PIPELINE_JOB_NAME);
            }).catch(() => {
                log(`[Processing_when_page_loaded]: Timeout for downstream pipeline ${DOWNSTREAM_PIPELINE_JOB_NAME}.`);
            });
        } else {
            // Let's use both title="Expand jobs" and data-testid just in case
            const expandSelector = 'button[title="Expand jobs"], button[data-testid="expand-pipeline-button"]';
            log(`[Processing_when_page_loaded]: Waiting for expand button using selector: ${expandSelector}`);
            waitForElement(expandSelector).then((element) => {
                log(`[Processing_when_page_loaded]: Initiating click...`);
                clickExpandJobsButton(expandSelector);
            }).catch(() => {
                log(`[Processing_when_page_loaded]: Timeout for expand selector`);
            });
        }
    }

    function isAutoReloadTarget(element_to_scroll) {
        return element_to_scroll === TARGET_JOB_NAME_LOCATOR;
    }

    function isAutoReloadModeActive() {
        return sessionStorage.getItem(AUTO_RELOAD_SESSION_KEY) === 'true';
    }

    function activateAutoReloadMode() {
        sessionStorage.setItem(AUTO_RELOAD_SESSION_KEY, 'true');
        log(`[activateAutoReloadMode]: Auto-reload mode enabled for this tab.`);
    }

    function scheduleNextAutoReload() {
        if (autoReloadTimeoutId !== null) {
            clearTimeout(autoReloadTimeoutId);
            log(`[scheduleNextAutoReload]: Existing reload timer cleared before scheduling a new one.`);
        }

        log(`[scheduleNextAutoReload]: Scheduling page reload in ${AUTO_RELOAD_DELAY_MS / 1000} seconds.`);
        autoReloadTimeoutId = setTimeout(() => {
            log(`[scheduleNextAutoReload]: Auto-reloading page.`);
            location.reload();
        }, AUTO_RELOAD_DELAY_MS);
    }

    function handleAutoReloadAfterNavigation(element_to_scroll) {
        if (!isAutoReloadTarget(element_to_scroll)) {
            return;
        }

        activateAutoReloadMode();
        scheduleNextAutoReload();
    }

    function initializeAutoReload() {
        if (!isAutoReloadModeActive()) {
            return;
        }

        log(`[initializeAutoReload]: Auto-reload mode is active for this tab. Scheduling next reload.`);
        scheduleNextAutoReload();
    }

    function handleRouteChange() {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            log(`[handleRouteChange]: URL changed to ${url}, re-running processing...`);
            Processing_when_page_loaded();
        }
    }

    function handleDocumentReadyState() {
        log(`[handleDocumentReadyState]: Script initialized. Checking readyState...`);
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            log(`[handleDocumentReadyState]: Document already loaded (readyState: ${document.readyState}), firing immediately.`);
            setTimeout(Processing_when_page_loaded, 500);
        } else {
            log(`[handleDocumentReadyState]: Document not ready, waiting for load event.`);
            window.addEventListener('load', Processing_when_page_loaded);
        }
    }

    // SPA Route change detector
    // Gitlab often loads pages via JS rather than reloading the HTML
    let lastUrl = location.href;
    new MutationObserver(handleRouteChange).observe(document, { body: true, subtree: true, childList: true });

    initializeAutoReload();
    handleDocumentReadyState();

})();
