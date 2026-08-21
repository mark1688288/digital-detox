// ==UserScript==
// @name         Threads 阻擋自動載媒體 (Desktop v1.0)
// @namespace    https://github.com/mark1688288/digital-detox
// @version      1.0.0
// @description  攔截 Threads 圖片／影片自動下載，改為手動載入；阻止誤觸 media gallery。hostname CDN 規則、可串接 prototype hook、fetch/XHR 雙擋，並與 threads_antitrackers 共存。
// @author       mark1688288
// @homepageURL  https://github.com/mark1688288/digital-detox
// @downloadURL  https://raw.githubusercontent.com/mark1688288/digital-detox/main/threads-detox.js
// @updateURL    https://raw.githubusercontent.com/mark1688288/digital-detox/main/threads-detox.js
// @match        https://www.threads.net/*
// @match        https://threads.net/*
// @match        https://*.threads.net/*
// @match        https://www.threads.com/*
// @match        https://threads.com/*
// @match        https://*.threads.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=threads.com
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @license      MIT
// ==/UserScript==

/**
 * - 要喺「頁面真身」patch img/video prototype 同 fetch，必須注入 MAIN_WORLD：
 *     1) `@grant none`（傳統 page context），或
 *     2) `@sandbox raw` / `@sandbox MAIN_WORLD`
 * - 若改用 GM_* API，腳本會入 sandbox，必須改 patch `unsafeWindow`。
 * - 本腳本無需 GM_*，故保持 `@grant none` + `@sandbox raw`。
 */

(function () {
    'use strict';

    if (window.__threadsStopMediaActive) return;
    window.__threadsStopMediaActive = true;

    const VERSION = '1.0.0';
    const PLACEHOLDER =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const STYLE_ID = 'threads-stop-media-style';
    const STATE_LOCKED = 'locked';
    const STATE_UNLOCKED = 'unlocked';
    const STATE_IGNORED = 'ignored';
    const DS = {
        state: 'tSmState',
        processed: 'tSmProcessed',
        src: 'tSmSrc',
        srcset: 'tSmSrcset',
        poster: 'tSmPoster',
        unlockable: 'tSmUnlockable',
        managed: 'tSmManaged'
    };

    // ==========================================
    // 1. 設定
    // ==========================================
    const CONFIG = {
        /**
         * Meta 媒體 CDN hostname（阻擋 fetch/XHR 用）。
         * 以 hostname 精確比對（含子網域），唔用 url.includes。
         */
        mediaHosts: [
            'cdninstagram.com',
            'fbcdn.net',
            'facebook.com',
            'instagram.com'
        ],
        /**
         * 視為「細圖／icon」可自動放行嘅最大邊長（attribute 或 natural*）。
         * avatar 多數 < 150；內容圖通常更大。
         */
        smallMediaMaxPx: 150,
        /** true → dialog / lightbox 內媒體亦要手動解鎖；false → dialog 內放行 */
        blockDialogMedia: false,
        /** 解鎖後吞掉後續 click 以防開 gallery 嘅最長時間（ms） */
        swallowTimeoutMs: 500,
        /** 暫停 pause 攔截（解鎖後短暫防 React 即刻 pause） */
        pauseBlockMs: 400,
        /** localStorage key `threads_stopMediaLoader_debug` = "1" 亦可開啟 */
        debug: false
    };

    try {
        if (localStorage.getItem('threads_stopMediaLoader_debug') === '1') {
            CONFIG.debug = true;
        }
    } catch (_) { /* private mode 等 */ }

    const stats = {
        blockedFetch: 0,
        blockedXhr: 0,
        lockedImg: 0,
        lockedVideo: 0,
        unlockedImg: 0,
        unlockedVideo: 0,
        ignored: 0,
        preloadDropped: 0
    };

    function log(...args) {
        if (!CONFIG.debug) return;
        console.debug(
            `%c[Threads StopMedia ${VERSION}]`,
            'color:#8ab4f8;font-weight:bold;',
            ...args
        );
    }

    // ==========================================
    // 2. URL / hostname 工具
    // ==========================================
    function isDataUrl(url) {
        return typeof url === 'string' && /^data:/i.test(url);
    }

    function isBlobUrl(url) {
        return typeof url === 'string' && /^blob:/i.test(url);
    }

    function isPlaceholder(url) {
        return typeof url === 'string' && (
            url === PLACEHOLDER ||
            url === '' ||
            url === 'about:blank'
        );
    }

    /** 解析任意 fetch/XHR 參數 → URL 物件；失敗回 null */
    function parseUrl(value) {
        if (value == null) return null;
        let candidate = value;
        if (typeof Request !== 'undefined' && value instanceof Request) {
            candidate = value.url;
        } else if (typeof URL !== 'undefined' && value instanceof URL) {
            candidate = value.href;
        } else if (typeof value === 'object' && typeof value.url === 'string') {
            candidate = value.url;
        }
        try {
            return new URL(String(candidate), location.href);
        } catch (_) {
            return null;
        }
    }

    function hostMatches(hostname, domain) {
        const h = String(hostname || '').toLowerCase();
        const d = String(domain || '').toLowerCase();
        if (!h || !d) return false;
        return h === d || h.endsWith('.' + d);
    }

    function isMetaMediaHost(hostname) {
        const h = String(hostname || '').toLowerCase();
        if (!h) return false;
        // scontent* 幾乎一定係 IG/Threads 媒體 CDN
        if (h.includes('scontent')) return true;
        return CONFIG.mediaHosts.some((d) => hostMatches(h, d));
    }

    /** path/query 像媒體資源（副檔名或常見 Meta media path） */
    function looksLikeMediaPath(urlObj) {
        if (!urlObj) return false;
        const path = (urlObj.pathname || '') + (urlObj.search || '');
        if (/favicon/i.test(path)) return false;
        // 常見副檔名（query 前或整段）
        if (/\.(?:jpe?g|png|gif|webp|avif|heic|heif|bmp|mp4|m4v|mov|webm|mkv)(?:$|[?#])/i.test(path)) {
            return true;
        }
        // Meta CDN 常見無副檔名路徑
        if (/\/(?:v\/t\d+|o1\/v\/t\d+|t\d+\.\d+-\d+)\//i.test(urlObj.pathname || '')) {
            return true;
        }
        // stp= / _nc_ 等 media 查詢常見於 scontent
        if (/[?&](?:stp|oh|oe|_nc_)/i.test(urlObj.search || '')) {
            return true;
        }
        return false;
    }

    /** 細尺寸 CDN 片段 s48x48 / s150x150 → 當 icon 放行 */
    function isTinyCdnSize(urlObj) {
        if (!urlObj) return false;
        const m = (urlObj.pathname + urlObj.search).match(/s(\d+)x(\d+)/i);
        if (!m) return false;
        const w = parseInt(m[1], 10);
        const h = parseInt(m[2], 10);
        return w <= CONFIG.smallMediaMaxPx && h <= CONFIG.smallMediaMaxPx;
    }

    function shouldBlockNetworkMedia(value) {
        const urlObj = parseUrl(value);
        if (!urlObj) return false;
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return false;
        if (!isMetaMediaHost(urlObj.hostname)) return false;
        if (isTinyCdnSize(urlObj)) return false;
        if (/favicon/i.test(urlObj.pathname + urlObj.search)) return false;
        return looksLikeMediaPath(urlObj);
    }

    function toStoredUrl(raw) {
        if (raw == null) return '';
        const s = String(raw).trim();
        if (!s || isPlaceholder(s) || isDataUrl(s)) return '';
        return s;
    }

    // ==========================================
    // 3. CSS（DOM-less 佔位 + a11y focus）
    // ==========================================
    const cssRule = `
        video[data-t-sm-state="locked"] {
            background-color: #1a1a1a !important;
            background-image: url('data:image/svg+xml;utf8,<svg width="48" height="48" viewBox="0 0 24 24" fill="%23ffffff" xmlns="http://www.w3.org/2000/svg"><path d="M8 5v14l11-7z"/></svg>') !important;
            background-position: center !important;
            background-repeat: no-repeat !important;
            background-size: 48px !important;
            box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1) !important;
            transition: background-size 0.2s ease, background-color 0.2s ease !important;
            width: 100% !important;
            height: 100% !important;
            min-height: 200px !important;
            cursor: pointer !important;
        }
        video[data-t-sm-state="locked"]:hover,
        video[data-t-sm-state="locked"]:focus-visible {
            background-color: #2a2a2a !important;
            background-size: 56px !important;
        }
        img[data-t-sm-state="locked"] {
            content: url('${PLACEHOLDER}') !important;
            background-color: #1a1a1a !important;
            background-image: url('data:image/svg+xml;utf8,<svg width="48" height="48" viewBox="0 0 24 24" fill="%23ffffff" xmlns="http://www.w3.org/2000/svg"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>') !important;
            background-position: center !important;
            background-repeat: no-repeat !important;
            background-size: 32px !important;
            box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1) !important;
            transition: background-size 0.2s ease, background-color 0.2s ease !important;
            cursor: pointer !important;
            min-width: 48px !important;
            min-height: 48px !important;
        }
        img[data-t-sm-state="locked"]:hover,
        img[data-t-sm-state="locked"]:focus-visible {
            background-color: #2a2a2a !important;
            background-size: 40px !important;
        }
        img[data-t-sm-state="locked"]:focus-visible,
        video[data-t-sm-state="locked"]:focus-visible {
            outline: 2px solid #8ab4f8 !important;
            outline-offset: 2px !important;
        }
        /* dialog 預設唔套 locked 視覺（blockDialogMedia=false 時 process 會直接 ignored） */
        [role="dialog"] video[data-t-sm-state="locked"],
        [role="dialog"] img[data-t-sm-state="locked"] {
            filter: none !important;
            background: none !important;
            content: none !important;
            cursor: default !important;
            min-height: 0 !important;
        }
        #threads-stop-media-load-all {
            position: fixed;
            z-index: 2147483646;
            right: 16px;
            bottom: 16px;
            padding: 10px 14px;
            border-radius: 20px;
            border: 1px solid rgba(255,255,255,0.2);
            background: rgba(26,26,26,0.92);
            color: #f5f5f5;
            font: 600 13px/1.3 system-ui, -apple-system, sans-serif;
            cursor: pointer;
            box-shadow: 0 4px 16px rgba(0,0,0,0.35);
            backdrop-filter: blur(8px);
        }
        #threads-stop-media-load-all:hover,
        #threads-stop-media-load-all:focus-visible {
            background: rgba(42,42,42,0.96);
            outline: 2px solid #8ab4f8;
            outline-offset: 2px;
        }
        #threads-stop-media-load-all[hidden] {
            display: none !important;
        }
    `;

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = cssRule;
        (document.head || document.documentElement).appendChild(style);
    }

    if (document.head || document.documentElement) injectStyle();
    else document.addEventListener('DOMContentLoaded', injectStyle, { once: true });

    // ==========================================
    // 4. 可串接 hook 工具
    // ==========================================
    /**
     * 讀「而家」嘅 descriptor 再 wrap，保留之前腳本（例如 antitrack）嘅 setter 鏈。
     * configurable:true 方便之後腳本再 wrap 我哋。
     */
    function wrapSetter(proto, prop, makeSetter, makeGetter) {
        if (!proto) return false;
        let desc = Object.getOwnPropertyDescriptor(proto, prop);
        let owner = proto;
        if (!desc || !desc.set) {
            let curr = Object.getPrototypeOf(proto);
            while (curr && (!desc || !desc.set)) {
                desc = Object.getOwnPropertyDescriptor(curr, prop);
                if (desc && desc.set) {
                    owner = curr;
                    break;
                }
                curr = Object.getPrototypeOf(curr);
            }
        }
        if (!desc || typeof desc.set !== 'function') {
            log('skip wrap', prop, 'no setter');
            return false;
        }
        // 若 descriptor 喺祖先上，仍然 define 喺目標 proto（shadow 祖先）
        const prevSet = desc.set;
        const prevGet = desc.get;
        try {
            Object.defineProperty(proto, prop, {
                configurable: true,
                enumerable: !!desc.enumerable,
                get: makeGetter
                    ? makeGetter(prevGet)
                    : (prevGet ? function () { return prevGet.call(this); } : undefined),
                set: makeSetter(prevSet)
            });
            return true;
        } catch (err) {
            log('wrapSetter failed', prop, err);
            return false;
        }
    }

    function wrapMethod(proto, prop, createReplacement) {
        if (!proto) return false;
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc || typeof desc.value !== 'function') {
            // fallback：直接讀 function
            const fn = proto[prop];
            if (typeof fn !== 'function') return false;
            try {
                proto[prop] = createReplacement(fn);
                return true;
            } catch (err) {
                log('wrapMethod failed', prop, err);
                return false;
            }
        }
        try {
            Object.defineProperty(proto, prop, {
                ...desc,
                configurable: true,
                value: createReplacement(desc.value)
            });
            return true;
        } catch (err) {
            log('wrapMethod define failed', prop, err);
            return false;
        }
    }

    function isUnlocking(el) {
        return !!(el && el._tSmUnlocking);
    }

    function withUnlocking(el, fn) {
        if (!el) return;
        el._tSmUnlocking = true;
        try {
            fn();
        } finally {
            el._tSmUnlocking = false;
        }
    }

    function getState(el) {
        return el && el.dataset ? el.dataset[DS.state] : '';
    }

    function setState(el, state) {
        if (el && el.dataset) el.dataset[DS.state] = state;
    }

    function isLocked(el) {
        return getState(el) === STATE_LOCKED;
    }

    function isUnlocked(el) {
        return getState(el) === STATE_UNLOCKED;
    }

    function markProcessed(el, value) {
        if (el && el.dataset) el.dataset[DS.processed] = value ? 'true' : 'false';
    }

    function isProcessed(el) {
        return el && el.dataset && el.dataset[DS.processed] === 'true';
    }

    function storeMediaUrl(el, key, value) {
        const s = toStoredUrl(value);
        if (s && el && el.dataset) el.dataset[key] = s;
    }

    function inDialog(el) {
        return !!(el && el.closest && el.closest('[role="dialog"]'));
    }

    /** src/srcset 經 setter 變更時，排隊俾 process* 補上 observe / a11y */
    const pending = new Set();
    let scheduled = false;

    function queueElement(el) {
        if (!el || el.nodeType !== 1) return;
        pending.add(el);
        scheduleFlush();
    }

    function scheduleFlush() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(flush);
    }

    // flush / handleElement 喺後面定義；呢度先宣告避免 TDZ（function 聲明會 hoist）
    function flush() {
        scheduled = false;
        if (pending.size === 0) return;
        const batch = Array.from(pending);
        pending.clear();
        for (let i = 0; i < batch.length; i++) {
            try {
                handleElement(batch[i]);
            } catch (err) {
                log('handleElement error', err);
            }
        }
        refreshLoadAllButton();
    }

    // ==========================================
    // 5. 網絡層：fetch + XHR（可串接）
    // ==========================================
    function emptyMediaResponse() {
        return new Response(new Blob([]), {
            status: 204,
            statusText: 'No Content',
            headers: { 'Cache-Control': 'no-store' }
        });
    }

    wrapMethod(window, 'fetch', (nativeFetch) => function (...args) {
        try {
            if (shouldBlockNetworkMedia(args[0])) {
                stats.blockedFetch++;
                log('block fetch', parseUrl(args[0]) && parseUrl(args[0]).href);
                return Promise.resolve(emptyMediaResponse());
            }
        } catch (err) {
            log('fetch gate error', err);
        }
        return nativeFetch.apply(this, args);
    });

    (function patchXHR() {
        if (typeof XMLHttpRequest === 'undefined') return;
        const xhrProto = XMLHttpRequest.prototype;
        const nativeOpen = xhrProto.open;
        const nativeSend = xhrProto.send;

        xhrProto.open = function (method, url, ...rest) {
            try {
                this._tSmUrl = url;
                this._tSmBlock = shouldBlockNetworkMedia(url);
            } catch (_) {
                this._tSmBlock = false;
            }
            return nativeOpen.call(this, method, url, ...rest);
        };

        xhrProto.send = function (...args) {
            if (this._tSmBlock) {
                stats.blockedXhr++;
                log('block xhr', this._tSmUrl);
                // 模擬成功但空 body，減少頁面 exception
                const xhr = this;
                queueMicrotask(() => {
                    try {
                        Object.defineProperty(xhr, 'readyState', { configurable: true, get: () => 4 });
                        Object.defineProperty(xhr, 'status', { configurable: true, get: () => 204 });
                        Object.defineProperty(xhr, 'response', { configurable: true, get: () => '' });
                        Object.defineProperty(xhr, 'responseText', { configurable: true, get: () => '' });
                        xhr.dispatchEvent(new Event('readystatechange'));
                        xhr.dispatchEvent(new Event('load'));
                        xhr.dispatchEvent(new Event('loadend'));
                    } catch (err) {
                        log('xhr fake response error', err);
                    }
                });
                return;
            }
            return nativeSend.apply(this, args);
        };
    })();

    // 靜音 locked 媒體嘅資源錯誤，減少 console 噪音
    window.addEventListener('error', (e) => {
        const t = e.target;
        if (!t || !t.tagName) return;
        if ((t.tagName === 'IMG' || t.tagName === 'VIDEO' || t.tagName === 'SOURCE') && isLocked(t)) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }
    }, true);

    // ==========================================
    // 6. Preload 攔截（唔 patch appendChild）
    // ==========================================
    function isImagePreloadLink(el) {
        if (!el || el.tagName !== 'LINK') return false;
        const rel = String(el.getAttribute('rel') || el.rel || '').toLowerCase();
        const asAttr = String(el.getAttribute('as') || el.as || '').toLowerCase();
        return rel.split(/\s+/).includes('preload') && asAttr === 'image';
    }

    function neutralizePreloadLink(link) {
        if (!link || !isImagePreloadLink(link)) return false;
        try {
            link.removeAttribute('href');
            link.removeAttribute('imagesrcset');
            link.removeAttribute('imagesizes');
            if (link.href) {
                try { link.href = ''; } catch (_) { /* ignore */ }
            }
            stats.preloadDropped++;
            log('drop preload link');
            return true;
        } catch (err) {
            log('neutralizePreload error', err);
            return false;
        }
    }

    // ==========================================
    // 7. Element 狀態：gate media sources
    // ==========================================
    function gateImageSrc(img, value, prevSet) {
        if (isUnlocking(img) || isUnlocked(img) || getState(img) === STATE_IGNORED) {
            return prevSet.call(img, value);
        }
        if (isDataUrl(value) || isPlaceholder(value)) {
            return prevSet.call(img, value);
        }
        storeMediaUrl(img, DS.src, value);
        markProcessed(img, false);
        setState(img, STATE_LOCKED);
        queueElement(img);
        return prevSet.call(img, PLACEHOLDER);
    }

    function gateImageSrcset(img, value, prevSet) {
        if (isUnlocking(img) || isUnlocked(img) || getState(img) === STATE_IGNORED) {
            return prevSet.call(img, value);
        }
        if (value) storeMediaUrl(img, DS.srcset, value);
        markProcessed(img, false);
        setState(img, STATE_LOCKED);
        queueElement(img);
        return prevSet.call(img, '');
    }

    function gateSourceAttr(source, prop, value, prevSet) {
        if (isUnlocking(source)) {
            return prevSet ? prevSet.call(source, value) : undefined;
        }
        const key = prop === 'srcset' ? DS.srcset : DS.src;
        if (value) storeMediaUrl(source, key, value);
        // 同步 picture > img
        try {
            const pic = source.closest && source.closest('picture');
            if (pic) {
                const img = pic.querySelector('img');
                if (img && !isUnlocked(img) && getState(img) !== STATE_IGNORED) {
                    setState(img, STATE_LOCKED);
                    markProcessed(img, false);
                    if (prop === 'srcset' && value) storeMediaUrl(img, DS.srcset, value);
                    if (prop === 'src' && value) storeMediaUrl(img, DS.src, value);
                    queueElement(img);
                }
            }
        } catch (_) { /* ignore */ }
        // source：唔寫真實 URL；srcset 清走，src 唔 set
        if (prop === 'srcset' && prevSet) return prevSet.call(source, '');
        if (prop === 'src') return; // 唔呼叫 prevSet，避免觸發載入
        return prevSet ? prevSet.call(source, value) : undefined;
    }

    function gateVideoSrc(video, value, prevSet) {
        if (isUnlocking(video) || isUnlocked(video) || getState(video) === STATE_IGNORED) {
            return prevSet.call(video, value);
        }
        if (isDataUrl(value) || isPlaceholder(value) || isBlobUrl(value)) {
            // blob 多數係已解鎖後嘅本地解碼；若仍 locked 就擋
            if (isBlobUrl(value) && !isUnlocked(video)) {
                storeMediaUrl(video, DS.src, value);
                setState(video, STATE_LOCKED);
                markProcessed(video, false);
                return;
            }
            return prevSet.call(video, value);
        }
        storeMediaUrl(video, DS.src, value);
        setState(video, STATE_LOCKED);
        markProcessed(video, false);
        queueElement(video);
        // 唔寫 src，避免 media element 開始 fetch
        return;
    }

    function gateVideoPoster(video, value, prevSet) {
        if (isUnlocking(video) || isUnlocked(video) || getState(video) === STATE_IGNORED) {
            return prevSet.call(video, value);
        }
        if (isDataUrl(value) || isPlaceholder(value)) {
            return prevSet.call(video, value);
        }
        storeMediaUrl(video, DS.poster, value);
        queueElement(video);
        return prevSet.call(video, PLACEHOLDER);
    }

    // --- property hooks ---
    wrapSetter(
        HTMLImageElement.prototype,
        'src',
        (prevSet) => function (val) {
            try {
                return gateImageSrc(this, val, prevSet);
            } catch (err) {
                log('img.src error', err);
                return prevSet.call(this, val);
            }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.src] && isLocked(this)) {
                return this.dataset[DS.src];
            }
            return prevGet ? prevGet.call(this) : '';
        }
    );

    wrapSetter(
        HTMLImageElement.prototype,
        'srcset',
        (prevSet) => function (val) {
            try {
                return gateImageSrcset(this, val, prevSet);
            } catch (err) {
                log('img.srcset error', err);
                return prevSet.call(this, val);
            }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.srcset] && isLocked(this)) {
                return this.dataset[DS.srcset];
            }
            return prevGet ? prevGet.call(this) : '';
        }
    );

    wrapSetter(
        HTMLSourceElement.prototype,
        'src',
        (prevSet) => function (val) {
            try {
                return gateSourceAttr(this, 'src', val, prevSet);
            } catch (err) {
                log('source.src error', err);
                return prevSet.call(this, val);
            }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.src]) {
                return this.dataset[DS.src];
            }
            return prevGet ? prevGet.call(this) : '';
        }
    );

    wrapSetter(
        HTMLSourceElement.prototype,
        'srcset',
        (prevSet) => function (val) {
            try {
                return gateSourceAttr(this, 'srcset', val, prevSet);
            } catch (err) {
                log('source.srcset error', err);
                return prevSet.call(this, val);
            }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.srcset]) {
                return this.dataset[DS.srcset];
            }
            return prevGet ? prevGet.call(this) : '';
        }
    );

    wrapSetter(
        HTMLMediaElement.prototype,
        'src',
        (prevSet) => function (val) {
            try {
                if (this.tagName === 'VIDEO') return gateVideoSrc(this, val, prevSet);
                return prevSet.call(this, val);
            } catch (err) {
                log('media.src error', err);
                return prevSet.call(this, val);
            }
        },
        (prevGet) => function () {
            if (this.tagName === 'VIDEO' && !isUnlocking(this) && this.dataset && this.dataset[DS.src] && isLocked(this)) {
                return this.dataset[DS.src];
            }
            return prevGet ? prevGet.call(this) : '';
        }
    );

    wrapSetter(
        HTMLMediaElement.prototype,
        'autoplay',
        (prevSet) => function (val) {
            try {
                if (this.tagName === 'VIDEO' && !isUnlocking(this) && !isUnlocked(this) && getState(this) !== STATE_IGNORED) {
                    return prevSet.call(this, false);
                }
                return prevSet.call(this, val);
            } catch (err) {
                return prevSet.call(this, val);
            }
        }
    );

    wrapSetter(
        HTMLMediaElement.prototype,
        'preload',
        (prevSet) => function (val) {
            try {
                if (this.tagName === 'VIDEO' && !isUnlocking(this) && !isUnlocked(this) && getState(this) !== STATE_IGNORED) {
                    return prevSet.call(this, 'none');
                }
                return prevSet.call(this, val);
            } catch (err) {
                return prevSet.call(this, val);
            }
        }
    );

    wrapSetter(
        HTMLVideoElement.prototype,
        'poster',
        (prevSet) => function (val) {
            try {
                return gateVideoPoster(this, val, prevSet);
            } catch (err) {
                log('video.poster error', err);
                return prevSet.call(this, val);
            }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.poster] && isLocked(this)) {
                return this.dataset[DS.poster];
            }
            return prevGet ? prevGet.call(this) : '';
        }
    );

    // setAttribute 串接
    (function patchSetAttribute() {
        const prev = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            try {
                if (!this || typeof name !== 'string') {
                    return prev.call(this, name, value);
                }
                const attr = name.toLowerCase();

                if (this.tagName === 'LINK') {
                    if (attr === 'rel' || attr === 'as' || attr === 'href' || attr === 'imagesrcset' || attr === 'imagesizes') {
                        const result = prev.call(this, name, value);
                        if (isImagePreloadLink(this)) neutralizePreloadLink(this);
                        return result;
                    }
                }

                if (isUnlocking(this)) {
                    return prev.call(this, name, value);
                }

                if (this.tagName === 'IMG') {
                    if (attr === 'src') {
                        if (isUnlocked(this) || getState(this) === STATE_IGNORED || isDataUrl(value) || isPlaceholder(value)) {
                            return prev.call(this, name, value);
                        }
                        storeMediaUrl(this, DS.src, value);
                        markProcessed(this, false);
                        setState(this, STATE_LOCKED);
                        queueElement(this);
                        return prev.call(this, name, PLACEHOLDER);
                    }
                    if (attr === 'srcset') {
                        if (isUnlocked(this) || getState(this) === STATE_IGNORED) {
                            return prev.call(this, name, value);
                        }
                        if (value) storeMediaUrl(this, DS.srcset, value);
                        markProcessed(this, false);
                        setState(this, STATE_LOCKED);
                        queueElement(this);
                        return prev.call(this, name, '');
                    }
                }

                if (this.tagName === 'SOURCE' && (attr === 'src' || attr === 'srcset')) {
                    const key = attr === 'srcset' ? DS.srcset : DS.src;
                    if (value) storeMediaUrl(this, key, value);
                    try {
                        const pic = this.closest('picture');
                        const img = pic && pic.querySelector('img');
                        if (img && !isUnlocked(img) && getState(img) !== STATE_IGNORED) {
                            setState(img, STATE_LOCKED);
                            markProcessed(img, false);
                            queueElement(img);
                        }
                    } catch (_) { /* ignore */ }
                    if (attr === 'srcset') return prev.call(this, name, '');
                    return; // 唔寫 src
                }

                if (this.tagName === 'VIDEO') {
                    if (attr === 'src') {
                        if (isUnlocked(this) || getState(this) === STATE_IGNORED) {
                            return prev.call(this, name, value);
                        }
                        storeMediaUrl(this, DS.src, value);
                        setState(this, STATE_LOCKED);
                        markProcessed(this, false);
                        queueElement(this);
                        return; // 唔寫真實 src
                    }
                    if (attr === 'poster') {
                        if (isUnlocked(this) || getState(this) === STATE_IGNORED || isDataUrl(value) || isPlaceholder(value)) {
                            return prev.call(this, name, value);
                        }
                        storeMediaUrl(this, DS.poster, value);
                        queueElement(this);
                        return prev.call(this, name, PLACEHOLDER);
                    }
                    if (attr === 'autoplay') return;
                    if (attr === 'preload') return prev.call(this, name, 'none');
                }
            } catch (err) {
                log('setAttribute error', err);
            }
            return prev.call(this, name, value);
        };
    })();

    // play()：未解鎖唔畀 autoplay
    const originalPlay = HTMLVideoElement.prototype.play;
    wrapMethod(HTMLVideoElement.prototype, 'play', (nativePlay) => function (...args) {
        if (isUnlocked(this) || getState(this) === STATE_IGNORED) {
            return nativePlay.apply(this, args);
        }
        if (!CONFIG.blockDialogMedia && inDialog(this)) {
            return nativePlay.apply(this, args);
        }
        setState(this, STATE_LOCKED);
        return Promise.reject(new DOMException('Autoplay blocked by Threads Stop Media', 'NotAllowedError'));
    });

    // ==========================================
    // 8. IntersectionObserver + 可見集合
    // ==========================================
    const visibleLocked = new Set();

    const io = new IntersectionObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const el = entry.target;
            if (entry.isIntersecting && isLocked(el) && el.isConnected) {
                visibleLocked.add(el);
            } else {
                visibleLocked.delete(el);
            }
        }
        refreshLoadAllButton();
    }, { root: null, rootMargin: '0px', threshold: 0.05 });

    function observeLocked(el) {
        if (!el) return;
        try {
            io.observe(el);
        } catch (_) { /* ignore */ }
    }

    function unobserve(el) {
        if (!el) return;
        visibleLocked.delete(el);
        try {
            io.unobserve(el);
        } catch (_) { /* ignore */ }
    }

    function pruneVisible() {
        for (const el of Array.from(visibleLocked)) {
            if (!el.isConnected || !isLocked(el)) visibleLocked.delete(el);
        }
    }

    // ==========================================
    // 9. 分類：ignore / lock
    // ==========================================
    function parsePxAttr(val) {
        if (val == null || val === '') return null;
        const s = String(val).trim();
        if (!s || s.includes('%')) return null;
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? n : null;
    }

    function isSmallByAttributes(img) {
        const w = parsePxAttr(img.getAttribute('width'));
        const h = parsePxAttr(img.getAttribute('height'));
        if (w != null && w > 0 && w < 50) return true;
        if (h != null && h > 0 && h < 50) return true;
        return false;
    }

    /**
     * 結構啟發式：avatar / 細 icon，唔靠單一 alt 語言。
     * - alt 含 profile / avatar / 頭像（多語言）
     * - 父層係細尺寸 link（常見頭像）
     * - favicon / 極細 attribute
     */
    function shouldIgnoreImage(img) {
        if (!img || img.tagName !== 'IMG') return true;
        if (img.closest('svg')) return true;
        if (!CONFIG.blockDialogMedia && inDialog(img)) return true;

        const alt = String(img.getAttribute('alt') || img.alt || '').toLowerCase();
        if (
            alt.includes('profile') ||
            alt.includes('avatar') ||
            alt.includes('頭像') ||
            alt.includes('プロフィール') ||
            alt.includes('프로필')
        ) {
            return true;
        }

        if (isSmallByAttributes(img)) return true;

        const stored = img.dataset[DS.src] || '';
        const attrSrc = img.getAttribute('src') || '';
        const check = (stored || attrSrc).toLowerCase();
        if (check.includes('favicon')) return true;

        // 細圓形頭像：父 link 好細
        try {
            const link = img.closest('a[role="link"], a[href*="/@"], a[href*="/user"]');
            if (link) {
                const r = link.getBoundingClientRect();
                if (r.width > 0 && r.height > 0 && r.width <= 64 && r.height <= 64) {
                    return true;
                }
            }
        } catch (_) { /* ignore */ }

        return false;
    }

    function isNearVideoPoster(img) {
        let curr = img.parentElement;
        for (let i = 0; i < 2 && curr; i++) {
            if (curr.querySelector && curr.querySelector('video')) return true;
            curr = curr.parentElement;
        }
        return false;
    }

    function silenceAsIgnored(el) {
        setState(el, STATE_IGNORED);
        markProcessed(el, true);
        unobserve(el);
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
        stats.ignored++;
    }

    function makeUnlockableA11y(el, kind) {
        if (!el || el.dataset[DS.unlockable] === '1') return;
        el.dataset[DS.unlockable] = '1';
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        el.setAttribute(
            'aria-label',
            kind === 'video' ? '載入影片（Enter 或 點擊）' : '載入圖片（Enter 或 點擊）'
        );
    }

    function stripA11y(el) {
        if (!el) return;
        delete el.dataset[DS.unlockable];
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
    }

    /**
     * 強制把已存在嘅真實 src 換成 placeholder（補 parser 唔經 JS setter 嘅洞）。
     */
    function forceStripImageNetwork(img) {
        const attrSrc = img.getAttribute('src');
        const attrSrcset = img.getAttribute('srcset');
        if (attrSrc && !isPlaceholder(attrSrc) && !isDataUrl(attrSrc)) {
            storeMediaUrl(img, DS.src, attrSrc);
        }
        if (attrSrcset && attrSrcset.trim()) {
            storeMediaUrl(img, DS.srcset, attrSrcset);
        }
        // 用 removeAttribute 避開部分 hook 迴圈，再寫 placeholder
        withUnlocking(img, () => {
            try {
                if (img.getAttribute('srcset')) img.removeAttribute('srcset');
                if (!isPlaceholder(img.getAttribute('src') || '')) {
                    img.setAttribute('src', PLACEHOLDER);
                }
            } catch (err) {
                log('forceStripImage error', err);
            }
        });
    }

    function forceStripVideoNetwork(video) {
        const attrSrc = video.getAttribute('src');
        const attrPoster = video.getAttribute('poster');
        if (attrSrc && !isPlaceholder(attrSrc) && !isDataUrl(attrSrc)) {
            storeMediaUrl(video, DS.src, attrSrc);
        }
        if (attrPoster && !isPlaceholder(attrPoster) && !isDataUrl(attrPoster)) {
            storeMediaUrl(video, DS.poster, attrPoster);
        }
        withUnlocking(video, () => {
            try {
                video.removeAttribute('autoplay');
                video.autoplay = false;
                video.preload = 'none';
                if (video.getAttribute('src')) {
                    video.removeAttribute('src');
                }
                if (attrPoster && !isPlaceholder(attrPoster)) {
                    video.setAttribute('poster', PLACEHOLDER);
                }
                // 清 source children
                const sources = video.querySelectorAll('source');
                for (let i = 0; i < sources.length; i++) {
                    const s = sources[i];
                    const ss = s.getAttribute('src');
                    const sset = s.getAttribute('srcset');
                    if (ss) storeMediaUrl(s, DS.src, ss);
                    if (sset) storeMediaUrl(s, DS.srcset, sset);
                    s._tSmUnlocking = true;
                    try {
                        if (ss) s.removeAttribute('src');
                        if (sset) s.removeAttribute('srcset');
                    } finally {
                        s._tSmUnlocking = false;
                    }
                }
                // 取消已開始嘅緩衝
                try { video.load(); } catch (_) { /* ignore */ }
            } catch (err) {
                log('forceStripVideo error', err);
            }
        });
    }

    function processVideo(video) {
        if (!video || video.tagName !== 'VIDEO') return;
        if (isUnlocked(video)) return;
        if (isProcessed(video) && isLocked(video)) {
            observeLocked(video);
            return;
        }

        if (!CONFIG.blockDialogMedia && inDialog(video)) {
            silenceAsIgnored(video);
            return;
        }

        const firstManage = video.dataset[DS.managed] !== '1';
        video.dataset[DS.managed] = '1';
        markProcessed(video, true);
        setState(video, STATE_LOCKED);
        forceStripVideoNetwork(video);
        makeUnlockableA11y(video, 'video');
        observeLocked(video);
        if (firstManage) {
            stats.lockedVideo++;
            log('locked video');
        }

        // 附近 locked 圖當 poster 靜音（唔提供解鎖）
        let curr = video.parentElement;
        for (let i = 0; i < 2 && curr; i++) {
            const imgs = curr.querySelectorAll('img');
            for (let j = 0; j < imgs.length; j++) {
                const img = imgs[j];
                if (isLocked(img) || !isProcessed(img)) {
                    silenceAsIgnored(img);
                    stripA11y(img);
                }
            }
            curr = curr.parentElement;
        }
    }

    function processImage(img) {
        if (!img || img.tagName !== 'IMG') return;
        if (isUnlocked(img)) return;

        if (isProcessed(img) && isLocked(img)) {
            // 遲啲先有 profile alt 時可放行
            if (shouldIgnoreImage(img)) {
                unlockImage(img, true);
            } else {
                observeLocked(img);
            }
            return;
        }

        if (shouldIgnoreImage(img)) {
            markProcessed(img, true);
            unlockImage(img, true);
            return;
        }

        if (isNearVideoPoster(img)) {
            markProcessed(img, true);
            silenceAsIgnored(img);
            forceStripImageNetwork(img); // 唔載 poster
            return;
        }

        const firstManage = img.dataset[DS.managed] !== '1';
        img.dataset[DS.managed] = '1';
        markProcessed(img, true);
        setState(img, STATE_LOCKED);
        forceStripImageNetwork(img);
        makeUnlockableA11y(img, 'image');
        observeLocked(img);
        if (firstManage) {
            stats.lockedImg++;
            log('locked image');
        }
    }

    function handleElement(el) {
        if (!el || el.nodeType !== 1) return;
        if (el.tagName === 'VIDEO') processVideo(el);
        else if (el.tagName === 'IMG') processImage(el);
        else if (el.tagName === 'LINK' && isImagePreloadLink(el)) neutralizePreloadLink(el);
    }

    // ==========================================
    // 10. 解鎖
    // ==========================================
    function unlockImage(img, silent) {
        if (!img || img.tagName !== 'IMG') return;
        setState(img, silent ? STATE_IGNORED : STATE_UNLOCKED);
        markProcessed(img, true);
        delete img.dataset[DS.managed];
        unobserve(img);
        stripA11y(img);

        withUnlocking(img, () => {
            try {
                const picture = img.closest('picture');
                if (picture) {
                    const sources = picture.querySelectorAll('source');
                    for (let i = 0; i < sources.length; i++) {
                        const source = sources[i];
                        source._tSmUnlocking = true;
                        try {
                            if (source.dataset[DS.srcset]) source.srcset = source.dataset[DS.srcset];
                            if (source.dataset[DS.src]) source.src = source.dataset[DS.src];
                        } finally {
                            source._tSmUnlocking = false;
                        }
                    }
                }
                if (img.dataset[DS.src]) img.src = img.dataset[DS.src];
                if (img.dataset[DS.srcset]) img.srcset = img.dataset[DS.srcset];
            } catch (err) {
                log('unlockImage error', err);
            }
        });

        if (!silent) {
            stats.unlockedImg++;
            log('unlocked image');
        }
        refreshLoadAllButton();
    }

    function unlockVideo(video) {
        if (!video || video.tagName !== 'VIDEO') return;
        setState(video, STATE_UNLOCKED);
        markProcessed(video, true);
        delete video.dataset[DS.managed];
        unobserve(video);
        stripA11y(video);

        withUnlocking(video, () => {
            try {
                const sources = video.querySelectorAll('source');
                for (let i = 0; i < sources.length; i++) {
                    const source = sources[i];
                    source._tSmUnlocking = true;
                    try {
                        if (source.dataset[DS.srcset]) source.srcset = source.dataset[DS.srcset];
                        if (source.dataset[DS.src]) source.src = source.dataset[DS.src];
                    } finally {
                        source._tSmUnlocking = false;
                    }
                }
                if (video.dataset[DS.src]) video.src = video.dataset[DS.src];
                if (video.dataset[DS.poster]) video.poster = video.dataset[DS.poster];
                if (video.dataset[DS.src] || video.querySelector('source')) {
                    try { video.load(); } catch (_) { /* ignore */ }
                }
            } catch (err) {
                log('unlockVideo error', err);
            }
        });

        // 短暫擋 pause，避免 React 一解鎖即 pause
        video._tSmBlockPause = true;
        if (!video._tSmPauseWrapped) {
            video._tSmPauseWrapped = true;
            const nativePause = video.pause.bind(video);
            video.pause = function (...args) {
                if (this._tSmBlockPause) return;
                return nativePause(...args);
            };
        }

        try {
            const p = originalPlay.call(video);
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) { /* autoplay policy */ }

        setTimeout(() => {
            if (video) video._tSmBlockPause = false;
        }, CONFIG.pauseBlockMs);

        stats.unlockedVideo++;
        log('unlocked video');
        refreshLoadAllButton();
    }

    function unlockElement(el) {
        if (!el) return;
        if (el.tagName === 'VIDEO') unlockVideo(el);
        else if (el.tagName === 'IMG') unlockImage(el, false);
    }

    function unlockAllVisible() {
        pruneVisible();
        const list = Array.from(visibleLocked);
        for (let i = 0; i < list.length; i++) {
            unlockElement(list[i]);
        }
        log('unlock all visible', list.length);
    }

    // ==========================================
    // 11. 「載入可見媒體」浮動掣
    // ==========================================
    let loadAllBtn = null;

    function ensureLoadAllButton() {
        if (loadAllBtn || !document.documentElement) return;
        loadAllBtn = document.createElement('button');
        loadAllBtn.type = 'button';
        loadAllBtn.id = 'threads-stop-media-load-all';
        loadAllBtn.hidden = true;
        loadAllBtn.setAttribute('aria-label', '載入目前可見嘅圖片同影片');
        loadAllBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            unlockAllVisible();
        });
        (document.body || document.documentElement).appendChild(loadAllBtn);
    }

    function refreshLoadAllButton() {
        pruneVisible();
        if (!loadAllBtn) {
            if (document.body || document.documentElement) ensureLoadAllButton();
        }
        if (!loadAllBtn) return;
        const n = visibleLocked.size;
        if (n === 0) {
            loadAllBtn.hidden = true;
            return;
        }
        loadAllBtn.hidden = false;
        loadAllBtn.textContent = `📥 載入可見媒體（${n}）`;
    }

    // ==========================================
    // 12. 交互：解鎖 + 吞 gallery 事件
    // ==========================================
    let isSwallowing = false;
    let swallowTimer = null;

    function clearSwallow() {
        isSwallowing = false;
        if (swallowTimer != null) {
            clearTimeout(swallowTimer);
            swallowTimer = null;
        }
    }

    function beginSwallow() {
        isSwallowing = true;
        if (swallowTimer != null) clearTimeout(swallowTimer);
        swallowTimer = setTimeout(clearSwallow, CONFIG.swallowTimeoutMs);
    }

    function findLockedFromPoint(x, y) {
        let stack;
        try {
            stack = document.elementsFromPoint(x, y);
        } catch (_) {
            stack = [];
        }
        for (let i = 0; i < stack.length; i++) {
            let el = stack[i];
            // 向上搵 locked media（點中 child overlay 都算）
            while (el && el !== document.documentElement) {
                if (
                    el.nodeType === 1 &&
                    (el.tagName === 'IMG' || el.tagName === 'VIDEO') &&
                    isLocked(el)
                ) {
                    return el;
                }
                el = el.parentElement;
            }
        }
        // fallback：visible set + rect（elementsFromPoint 被 overlay 擋時）
        for (const el of visibleLocked) {
            if (!el.isConnected || !isLocked(el)) continue;
            const r = el.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                return el;
            }
        }
        return null;
    }

    function onPointerDown(e) {
        if (!e.isTrusted) return;

        if (isSwallowing) {
            // 新一次 pointerdown：結束上一輪 swallow，允許正常操作
            clearSwallow();
        }

        const x = e.clientX;
        const y = e.clientY;
        if (x == null || y == null) return;
        if (visibleLocked.size === 0 && !document.querySelector(`[data-t-sm-state="${STATE_LOCKED}"]`)) {
            return;
        }

        const hit = findLockedFromPoint(x, y);
        if (!hit) return;

        unlockElement(hit);
        beginSwallow();
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }

    function onSwallowable(e) {
        if (!e.isTrusted) return;
        if (!isSwallowing) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.type === 'click' || e.type === 'dblclick' || e.type === 'auxclick') {
            clearSwallow();
        }
    }

    function onKeyActivate(e) {
        if (!e.isTrusted) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const t = e.target;
        if (!t || (t.tagName !== 'IMG' && t.tagName !== 'VIDEO')) return;
        if (!isLocked(t)) return;
        e.preventDefault();
        e.stopPropagation();
        unlockElement(t);
        beginSwallow();
    }

    const SWALLOW_EVENTS = [
        'pointerup',
        'mousedown',
        'mouseup',
        'click',
        'dblclick',
        'auxclick',
        'touchend'
    ];

    window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: false });
    SWALLOW_EVENTS.forEach((evt) => {
        window.addEventListener(evt, onSwallowable, { capture: true, passive: false });
    });
    window.addEventListener('keydown', onKeyActivate, { capture: true });

    // ==========================================
    // 13. 增量 MutationObserver + rAF
    // ==========================================
    function queueNode(node) {
        if (!node || node.nodeType !== 1) return;
        if (node.tagName === 'IMG' || node.tagName === 'VIDEO' || node.tagName === 'LINK') {
            pending.add(node);
        }
        if (node.querySelectorAll) {
            const list = node.querySelectorAll('img, video, link[rel="preload"]');
            for (let i = 0; i < list.length; i++) pending.add(list[i]);
        }
        if (pending.size) scheduleFlush();
    }

    function scanAll() {
        try {
            document.querySelectorAll('img, video, link[rel="preload"]').forEach((el) => pending.add(el));
            scheduleFlush();
        } catch (err) {
            log('scanAll error', err);
        }
    }

    const observer = new MutationObserver((mutations) => {
        for (let i = 0; i < mutations.length; i++) {
            const m = mutations[i];
            if (m.type === 'childList') {
                const nodes = m.addedNodes;
                for (let j = 0; j < nodes.length; j++) queueNode(nodes[j]);
            }
        }
        if (pending.size) scheduleFlush();
    });

    function startObserver() {
        const root = document.documentElement || document;
        try {
            observer.observe(root, { childList: true, subtree: true });
        } catch (err) {
            log('observe failed', err);
        }
        injectStyle();
        ensureLoadAllButton();
        scanAll();
    }

    if (document.documentElement) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            injectStyle();
            ensureLoadAllButton();
            scanAll();
        }, { once: true });
    } else {
        ensureLoadAllButton();
        scanAll();
    }

    // 診斷 API（只讀；唔寫入頁面設定）
    try {
        Object.defineProperty(window, 'ThreadsStopMedia', {
            configurable: true,
            enumerable: false,
            get() {
                return {
                    version: VERSION,
                    config: { ...CONFIG },
                    stats: { ...stats },
                    visibleLocked: visibleLocked.size
                };
            }
        });
    } catch (_) { /* ignore */ }

    log('initialized', {
        mediaHosts: CONFIG.mediaHosts,
        blockDialogMedia: CONFIG.blockDialogMedia,
        smallMediaMaxPx: CONFIG.smallMediaMaxPx
    });
})();
