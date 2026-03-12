// ==UserScript==
// @name         heritage.zp.ua crawler - without hardcoded waiting
// @namespace    https://www.tampermonkey.net/
// @version      5
// @description  Wait for file download completion and click "Forward" button
// @author       yevgeniy.movsesov@gmail.com
// @match        https://heritage.zp.ua/document*
// @match        https://heritage.zp.ua/account
// @match        https://heritage.zp.ua/login
// @match        https://heritage.zp.ua*
// @include      https://accounts.google.com*heritage.zp.ua*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    // Local server URL

    const serverUrl = "http://127.0.0.1:5000/file_count";
    const cookieServerUrl = "http://127.0.0.1:5000/cookies"; // Endpoint for sending cookies

    // Execution starts on load to ensure non-parallel sequence
    window.addEventListener("load", async function () {
        sendCookiesToFlask(); // Background operation

        await Close_popup_window_if_present();
        await clickLoginIfPresent();
        await Click_Login_with_Google();
        await Click_Particular_Google_account();

        // rest of the logic...
        const SaveButtonWasClicked = await clickSave();

        if (SaveButtonWasClicked) {
            // Get the current number of files
            const initialCount = await getFileCount();

            console.log("Initial file count:", initialCount);

            // Wait for the number of files to increase
            await waitForFileDownload(initialCount);

            // Click the "Forward" button
            await clickForwardButton();
        } else {
            console.log("Button 'Save' has not been found");
        }
    });

    async function Close_popup_window_if_present() {
        // <button class="close-modal-btn" type="button" style="background: #C7CCD8;">Close</button>
        clickElementByXPath('//button[text()="Закрити"]');
    };

    async function Click_Particular_Google_account() {
        console.log("Waiting 5 seconds before starting Click_Particular_Google_account...");
        await new Promise(resolve => setTimeout(resolve, 5000));

        let currentURL = window.location.href;
        const referrer = document.referrer;
        if (currentURL.includes('accounts.google.com')
            && (referrer.includes('heritage.zp.ua') || currentURL.includes('heritage.zp.ua'))
        ) {
            console.log("Clicking Particular Google account...");
            clickElementByXPath('//div[text()="__ Movses"]');
        } else {
            console.log("Click_Particular_Google_account: No referrer information available.");
        }

        console.log("Waiting 5 seconds after completing Click_Particular_Google_account...");
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    async function getFileCount() {
        return new Promise(async (resolve, reject) => {
            const retryDelays = [5000, 10000, 30000]; // Specific wait times for each retry: 5s, 10s, 30s
            const maxRetries = retryDelays.length;
            let retries = 0;

            async function attemptRequest() {
                console.log(`Attempt ${retries + 1}/${maxRetries + 1}: Sending request to:`, serverUrl);

                try {
                    const result = await new Promise((innerResolve, innerReject) => {
                        GM_xmlhttpRequest({
                            method: "GET",
                            url: serverUrl,
                            timeout: 5000,
                            background: true, // Force background execution
                            onload: function (response) {
                                console.log("Response received:", response);

                                if (response.status === 200) {
                                    try {
                                        const data = JSON.parse(response.responseText);
                                        innerResolve(data.file_count);
                                    } catch (err) {
                                        console.error("JSON parse error:", err);
                                        innerReject("JSON parse error");
                                    }
                                } else {
                                    console.error("Server returned an error:", response.status, response.responseText);
                                    innerReject(`Server error: ${response.status}`);
                                }
                            },
                            ontimeout: function () {
                                console.error("Request timed out");
                                innerReject("Request timed out");
                            },
                            onerror: function (error) {
                                console.error("GM_xmlhttpRequest error:", error);
                                innerReject("Failed to connect to the server");
                            }
                        });
                    });

                    // If successful, return the result immediately
                    resolve(result);

                } catch (error) {
                    console.log(`Attempt ${retries + 1} failed with error:`, error);

                    if (retries < maxRetries) {
                        const currentDelay = retryDelays[retries];
                        console.log(`Retrying in ${currentDelay / 1000} seconds...`);

                        // Wait before the next attempt
                        await new Promise(r => setTimeout(r, currentDelay));
                        retries++;
                        attemptRequest();
                    } else {
                        console.error(`All ${maxRetries + 1} attempts failed`);
                        reject(`Failed after ${maxRetries + 1} attempts: ${error}`);
                    }
                }
            }

            // Start the first attempt
            attemptRequest();
        });
    }

    async function clickLoginIfPresent() {
        await new Promise(r => setTimeout(r, 3000));
        let currentURL = window.location.href;
        if (currentURL.includes('https://heritage.zp.ua/login')) {
            return true;
        } else {
            const buttonXPath = '//a[text()="Увійти"]';
            clickElementByXPath(buttonXPath);
            return false;
        }
    }

    async function Click_Login_with_Google() {
        await new Promise(resolve => setTimeout(resolve, 3000));
        let currentURL = window.location.href;
        if (currentURL.includes('https://heritage.zp.ua/login')) {
            const buttonXPath = '//b[text()="Вхід через Google"]';
            if (clickElementByXPath(buttonXPath)) {
                return true;
            } else {
                return false;
            }
        }
    }


    async function clickSave() {
        const saveButtonXPath = '//span[text()="Висока якість"]/preceding-sibling::span[@class="btn__dwnld-title"]'; // Keep the text as the actual element contains this text
        if (clickElementByXPath(saveButtonXPath)) {
            return true;
            console.log("Clicked Save");
        } else {
            return false;
        }

    }

    async function waitForFileDownload(initialCount) {
        while (true) {
            const currentCount = await getFileCount();
            console.log("Current file count:", currentCount);

            if (currentCount > initialCount) {
                console.log("File download completed!");
                break;
            }

            // Wait 30 seconds before checking again
            await new Promise((resolve) => setTimeout(resolve, 30000));
        }
    }

    async function clickElementByXPath(xpath) {
        const element = document.evaluate(xpath, document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null).singleNodeValue;
        if (element) {
            console.log("Element by xpath has been found");
            console.log(`xpath = ${xpath}`);
            element.click();
            return true;
        } else {
            console.log("Element by xpath has not been found");
            console.log(`xpath = ${xpath}`);
            return false;
        }
    }

    async function clickForwardButton() {
        const xpath_next_button =
            '//img[@src="https://heritage.zp.ua/svg/arrowForwardOutlined.svg" and @alt="Forward"]';
        clickElementByXPath(xpath_next_button);
    }

    function sendCookiesToFlask() {
        const cookies = document.cookie;
        console.log("Sending cookies to Flask server...");

        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: cookieServerUrl,
                headers: {
                    "Content-Type": "application/json"
                },
                data: JSON.stringify({
                    domain: "heritage.zp.ua",
                    url: window.location.href,
                    cookies: cookies
                }),
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        console.log("Cookies successfully sent to Flask server.");
                        resolve(true);
                    } else {
                        console.error("Failed to send cookies. Server returned:", response.status);
                        resolve(false);
                    }
                },
                onerror: function (error) {
                    console.error("Error sending cookies:", error);
                    resolve(false);
                }
            });
        });
    }
})();
