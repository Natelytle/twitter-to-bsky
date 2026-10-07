// ==UserScript==
// @name           twitter-to-bsky
// @version        0.14
// @description    Crosspost from Twitter/X to Bluesky
// @author         59de44955ebd
// @license        MIT
// @namespace      59de44955ebd
// @match          https://twitter.com/*
// @match          https://x.com/*
// @icon           https://raw.githubusercontent.com/59de44955ebd/twitter-to-bsky/main/cross-64x64.png
// @resource       cross_icon https://raw.githubusercontent.com/59de44955ebd/twitter-to-bsky/main/cross-64x64.png
// @grant          GM_getResourceURL
// @grant          GM_setValue
// @grant          GM_getValue
// @grant          GM_addStyle
// @grant          GM_xmlhttpRequest
// @grant          GM_openInTab
// @grant          GM_notification
// @updateURL      https://github.com/59de44955ebd/twitter-to-bsky/raw/main/twitter-to-bsky.meta.js
// @downloadURL    https://github.com/59de44955ebd/twitter-to-bsky/raw/main/twitter-to-bsky.user.js
// @homepageURL    https://github.com/59de44955ebd/twitter-to-bsky
// @supportURL     https://github.com/59de44955ebd/twitter-to-bsky/blob/main/README.md
// @run-at         document-body
// @inject-into    page
// ==/UserScript==

/*jshint esversion: 8 */

(function () {
    'use strict';

    // Config
    const NAV_SELECTOR = 'header nav[role="navigation"]:not(.bsky-navbar)';
    const POST_TOOLBAR_SELECTOR = 'div[data-testid="toolBar"] > nav:not(.bsky-toolbar)';
    const POST_BUTTON_SELECTOR = '[data-testid="tweetButton"]:not(.bsky-button), [data-testid="tweetButtonInline"]:not(.bsky-button)';

    const POST_TEXT_AREA_SELECTOR = '[data-testid="tweetTextarea_0"]';
    const POST_ATTACHMENTS_SELECTOR = '[data-testid="attachments"]';

    const BSKY_IMAGE_MAX_BYTES = 2000000; // 2 MB

    const icon_url = GM_getResourceURL('cross_icon', false);

    const RE_HASHTAG = /#\w+/g;

    const css = `
    .bsky-nav {
        padding: 12px;
        cursor: pointer;
    }
    .bsky-nav a {
        width: 1.75rem;
        height: 1.75rem;
        background-image: url(${icon_url});
        background-size: cover;
        display: block;
    }
    @media (min-width: 1265px) {
        .bsky-nav a:after {
            content: "Crosspost";
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 20px;
            font-weight: 400;
            margin-left: 46px;
            color: rgb(15, 20, 25);
        }
    }
    @media (prefers-color-scheme: dark) {
        .bsky-nav a {
            filter: invert(1);
        }
        .bsky-nav a:after {
            font-weight: 500;
        }
    }
    .cross-checkbox {
        margin-left: 5px;
    }
    .cross-checkbox input {
        cursor: pointer;
    }
    .cross-checkbox span {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-weight: bold;
        font-size: 11px;
        cursor: pointer;
    }
    .cross-checkbox  input:disabled,
    .cross-checkbox  input:disabled + span {
        color: #ccc;
        cursor: default;
    }
    .bsky-settings {
        position: fixed;
        width: 280px;
        background: inherit;
        padding: 10px;
        border: 2px solid #0085FF;
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 13.3333px
    }
    .bsky-settings fieldset {
        margin-bottom: 5px;
        padding-bottom: 2px;
    }
    .bsky-settings legend {
        font-size: 11px;
        font-weight: bold;
        margin-bottom: 5px;
    }
    .bsky-settings input[type="text"],
    .bsky-settings input[type="url"],
    .bsky-settings input[type="password"]
    {
        display: block;
        box-sizing: border-box;
        width: 100%;
        margin-bottom: 10px
    }
    .bsky-settings label {
        display: block;
        cursor: pointer;
    }
    .bsky-settings button {
        margin-top: 10px
    }
    `;

    // Bluesky stuff
    let bsky_client = null;
    let bsky_handle = GM_getValue('bsky_handle', '');
    let bsky_app_password = GM_getValue('bsky_app_password', '');
    let bsky_session = GM_getValue('bsky_session', null);
    let bsky_crosspost_enabled = bsky_handle != '' && bsky_app_password != '';
    let bsky_crosspost_checked = GM_getValue('bsky_crosspost_checked', false);

    let crosspost_show_notifications = GM_getValue('crosspost_show_notifications', true);
    let crosspost_open_tabs = GM_getValue('crosspost_open_tabs', false);

    let settings_div = null;
    let media_card = null;
    let is_cross_posted = false;

    let current_post_button = null;

    const debug = function (...toLog) {
        console.debug('[BSKY]', ...toLog);
    };

    const notify = function (message) {
        if (crosspost_show_notifications) {
            GM_notification(message, 'twitter-to-bsky', icon_url);
        }
    };

    /*
     * Scales image to fit into 640x640, returns jpeg blob.
     */
    const resize_image = function (image_blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = function (e) {
                const img = document.createElement('img');
                img.addEventListener('load', () => {
                    if (img.width == 0 || img.height == 0) {
                        reject('Failed to scale image');
                    }
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    if (img.width >= img.height) {
                        canvas.width = 1000;
                        canvas.height = 1000 * img.height / img.width;
                    }
                    else {
                        canvas.width = 1000 * img.width / img.height;
                        canvas.height = 1000;
                    }
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    canvas.toBlob(resolve, 'image/jpeg', 0.7);
                });
                img.src = e.target.result;
            };
            reader.readAsDataURL(image_blob);
        });
    }


    const gmFetchJson = (url) =>
        new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                headers: { Accept: "application/json" },
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) {
                        return reject(new Error(`HTTP ${res.status} for ${url}`));
                    }
                    try {
                        resolve(JSON.parse(res.responseText));
                    } catch (e) {
                        reject(new Error("Invalid JSON from " + url));
                    }
                },
                onerror: () => reject(new Error("Network error for " + url)),
                ontimeout: () => reject(new Error("Timeout for " + url)),
            });
        });

    const getPdsServiceEndpoint = async function (handle) {
        const { did } = await gmFetchJson(
            "https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=" + encodeURIComponent(handle)
        );

        const didDoc = await gmFetchJson("https://plc.directory/" + encodeURIComponent(did));

        const pds = didDoc.service?.find(s => s.id === "#atproto_pds");
        if (!pds) throw new Error("No PDS endpoint found in DID document");
        return pds.serviceEndpoint;
    }

    class BSKY {
        // All parameters are optional
        constructor(bsky_handle, bsky_app_password, bsky_session) {
            this._bsky_handle = bsky_handle;
            this._bsky_app_password = bsky_app_password;
            this._session = bsky_session;
        }

        set_credentials(bsky_handle, bsky_app_password) {
            this._bsky_handle = bsky_handle;
            this._bsky_app_password = bsky_app_password;
            this._session = null;
        }

        async login() {
            const pdsUrl = await getPdsServiceEndpoint(this._bsky_handle);

            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: pdsUrl + '/xrpc/com.atproto.server.createSession',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    data: JSON.stringify({
                        identifier: this._bsky_handle,
                        password: this._bsky_app_password,
                    }),
                    onload: (response) => {
                        const session = JSON.parse(response.responseText);
                        if (session.error) {
                            reject(session.message);
                        }
                        this._session = session;
                        resolve(session);
                    },
                    onerror: reject,
                });
            });
        }

        async refresh_session() {
            const pdsUrl = await getPdsServiceEndpoint(this._bsky_handle);

            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: pdsUrl + '/xrpc/com.atproto.server.refreshSession',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + this._session.refreshJwt,
                    },
                    onload: (response) => {
                        const session = JSON.parse(response.responseText);
                        if (session.error) {
                            reject(session.message);
                        }
                        this._session = session;
                        resolve(session);
                    },
                    onerror: reject,
                });
            });
        }

        // Utility function
        async verify_session() {
            if (this._session) {
                try {
                    return await this.refresh_session();
                } catch (err) {
                    return await this.login();
                }
            }
            else {
                return this.login();
            }
        }

        async upload_image(image_url) {
            const pdsUrl = await getPdsServiceEndpoint(this._bsky_handle);

            return fetch(image_url)
                .then(res => res.blob())
                .then(blob => {
                    if (blob.size > BSKY_IMAGE_MAX_BYTES) {
                        //throw new Error(`Size of image ${blob.name} exceeds max. allowed size (${BSKY_IMAGE_MAX_BYTES})`);
                        blob = resize_image(blob);
                    }
                    return new Promise((resolve, reject) => {
                        GM_xmlhttpRequest({
                            method: "POST",
                            url: pdsUrl + '/xrpc/com.atproto.repo.uploadBlob',
                            headers: {
                                'Content-Type': blob.type,
                                'Authorization': 'Bearer ' + this._session.accessJwt,
                            },
                            fetch: true,
                            data: blob,
                            onload: (response) => {
                                const res = JSON.parse(response.responseText);
                                if (res.error) {
                                    reject(res.message);
                                }
                                resolve(res);
                            },
                            onerror: reject,
                        });
                    });
                });
        }

        async create_post(post_text, post_images, post_embed) {
            const now = (new Date()).toISOString();

            // Fields that each post must include
            const post = {
                'via': 'Twitter to Bluesky',
                '$type': 'app.bsky.feed.post',
                'text': post_text,
                'createdAt': now,
            };

            if (post_images && post_images.images.length) {
                post.embed = post_images;
            }

            else if (post_embed) {
                post.embed = post_embed;
            }

            // Minimal hashtag support (fails for non-western unicode characters in hashtag)
            const facets = [];
            let res;
            while ((res = RE_HASHTAG.exec(post_text)) !== null) {
                facets.push({
                    index: {
                        byteStart: res.index,
                        byteEnd: res.index + res[0].length
                    },
                    features: [{
                        $type: 'app.bsky.richtext.facet#tag',
                        tag: post_text.substr(res.index + 1, res[0].length - 1)
                    }]
                });
            }
            if (facets.length) {
                post.facets = facets;
            }

            const pdsUrl = await getPdsServiceEndpoint(this._bsky_handle);

            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: pdsUrl + '/xrpc/com.atproto.repo.createRecord',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + this._session.accessJwt,
                    },
                    fetch: true,
                    data: JSON.stringify({
                        repo: this._session.did,
                        collection: 'app.bsky.feed.post',
                        record: post,
                    }),
                    onload: (response) => {
                        const res = JSON.parse(response.responseText);
                        if (res.error) {
                            reject(res.message);
                        }
                        resolve(res);
                    },
                    onerror: reject,
                });
            });
        }
    }

    /*
     * Adds new cross icon to navbar for changing crosspost settings.
     */
    const extend_navbar = function (nav) {
        const a = document.createElement('a');
        a.title = 'Crosspost Settings';
        a.addEventListener('click', function () {
            if (settings_div) {
                document.body.removeChild(settings_div);
                settings_div = null;
                return;
            }

            const r = a.getBoundingClientRect();
            settings_div = document.createElement('div');
            settings_div.className = 'bsky-settings';
            settings_div.style = `left:${r.right + 5}px;top:${r.top}px;`;
            settings_div.innerHTML = `
            <fieldset>
            <legend>Bluesky</legend>
            <input type="text" name="bsky_handle" placeholder="Bluesky Handle" autocomplete="section-bsky username" value="${bsky_handle}">
            <input type="password" name="bsky_app_password" placeholder="Bluesky App Password" autocomplete="section-bsky current-password" value="${bsky_app_password}">
            </fieldset>
            <label><input type="checkbox" name="crosspost_show_notifications"${crosspost_show_notifications ? ' checked' : ''}>Show crosspost notifications?</label>
            <label><input type="checkbox" name="crosspost_open_tabs"${crosspost_open_tabs ? ' checked' : ''}>Open crossposts in new tab?</label>
            `;
            const btn = document.createElement('button');
            btn.innerText = 'Save';
            settings_div.appendChild(btn);
            btn.addEventListener('click', function () {
                bsky_handle = settings_div.querySelector('[name="bsky_handle"]').value;
                bsky_app_password = settings_div.querySelector('[name="bsky_app_password"]').value;

                crosspost_show_notifications = settings_div.querySelector('[name="crosspost_show_notifications"]').checked;
                crosspost_open_tabs = settings_div.querySelector('[name="crosspost_open_tabs"]').checked;

                document.body.removeChild(settings_div);
                settings_div = null;

                GM_setValue('bsky_handle', bsky_handle);
                GM_setValue('bsky_app_password', bsky_app_password);

                GM_setValue('crosspost_show_notifications', crosspost_show_notifications);
                GM_setValue('crosspost_open_tabs', crosspost_open_tabs);

                bsky_client.set_credentials(bsky_handle, bsky_app_password);
                bsky_crosspost_enabled = bsky_handle != '' && bsky_app_password != '';

                // Update disabled state of all checkboxes
                for (let el of document.querySelectorAll('.bsky-checkbox input')) {
                    el.disabled = !bsky_crosspost_enabled;
                }
            });

            document.body.appendChild(settings_div);
            return false;
        });

        const div = document.createElement('div');
        div.className = 'bsky-nav';
        div.appendChild(a);
        nav.appendChild(div);
    };

    /*
     * Adds new Bluesky checkbox to post toolbars
     */
    const create_crosspost_checkboxes = function (toolbar) {
        const label_b = document.createElement('label');
        label_b.className = 'cross-checkbox bsky-checkbox';
        label_b.title = 'Crosspost to Bluesky?';
        const checkbox_b = document.createElement('input');
        checkbox_b.type = 'checkbox';
        checkbox_b.checked = bsky_crosspost_checked;
        checkbox_b.disabled = !bsky_crosspost_enabled;
        checkbox_b.addEventListener('click', function () {
            bsky_crosspost_checked = this.checked;
            GM_setValue('bsky_crosspost_checked', bsky_crosspost_checked);
            for (let el of document.querySelectorAll('.bsky-checkbox input')) {
                el.checked = bsky_crosspost_checked;
            }
        });
        label_b.appendChild(checkbox_b);
        const span_b = document.createElement('span');
        span_b.innerText = 'Bluesky';
        label_b.appendChild(span_b);
        toolbar.appendChild(label_b);
    };

    /*
     * Intercepts post requests, first posts to Bluesky, then to Twitter/X.
     */
    const post_button_handler = async function (e) {
        debug('POST BUTTON clicked');
        if (this.firstChild.getAttribute('aria-disabled')) {
            e.stopPropagation();
            return;
        }

        if (!is_cross_posted && bsky_crosspost_enabled && bsky_crosspost_checked) {
            // First crosspost
            e.stopPropagation();

            let post_text = '';

            const div_text = document.querySelector(POST_TEXT_AREA_SELECTOR);
            if (div_text) {
                post_text = div_text.innerText;
            }

            // Bluesky
            if (bsky_crosspost_enabled && bsky_crosspost_checked) {
                const post_images = {
                    '$type': 'app.bsky.embed.images',
                    'images': [],
                };
                let post_card = null;

                try {
                    await bsky_client.verify_session()
                        .then((session) => {
                            if (session.error) {
                                throw new Error(session.message);
                            }
                            GM_setValue('bsky_session', session);
                        });

                    // Get images
                    const div_attachments = document.querySelector(POST_ATTACHMENTS_SELECTOR);
                    if (div_attachments) {
                        for (let img of div_attachments.querySelectorAll('img')) {
                            await bsky_client.upload_image(img.src)
                                .then((res) => {
                                    post_images.images.push({
                                        alt: '',
                                        image: res.blob
                                    });
                                });
                        }
                    }

                    // Get card (Bluesky only allows either images or card)
                    if (!post_images.images.length && media_card && post_text.includes(media_card.url)) {
                        post_card = {
                            '$type': 'app.bsky.embed.external',
                            'external': {
                                uri: media_card.url,
                                title: media_card.title,
                                description: media_card.description,
                            },
                        };
                        if (media_card.image) {
                            await bsky_client.upload_image(media_card.image)
                                .then((res) => {
                                    post_card.external.thumb = res.blob;
                                    // post_text = post_text.replace(media_card.url, '');
                                });
                        }
                    }

                    debug('Posting to Bluesky...');
                    await bsky_client.create_post(post_text, post_images, post_card)
                        .then((res) => {
                            notify('Post was successfully crossposted to Bluesky');
                            if (crosspost_open_tabs && res.uri) {
                                GM_openInTab(`https://bsky.app/profile/${bsky_handle}/post/` + res.uri.split('/').pop(), { active: true });
                            }
                        });
                }
                catch (error) {
                    debug(error);
                    notify(`Error: crossposting to Bluesky failed: \n${error.message}`);
                }
            }

            is_cross_posted = true;

            // Now forward click event to actually post on Twitter/X
            this.click();
        }
        else {
            is_cross_posted = false;
        }
    };

    GM_addStyle(css);

    /*
     * Observer that watches page for dynamic updates and injects elements and event handlers
     */
    const pageObserver = new MutationObserver(() => {

        const navbar = document.querySelector(NAV_SELECTOR);
        if (navbar && !navbar.querySelector('.bsky-nav')) {
            debug('NAVBAR found');
            navbar.classList.toggle('bsky-navbar', true);
            extend_navbar(navbar);
        }

        const toolbar = document.querySelector(POST_TOOLBAR_SELECTOR);
        if (toolbar) {
            debug('POST_TOOLBAR found');
            toolbar.classList.toggle('bsky-toolbar', true);
            create_crosspost_checkboxes(toolbar);
        }

        const button = document.querySelector(POST_BUTTON_SELECTOR);
        if (button) {
            debug('POST_BUTTON found');
            button.classList.toggle('bsky-button', true);
            button.addEventListener('click', post_button_handler, true);
            current_post_button = button;
        }
    });

    pageObserver.observe(document.body, { childList: true, subtree: true });

    bsky_client = new BSKY(bsky_handle, bsky_app_password, bsky_session);

    // Hook into native XMLHttpRequest to capture card data
    // unsafeWindow.XMLHttpRequest.prototype._open = unsafeWindow.XMLHttpRequest.prototype.open;
    // unsafeWindow.XMLHttpRequest.prototype.open = function(...args) {
    //     if (args[1].includes('/cards/'))
    //     {
    //         this.addEventListener("readystatechange", function() {
    //             if (this.readyState === 4)
    //             {
    //                 const res = JSON.parse(this.response);
    //                 if (res.card)
    //                 {
    //                     media_card = {
    //                         url: res.card.url,
    //                         title: res.card.binding_values.title.string_value,
    //                         description: res.card.binding_values.description.string_value,
    //                         image: res.card.binding_values.thumbnail_image_original.image_value.url,
    //                     };
    //                 }
    //             }
    //         }, false);
    //     }
    //     this._open(...args);
    // };

    // allow cross-posting via Ctrl+Enter shortcut
    document.addEventListener('keydown', (e) => {
        if (current_post_button && e.ctrlKey && e.key == "Enter") {
            e.stopPropagation();
            if (!e.repeat) {
                debug('Ctrl+Enter detected');
                current_post_button.click();
            }
        }
    }, true);

})();
