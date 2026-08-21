// ==UserScript==
// @name         Threads 阻擋自動載媒體 (iOS Safari)
// @namespace    https://github.com/mark1688288/digital-detox
// @version      1.0.0-ios.2
// @description  Threads 圖片／影片改為手動載入（iPhone Safari + Tampermonkey）。桌面 1.0 架構：hostname CDN、可串接 hook、fetch/XHR 雙擋；iOS：捲動安全 tap、unsafeWindow、WebKit 殘影 flush、playsinline。
// @author       mark1688288
// @homepageURL  https://github.com/mark1688288/digital-detox
// @downloadURL  https://raw.githubusercontent.com/mark1688288/digital-detox/main/ios/threads-detox-ios.js
// @updateURL    https://raw.githubusercontent.com/mark1688288/digital-detox/main/ios/threads-detox-ios.js
// @match        https://www.threads.net/*
// @match        https://threads.net/*
// @match        https://*.threads.net/*
// @match        https://www.threads.com/*
// @match        https://threads.com/*
// @match        https://*.threads.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=threads.com
// @run-at       document-start
// @grant        unsafeWindow
// @sandbox      raw
// @license      MIT
// ==/UserScript==

/**
 * iOS Safari / Tampermonkey
 * -------------------------
 * - 目標：iPhone Safari + Tampermonkey（iPad 都用得，但以 touch phone 為準）。
 *
 * 注入：
 * - `@sandbox raw` → 盡量 MAIN_WORLD。
 * - `@grant unsafeWindow` → iOS Tampermonkey 若忽略 @sandbox 而入咗 sandbox，
 *   仍然 patch 頁面真身嘅 prototype / fetch（唔好只 patch sandbox）。
 *
 * iOS 同桌面 1.0 嘅分別：
 * - 捲動安全：pointerdown 唔 preventDefault；超過 slop 或 pointercancel 當捲動；
 *   確認 tap 先喺 pointerup 解鎖。唔聽 touchmove。
 * - WebKit 殘影：forceStrip 後 pause + load()；閘 srcObject。
 * - 解鎖影片設 playsinline，避免 iOS 強制全螢幕。
 * - safe-area 浮動掣；:hover 只喺滑鼠。
 */

(function () {
    'use strict';

    const VERSION = '1.0.0-ios.2';
    const PLATFORM = 'iOS';
    const INSTALL_KEY = 'threads-stop-media';

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const doc = W.document || document;

    try {
        if (W[INSTALL_KEY] || W.__threadsStopMediaActive || W.__threadsVBActive) {
            return;
        }
        Object.defineProperty(W, INSTALL_KEY, {
            configurable: false,
            enumerable: false,
            value: VERSION + '+' + PLATFORM,
            writable: false
        });
        W.__threadsStopMediaActive = true;
        W.__threadsVBActive = true;
    } catch (_) {
        if (W.__threadsStopMediaActive || W.__threadsVBActive) return;
        W.__threadsStopMediaActive = true;
        W.__threadsVBActive = true;
    }
    if (window !== W) {
        try { window.__threadsStopMediaActive = true; } catch (_) { /* ignore */ }
    }

    const PLACEHOLDER =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const STYLE_ID = 'threads-stop-media-ios-style';
    const STATE_LOCKED = 'locked';
    const STATE_UNLOCKED = 'unlocked';
    const STATE_IGNORED = 'ignored';
    const LOAD_ALL_ID = 'threads-stop-media-load-all';

    const DS = {
        state: 'tSmState',
        processed: 'tSmProcessed',
        src: 'tSmSrc',
        srcset: 'tSmSrcset',
        poster: 'tSmPoster',
        unlockable: 'tSmUnlockable',
        managed: 'tSmManaged'
    };

    const ImgProto = W.HTMLImageElement && W.HTMLImageElement.prototype;
    const SourceProto = W.HTMLSourceElement && W.HTMLSourceElement.prototype;
    const MediaProto = W.HTMLMediaElement && W.HTMLMediaElement.prototype;
    const VideoProto = W.HTMLVideoElement && W.HTMLVideoElement.prototype;
    const ElProto = W.Element && W.Element.prototype;
    const URLCtor = W.URL || URL;
    const RequestCtor = W.Request;
    const ResponseCtor = W.Response || Response;
    const BlobCtor = W.Blob || Blob;
    const XHRCtor = W.XMLHttpRequest;
    const IOCtor = W.IntersectionObserver || IntersectionObserver;
    const MOCtor = W.MutationObserver || MutationObserver;

    // ==========================================
    // 1. 設定
    // ==========================================
    const CONFIG = {
        /** Meta 媒體 CDN hostname（含子網域）；另會認 hostname 含 scontent */
        mediaHosts: [
            'cdninstagram.com',
            'fbcdn.net',
            'facebook.com',
            'instagram.com'
        ],
        /** CDN 路徑 sWxH 細於此值當 icon 放行 */
        smallMediaMaxPx: 150,
        /** false → dialog / lightbox 內媒體自動放行 */
        blockDialogMedia: false,
        /** 解鎖後吞 gallery 後續事件最長時間（ms） */
        swallowTimeoutMs: 500,
        /** 解鎖影片後短暫擋 pause（ms） */
        pauseBlockMs: 400,
        /** 連續解鎖防抖（ms）— 減少 iOS 雙擊／殘影連觸 */
        unlockDebounceMs: 120,
        /** tap vs 捲動：位移超過呢個 px 就當捲動，唔解鎖 */
        unlockSlopPx: 12,
        /** localStorage `threads_stopMediaLoader_debug=1` 亦可開 */
        debug: false
    };

    try {
        const ls = (W.localStorage || window.localStorage);
        if (ls && ls.getItem('threads_stopMediaLoader_debug') === '1') {
            CONFIG.debug = true;
        }
    } catch (_) { /* private mode */ }

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
            `%c[Threads StopMedia ${VERSION} ${PLATFORM}]`,
            'color:#8ab4f8;font-weight:bold;',
            ...args
        );
    }

    // ==========================================
    // 2. URL / hostname 工具
    // ==========================================
    function isInstanceOf(value, sandboxCtor, pageCtor) {
        if (value == null) return false;
        try {
            if (sandboxCtor && value instanceof sandboxCtor) return true;
        } catch (_) { /* ignore */ }
        try {
            if (pageCtor && pageCtor !== sandboxCtor && value instanceof pageCtor) return true;
        } catch (_) { /* ignore */ }
        return false;
    }

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

    function parseUrl(value) {
        if (value == null) return null;
        let candidate = value;
        if (isInstanceOf(value, typeof Request !== 'undefined' ? Request : null, RequestCtor)) {
            candidate = value.url;
        } else if (isInstanceOf(value, typeof URL !== 'undefined' ? URL : null, URLCtor)) {
            candidate = value.href;
        } else if (typeof value === 'object' && typeof value.url === 'string') {
            candidate = value.url;
        }
        try {
            return new URLCtor(String(candidate), (W.location || location).href);
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
        if (h.includes('scontent')) return true;
        return CONFIG.mediaHosts.some((d) => hostMatches(h, d));
    }

    function looksLikeMediaPath(urlObj) {
        if (!urlObj) return false;
        const path = (urlObj.pathname || '') + (urlObj.search || '');
        if (/favicon/i.test(path)) return false;
        if (/\.(?:jpe?g|png|gif|webp|avif|heic|heif|bmp|mp4|m4v|mov|webm|mkv)(?:$|[?#])/i.test(path)) {
            return true;
        }
        if (/\/(?:v\/t\d+|o1\/v\/t\d+|t\d+\.\d+-\d+)\//i.test(urlObj.pathname || '')) {
            return true;
        }
        if (/[?&](?:stp|oh|oe|_nc_)/i.test(urlObj.search || '')) {
            return true;
        }
        return false;
    }

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

    function isLoadAllTarget(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.id === LOAD_ALL_ID) return true;
        return !!(el.closest && el.closest('#' + LOAD_ALL_ID));
    }

    // ==========================================
    // 3. CSS（touch 優先；hover 只喺真滑鼠）
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
            -webkit-tap-highlight-color: transparent !important;
            -webkit-touch-callout: none !important;
            touch-action: manipulation !important;
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
            -webkit-tap-highlight-color: transparent !important;
            -webkit-touch-callout: none !important;
            touch-action: manipulation !important;
        }
        video[data-t-sm-state="locked"]:active,
        img[data-t-sm-state="locked"]:active {
            background-color: #2a2a2a !important;
        }
        @media (hover: hover) and (pointer: fine) {
            video[data-t-sm-state="locked"]:hover,
            img[data-t-sm-state="locked"]:hover {
                background-color: #2a2a2a !important;
            }
            video[data-t-sm-state="locked"]:hover { background-size: 56px !important; }
            img[data-t-sm-state="locked"]:hover { background-size: 40px !important; }
        }
        video[data-t-sm-state="locked"]:focus-visible,
        img[data-t-sm-state="locked"]:focus-visible {
            background-color: #2a2a2a !important;
            outline: 2px solid #8ab4f8 !important;
            outline-offset: 2px !important;
        }
        [role="dialog"] video[data-t-sm-state="locked"],
        [role="dialog"] img[data-t-sm-state="locked"] {
            filter: none !important;
            background: none !important;
            content: none !important;
            cursor: default !important;
            min-height: 0 !important;
        }
        #${LOAD_ALL_ID} {
            position: fixed;
            z-index: 2147483646;
            right: max(12px, env(safe-area-inset-right, 0px));
            bottom: max(12px, env(safe-area-inset-bottom, 0px));
            padding: 12px 16px;
            border-radius: 22px;
            border: 1px solid rgba(255,255,255,0.2);
            background: rgba(26,26,26,0.92);
            color: #f5f5f5;
            font: 600 14px/1.3 system-ui, -apple-system, sans-serif;
            cursor: pointer;
            box-shadow: 0 4px 16px rgba(0,0,0,0.35);
            -webkit-backdrop-filter: blur(8px);
            backdrop-filter: blur(8px);
            -webkit-tap-highlight-color: transparent;
            touch-action: manipulation;
        }
        #${LOAD_ALL_ID}:active {
            background: rgba(42,42,42,0.96);
        }
        #${LOAD_ALL_ID}:focus-visible {
            outline: 2px solid #8ab4f8;
            outline-offset: 2px;
        }
        #${LOAD_ALL_ID}[hidden] {
            display: none !important;
        }
    `;

    function injectStyle() {
        if (doc.getElementById(STYLE_ID)) return;
        const style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = cssRule;
        (doc.head || doc.documentElement || doc).appendChild(style);
    }

    if (doc.head || doc.documentElement) injectStyle();
    else doc.addEventListener('DOMContentLoaded', injectStyle, { once: true });

    // ==========================================
    // 4. 可串接 hook
    // ==========================================
    function wrapSetter(proto, prop, makeSetter, makeGetter) {
        if (!proto) return false;
        let desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc || !desc.set) {
            let curr = Object.getPrototypeOf(proto);
            while (curr && (!desc || !desc.set)) {
                desc = Object.getOwnPropertyDescriptor(curr, prop);
                curr = Object.getPrototypeOf(curr);
            }
        }
        if (!desc || typeof desc.set !== 'function') {
            log('skip wrap', prop, 'no setter');
            return false;
        }
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

    const pending = new Set();
    let scheduled = false;
    const raf = (W.requestAnimationFrame || requestAnimationFrame).bind(W);

    function queueElement(el) {
        if (!el || el.nodeType !== 1) return;
        pending.add(el);
        scheduleFlush();
    }

    function scheduleFlush() {
        if (scheduled) return;
        scheduled = true;
        raf(flush);
    }

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
    // 5. 網絡層：fetch + XHR
    // ==========================================
    function emptyMediaResponse() {
        return new ResponseCtor(new BlobCtor([]), {
            status: 204,
            statusText: 'No Content',
            headers: { 'Cache-Control': 'no-store' }
        });
    }

    wrapMethod(W, 'fetch', (nativeFetch) => function (...args) {
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
        if (!XHRCtor || !XHRCtor.prototype) return;
        const xhrProto = XHRCtor.prototype;
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

    W.addEventListener('error', (e) => {
        const t = e.target;
        if (!t || !t.tagName) return;
        if ((t.tagName === 'IMG' || t.tagName === 'VIDEO' || t.tagName === 'SOURCE') && isLocked(t)) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }
    }, true);

    // ==========================================
    // 6. Preload 中和（唔 patch appendChild）
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
            try { if (link.href) link.href = ''; } catch (_) { /* ignore */ }
            stats.preloadDropped++;
            log('drop preload link');
            return true;
        } catch (err) {
            log('neutralizePreload error', err);
            return false;
        }
    }

    // ==========================================
    // 7. Gate media sources
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
            const vid = source.closest && source.closest('video');
            if (vid && !isUnlocked(vid) && getState(vid) !== STATE_IGNORED) {
                setState(vid, STATE_LOCKED);
                markProcessed(vid, false);
                queueElement(vid);
            }
        } catch (_) { /* ignore */ }
        if (prop === 'srcset' && prevSet) return prevSet.call(source, '');
        if (prop === 'src') return;
        return prevSet ? prevSet.call(source, value) : undefined;
    }

    function gateVideoSrc(video, value, prevSet) {
        if (isUnlocking(video) || isUnlocked(video) || getState(video) === STATE_IGNORED) {
            return prevSet.call(video, value);
        }
        if (isDataUrl(value) || isPlaceholder(value)) {
            return prevSet.call(video, value);
        }
        if (isBlobUrl(value) && !isUnlocked(video)) {
            storeMediaUrl(video, DS.src, value);
            setState(video, STATE_LOCKED);
            markProcessed(video, false);
            queueElement(video);
            return;
        }
        storeMediaUrl(video, DS.src, value);
        setState(video, STATE_LOCKED);
        markProcessed(video, false);
        queueElement(video);
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

    function gateSrcObject(media, value, prevSet) {
        if (isUnlocking(media) || isUnlocked(media) || getState(media) === STATE_IGNORED) {
            return prevSet.call(media, value);
        }
        if (media.tagName !== 'VIDEO' && media.tagName !== 'AUDIO') {
            return prevSet.call(media, value);
        }
        media._tSmSrcObject = value;
        setState(media, STATE_LOCKED);
        markProcessed(media, false);
        queueElement(media);
        return;
    }

    wrapSetter(
        ImgProto,
        'src',
        (prevSet) => function (val) {
            try { return gateImageSrc(this, val, prevSet); }
            catch (err) { log('img.src error', err); return prevSet.call(this, val); }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.src] && isLocked(this)) {
                return this.dataset[DS.src];
            }
            return prevGet ? prevGet.call(this) : '';
        }
    );

    wrapSetter(
        ImgProto,
        'srcset',
        (prevSet) => function (val) {
            try { return gateImageSrcset(this, val, prevSet); }
            catch (err) { log('img.srcset error', err); return prevSet.call(this, val); }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.srcset] && isLocked(this)) {
                return this.dataset[DS.srcset];
            }
            return prevGet ? prevGet.call(this) : '';
        }
    );

    wrapSetter(
        SourceProto,
        'src',
        (prevSet) => function (val) {
            try { return gateSourceAttr(this, 'src', val, prevSet); }
            catch (err) { log('source.src error', err); return prevSet.call(this, val); }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.src]) {
                return this.dataset[DS.src];
            }
            return prevGet ? prevGet.call(this) : '';
        }
    );

    wrapSetter(
        SourceProto,
        'srcset',
        (prevSet) => function (val) {
            try { return gateSourceAttr(this, 'srcset', val, prevSet); }
            catch (err) { log('source.srcset error', err); return prevSet.call(this, val); }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.srcset]) {
                return this.dataset[DS.srcset];
            }
            return prevGet ? prevGet.call(this) : '';
        }
    );

    wrapSetter(
        MediaProto,
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
        MediaProto,
        'srcObject',
        (prevSet) => function (val) {
            try {
                if (this.tagName === 'VIDEO' || this.tagName === 'AUDIO') {
                    return gateSrcObject(this, val, prevSet);
                }
                return prevSet.call(this, val);
            } catch (err) {
                log('media.srcObject error', err);
                return prevSet.call(this, val);
            }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this._tSmSrcObject != null && isLocked(this)) {
                return this._tSmSrcObject;
            }
            return prevGet ? prevGet.call(this) : null;
        }
    );

    wrapSetter(
        MediaProto,
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
        MediaProto,
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
        VideoProto,
        'poster',
        (prevSet) => function (val) {
            try { return gateVideoPoster(this, val, prevSet); }
            catch (err) { log('video.poster error', err); return prevSet.call(this, val); }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.poster] && isLocked(this)) {
                return this.dataset[DS.poster];
            }
            return prevGet ? prevGet.call(this) : '';
        }
    );

    (function patchSetAttribute() {
        if (!ElProto || typeof ElProto.setAttribute !== 'function') return;
        const prev = ElProto.setAttribute;
        ElProto.setAttribute = function (name, value) {
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
                        const vid = this.closest('video');
                        if (vid && !isUnlocked(vid) && getState(vid) !== STATE_IGNORED) {
                            setState(vid, STATE_LOCKED);
                            markProcessed(vid, false);
                            queueElement(vid);
                        }
                    } catch (_) { /* ignore */ }
                    if (attr === 'srcset') return prev.call(this, name, '');
                    return;
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
                        return;
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

    const originalPlay = VideoProto && VideoProto.play;
    wrapMethod(VideoProto, 'play', (nativePlay) => function (...args) {
        if (isUnlocked(this) || getState(this) === STATE_IGNORED) {
            return nativePlay.apply(this, args);
        }
        if (!CONFIG.blockDialogMedia && inDialog(this)) {
            return nativePlay.apply(this, args);
        }
        setState(this, STATE_LOCKED);
        return Promise.reject(new DOMException('Autoplay blocked by Threads Stop Media (iOS)', 'NotAllowedError'));
    });

    // ==========================================
    // 8. IntersectionObserver
    // ==========================================
    const visibleLocked = new Set();

    const io = new IOCtor((entries) => {
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
        try { io.observe(el); } catch (_) { /* ignore */ }
    }

    function unobserve(el) {
        if (!el) return;
        visibleLocked.delete(el);
        try { io.unobserve(el); } catch (_) { /* ignore */ }
    }

    function pruneVisible() {
        for (const el of Array.from(visibleLocked)) {
            if (!el.isConnected || !isLocked(el)) visibleLocked.delete(el);
        }
    }

    // ==========================================
    // 9. 分類
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
            kind === 'video' ? '載入影片（點擊）' : '載入圖片（點擊）'
        );
    }

    function stripA11y(el) {
        if (!el) return;
        delete el.dataset[DS.unlockable];
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
    }

    function ensurePlaysInline(video) {
        try {
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            video.playsInline = true;
        } catch (_) { /* ignore */ }
    }

    function forceStripImageNetwork(img) {
        const attrSrc = img.getAttribute('src');
        const attrSrcset = img.getAttribute('srcset');
        if (attrSrc && !isPlaceholder(attrSrc) && !isDataUrl(attrSrc)) {
            storeMediaUrl(img, DS.src, attrSrc);
        }
        if (attrSrcset && attrSrcset.trim()) {
            storeMediaUrl(img, DS.srcset, attrSrcset);
        }
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

    /**
     * iOS WebKit：清 src / source / poster / srcObject 後 video.load()，
     * 洗走已預載嘅第一幀殘影，先見到 CSS 佔位。
     */
    function forceStripVideoNetwork(video) {
        const attrSrc = video.getAttribute('src');
        const attrPoster = video.getAttribute('poster');
        if (attrSrc && !isPlaceholder(attrSrc) && !isDataUrl(attrSrc)) {
            storeMediaUrl(video, DS.src, attrSrc);
        }
        if (attrPoster && !isPlaceholder(attrPoster) && !isDataUrl(attrPoster)) {
            storeMediaUrl(video, DS.poster, attrPoster);
        }

        let needsFlush = false;
        ensurePlaysInline(video);

        withUnlocking(video, () => {
            try {
                video.removeAttribute('autoplay');
                try { video.autoplay = false; } catch (_) { /* ignore */ }
                try { video.preload = 'none'; } catch (_) { /* ignore */ }

                if (video.getAttribute('src')) {
                    video.removeAttribute('src');
                    needsFlush = true;
                }
                if (attrPoster && !isPlaceholder(attrPoster)) {
                    video.setAttribute('poster', PLACEHOLDER);
                }

                const sources = video.querySelectorAll('source');
                for (let i = 0; i < sources.length; i++) {
                    const s = sources[i];
                    const ss = s.getAttribute('src');
                    const sset = s.getAttribute('srcset');
                    if (ss) storeMediaUrl(s, DS.src, ss);
                    if (sset) storeMediaUrl(s, DS.srcset, sset);
                    s._tSmUnlocking = true;
                    try {
                        if (ss) {
                            s.removeAttribute('src');
                            needsFlush = true;
                        }
                        if (sset) s.removeAttribute('srcset');
                    } finally {
                        s._tSmUnlocking = false;
                    }
                }

                if (video.srcObject && !isUnlocked(video)) {
                    try {
                        if (video._tSmSrcObject == null) video._tSmSrcObject = video.srcObject;
                        video.srcObject = null;
                        needsFlush = true;
                    } catch (_) { /* ignore */ }
                }

                try { video.pause(); } catch (_) { /* ignore */ }

                if (needsFlush || (typeof video.readyState === 'number' && video.readyState > 0)) {
                    try { video.load(); } catch (_) { /* ignore */ }
                }
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
            forceStripImageNetwork(img);
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
        ensurePlaysInline(video);

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
                if (video._tSmSrcObject != null) {
                    try { video.srcObject = video._tSmSrcObject; } catch (_) { /* ignore */ }
                }
                if (video.dataset[DS.poster]) video.poster = video.dataset[DS.poster];
                if (video.dataset[DS.src] || video._tSmSrcObject != null || video.querySelector('source')) {
                    try { video.load(); } catch (_) { /* ignore */ }
                }
            } catch (err) {
                log('unlockVideo error', err);
            }
        });

        video._tSmBlockPause = true;
        if (!video._tSmPauseWrapped) {
            video._tSmPauseWrapped = true;
            const nativePause = MediaProto && MediaProto.pause
                ? MediaProto.pause
                : video.pause.bind(video);
            video.pause = function (...args) {
                if (this._tSmBlockPause) return;
                return nativePause.apply(this, args);
            };
        }

        if (typeof originalPlay === 'function') {
            try {
                const p = originalPlay.call(video);
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (_) { /* autoplay policy */ }
        }

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
    // 11. 「載入可見媒體」浮動掣（safe-area）
    // ==========================================
    let loadAllBtn = null;

    function ensureLoadAllButton() {
        if (loadAllBtn || !doc.documentElement) return;
        loadAllBtn = doc.createElement('button');
        loadAllBtn.type = 'button';
        loadAllBtn.id = LOAD_ALL_ID;
        loadAllBtn.hidden = true;
        loadAllBtn.setAttribute('aria-label', '載入目前可見嘅圖片同影片');
        loadAllBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            unlockAllVisible();
        });
        (doc.body || doc.documentElement).appendChild(loadAllBtn);
    }

    function refreshLoadAllButton() {
        pruneVisible();
        if (!loadAllBtn) {
            if (doc.body || doc.documentElement) ensureLoadAllButton();
        }
        if (!loadAllBtn) return;
        const n = visibleLocked.size;
        if (n === 0) {
            loadAllBtn.hidden = true;
            return;
        }
        loadAllBtn.hidden = false;
        loadAllBtn.textContent = `📥 載入可見（${n}）`;
    }

    // ==========================================
    // 12. 交互：iOS 捲動安全 tap
    // ==========================================
    let isSwallowing = false;
    let swallowTimer = null;
    let lastUnlockAt = 0;
    let gesture = null;

    function clearSwallow() {
        isSwallowing = false;
        if (swallowTimer != null) {
            clearTimeout(swallowTimer);
            swallowTimer = null;
        }
    }

    function beginSwallow() {
        isSwallowing = true;
        lastUnlockAt = Date.now();
        if (swallowTimer != null) clearTimeout(swallowTimer);
        swallowTimer = setTimeout(clearSwallow, CONFIG.swallowTimeoutMs);
    }

    function eventPoint(e) {
        if (e.touches && e.touches[0]) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        if (e.changedTouches && e.changedTouches[0]) {
            return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        }
        if (typeof e.clientX === 'number' && typeof e.clientY === 'number') {
            return { x: e.clientX, y: e.clientY };
        }
        return null;
    }

    function findLockedFromPoint(x, y) {
        let stack;
        try {
            stack = doc.elementsFromPoint(x, y);
        } catch (_) {
            stack = [];
        }
        for (let i = 0; i < stack.length; i++) {
            let el = stack[i];
            if (isLoadAllTarget(el)) return null;
            while (el && el !== doc.documentElement) {
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
        for (const el of visibleLocked) {
            if (!el.isConnected || !isLocked(el)) continue;
            const r = el.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                return el;
            }
        }
        return null;
    }

    function movedBeyondSlop(x, y, origin) {
        const slop = CONFIG.unlockSlopPx;
        const dx = x - origin.x;
        const dy = y - origin.y;
        return (dx * dx + dy * dy) > (slop * slop);
    }

    function commitUnlock(el, e) {
        if (!el || !el.isConnected || !isLocked(el)) return false;
        if (Date.now() - lastUnlockAt < CONFIG.unlockDebounceMs) {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
            return true;
        }
        unlockElement(el);
        beginSwallow();
        if (e) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }
        return true;
    }

    function onPrimaryDown(e) {
        if (!e.isTrusted) return;
        if (e.isPrimary === false) return;
        if (typeof e.button === 'number' && e.button !== 0) return;
        if (isLoadAllTarget(e.target)) {
            gesture = null;
            return;
        }

        if (isSwallowing) clearSwallow();

        const pt = eventPoint(e);
        if (!pt) {
            gesture = null;
            return;
        }

        const hit = findLockedFromPoint(pt.x, pt.y);
        if (!hit) {
            gesture = null;
            return;
        }

        gesture = {
            el: hit,
            x: pt.x,
            y: pt.y,
            id: e.pointerId,
            moved: false
        };
    }

    function onPrimaryMove(e) {
        if (!gesture || gesture.moved) return;
        if (e.pointerId != null && gesture.id != null && e.pointerId !== gesture.id) return;
        const pt = eventPoint(e);
        if (!pt) return;
        if (movedBeyondSlop(pt.x, pt.y, gesture)) {
            gesture.moved = true;
            gesture = null;
        }
    }

    function onPrimaryUp(e) {
        if (!e.isTrusted) return;
        if (!gesture || gesture.moved) {
            gesture = null;
            return;
        }
        if (e.pointerId != null && gesture.id != null && e.pointerId !== gesture.id) {
            return;
        }
        const el = gesture.el;
        gesture = null;
        commitUnlock(el, e);
    }

    function onPrimaryCancel() {
        gesture = null;
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

    function onClickCapture(e) {
        if (!e.isTrusted) return;
        if (isLoadAllTarget(e.target)) return;
        if (isSwallowing) {
            onSwallowable(e);
            return;
        }
        const t = e.target;
        let locked = null;
        if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO') && isLocked(t)) {
            locked = t;
        } else {
            const pt = eventPoint(e);
            if (pt) locked = findLockedFromPoint(pt.x, pt.y);
        }
        if (!locked) return;
        commitUnlock(locked, e);
    }

    function onKeyActivate(e) {
        if (!e.isTrusted) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const t = e.target;
        if (!t || (t.tagName !== 'IMG' && t.tagName !== 'VIDEO')) return;
        if (!isLocked(t)) return;
        e.preventDefault();
        e.stopPropagation();
        commitUnlock(t, e);
    }

    const hasPointer = typeof W.PointerEvent === 'function' || typeof window.PointerEvent === 'function';
    const capturePassive = { capture: true, passive: true };
    const captureNonPassive = { capture: true, passive: false };

    if (hasPointer) {
        W.addEventListener('pointerdown', onPrimaryDown, capturePassive);
        W.addEventListener('pointermove', onPrimaryMove, capturePassive);
        W.addEventListener('pointerup', onPrimaryUp, captureNonPassive);
        W.addEventListener('pointercancel', onPrimaryCancel, capturePassive);
        ['click', 'dblclick', 'auxclick'].forEach((evt) => {
            W.addEventListener(evt, onSwallowable, captureNonPassive);
        });
    } else {
        W.addEventListener('touchstart', onPrimaryDown, capturePassive);
        W.addEventListener('touchend', onPrimaryUp, captureNonPassive);
        W.addEventListener('touchcancel', onPrimaryCancel, capturePassive);
        ['click', 'dblclick'].forEach((evt) => {
            W.addEventListener(evt, onSwallowable, captureNonPassive);
        });
    }
    W.addEventListener('click', onClickCapture, captureNonPassive);
    W.addEventListener('keydown', onKeyActivate, { capture: true });

    // ==========================================
    // 13. MutationObserver（只 childList；src 靠 setter）
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
            doc.querySelectorAll('img, video, link[rel="preload"]').forEach((el) => pending.add(el));
            scheduleFlush();
        } catch (err) {
            log('scanAll error', err);
        }
    }

    const observer = new MOCtor((mutations) => {
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
        try {
            observer.observe(doc, { childList: true, subtree: true });
        } catch (err) {
            try {
                const root = doc.documentElement || doc;
                observer.observe(root, { childList: true, subtree: true });
            } catch (err2) {
                log('observe failed', err2 || err);
            }
        }
        injectStyle();
        ensureLoadAllButton();
        scanAll();
    }

    if (doc.documentElement || doc.nodeType === 9) startObserver();
    else doc.addEventListener('DOMContentLoaded', startObserver, { once: true });

    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', () => {
            injectStyle();
            ensureLoadAllButton();
            scanAll();
        }, { once: true });
    } else {
        ensureLoadAllButton();
        scanAll();
    }

    W.addEventListener('pageshow', () => {
        injectStyle();
        ensureLoadAllButton();
        scanAll();
    });

    try {
        Object.defineProperty(W, 'ThreadsStopMedia', {
            configurable: true,
            enumerable: false,
            get() {
                return {
                    version: VERSION,
                    platform: PLATFORM,
                    config: { ...CONFIG },
                    stats: { ...stats },
                    visibleLocked: visibleLocked.size,
                    hasPointerEvents: hasPointer,
                    pageWindow: W !== window
                };
            }
        });
    } catch (_) { /* ignore */ }

    log('initialized', {
        platform: PLATFORM,
        hasPointer,
        pageWindow: W !== window,
        mediaHosts: CONFIG.mediaHosts,
        blockDialogMedia: CONFIG.blockDialogMedia
    });
})();
