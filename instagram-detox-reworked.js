// ==UserScript==
// @name         Instagram 手動載入 Post 媒體 (Desktop v1.1.15)
// @namespace    https://github.com/mark1688288/digital-detox
// @version      1.1.15
// @description  開 Instagram 唔自動載 post 圖／片；撳先 fetch 並顯示喺頁面。
// @author       mark1688288
// @homepageURL  https://github.com/mark1688288/digital-detox
// @downloadURL  https://raw.githubusercontent.com/mark1688288/digital-detox/main/instagram-detox-reworked.js
// @updateURL    https://raw.githubusercontent.com/mark1688288/digital-detox/main/instagram-detox-reworked.js
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @match        https://*.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @license      MIT
// ==/UserScript==

/**
 * Instagram（對照 .sourcehtml/instagram_pagesource.html）
 * ------------------------------------------------
 * Feed：PolarisFeedTimelineRootV2Query → xdt_api__v1__feed__timeline__connection.edges[].node.media
 * Post 媒體欄位：
 *   - media_type 1 feed 相：image_versions2.candidates
 *     最大張係原比例 e35（例 1448x1931，stp=dst-jpg_e35_tt6，path /v/t51.*-15/）
 *     其餘 p1080 / s640 / c0.xxx 裁切正方形係縮圖，唔攞
 *   - media_type 2 clips／ad 片：video_versions[].url 係 muxed .mp4（path /o1/v/t2/f2/...）
 *     type 101/102/103 可以係同一條 URL；DASH video_dash_manifest 更高解像但片同聲分開，唔用
 *   - media_type 8 carousel：carousel_media[] 每粒自己有 image_versions2 / video_versions
 *     DOM 多數只留 prev/current/next 三格 li，唔可以用 li 序去對 GraphQL files[]
 * DOM：
 *   - 相：<article> → div._aagu → div._aagv（padding-bottom 撐比例）→ <img object-fit:cover>
 *   - Reels：SSR 冇 <video>，播放器 JS 先插入；用 /p/{code}/ 或 /reels/{code}/ 對 GraphQL
 *   - 頭像：alt「{user}'s profile picture」、CDN /v/t51.*-19/、stp=s150x150 → 唔擋
 * 行為：網絡擋內容圖（204）、影片 hang fetch（DASH 唔好 204）。撳 placeholder／載入掣
 * 先放行：圖寫 GraphQL 原圖；片只解鎖 IG 播放器（唔好用 mp4 覆蓋仍然活住嘅 MediaSource）。
 * carousel 尾段虛擬化 + 連住兩格片：唔好用 li 序對 files，DASH hang 要 flush，空 video 唔好遮封面。
 * 鎖定片唔好 attach blob（MSE 會狂 fetch）；queue full 唔好 AbortError（會再試洗 log）。
 * Reels 列表都係 ul>li，只有 li 有 translateX 先當相簿 carousel。
 * Oz FetchWithTimeout 會 abort hang 住嘅 signal——flush 時要換新 signal，唔好一次 dump 成個 feed
 * 再 arrayBuffer cache（會卡死頁）。MediaSource 已 closed 先 fallback 漸進 mp4。唔另存 Downloads。
 * 同 instagram-detox.js 一齊開會雙重攔截，請停其中一個。
 */

(function (root) {
    'use strict';

    const VERSION = '1.1.15';
    const STYLE_ID = 'instagram-post-download-style';
    const MEDIA_HINT = /image_versions2|video_versions/;
    const FB_FOR_PREFIX = 'for (;;);';
    const DEFAULT_CONFIG = {
        /** localStorage key `instagram_postDownload_debug` = "1" 亦可開啟 */
        debug: false,
        /** 單個 GraphQL／JSON 最大解析長度 */
        maxInspectBytes: 16 * 1024 * 1024,
        /** walk 上限，避免 Bootloader payload 拖慢 */
        maxWalkNodes: 25000,
        skipAds: false
    };
    const URL_BASE = 'https://www.instagram.com/';

    /**
     * Harvest / URL 邏輯（Node `require` 同 Tampermonkey 共用）。
     * 瀏覽器安裝喺 factory 之後；Node 只 export 呢個 factory。
     */
    function createHarvest(options) {
        const opts = options || {};
        const CONFIG = Object.assign({}, DEFAULT_CONFIG, {
            debug: !!opts.debug,
            skipAds: !!opts.skipAds
        });
        if (opts.maxInspectBytes != null) CONFIG.maxInspectBytes = opts.maxInspectBytes;
        if (opts.maxWalkNodes != null) CONFIG.maxWalkNodes = opts.maxWalkNodes;
        const onHarvest = opts.onHarvest;
        const stats = {
            harvested: 0,
            inspectedJson: 0
        };
        /** @type {Map<string, object>} code / pk → post */
        const postsByKey = new Map();

        function log(...args) {
            if (!CONFIG.debug) return;
            console.debug(
                `%c[Instagram PostDownload ${VERSION}]`,
                'color:#0095f6;font-weight:bold;',
                ...args
            );
        }

        // ==========================================
        // URL / shortcode
        // ==========================================
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
            const base = (typeof location !== 'undefined' && location.href) ? location.href : URL_BASE;
            try {
                return new URL(String(candidate), base);
            } catch (_) {
                return null;
            }
        }

    function parsePostPath(pathname) {
        const path = String(pathname || '');
        if (/\/(?:p|reel|reels)\/audio(?:\/|$)/i.test(path)) return null;
        const m = path.match(/\/(p|reel|reels)\/([A-Za-z0-9_-]+)(?:\/|$)/);
        if (!m) return null;
        if (m[2] === 'audio') return null;
        return { kind: m[1], code: m[2] };
    }

    function parsePostHref(href) {
        const urlObj = parseUrl(href);
        if (!urlObj) return null;
        return parsePostPath(urlObj.pathname);
    }

    function currentRouteCode() {
            try {
                const path = (typeof location !== 'undefined' && location.pathname) || '';
                return parsePostPath(path);
            } catch (_) {
                return null;
            }
        }

    function isInspectUrl(urlObj) {
        if (!urlObj) return false;
        const h = String(urlObj.hostname || '').toLowerCase();
        if (!h) return false;
        if (h.includes('scontent') || h === 'static.cdninstagram.com') return false;
        if (/\.(?:jpe?g|png|gif|webp|mp4|m4v|m3u8|mpd)(?:$|[?#])/i.test(urlObj.pathname)) return false;
        return (
            h === 'instagram.com' ||
            h.endsWith('.instagram.com') ||
            h === 'facebook.com' ||
            h.endsWith('.facebook.com')
        );
    }

    function pkFromIgCacheKey(url) {
        const m = String(url || '').match(/ig_cache_key=([^&]+)/i);
        if (!m) return '';
        try {
            const raw = decodeURIComponent(m[1]).split('.')[0];
            const decoded = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
            return decoded && /^\d+$/.test(decoded) ? decoded : '';
        } catch (_) {
            return '';
        }
    }

    function safePart(s, fallback) {
        const t = String(s || '')
            .replace(/[^\w.\-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 80);
        return t || fallback || 'unknown';
    }

    function datePrefix(ts) {
        const n = Number(ts);
        if (!n) return '';
        const d = new Date(n * 1000);
        if (Number.isNaN(d.getTime())) return '';
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return y + m + day + '_';
    }

    function extFromUrl(url, fallback) {
        const path = String(url || '').split('?')[0];
        const m = path.match(/\.(jpe?g|png|gif|webp|mp4|m4v|mov|webm)(?:$)/i);
        if (!m) return fallback;
        const e = m[1].toLowerCase();
        if (e === 'jpeg') return 'jpg';
        return e;
    }

    function isCroppedStp(url) {
        return /[?&]stp=c[\d.]+/i.test(url || '') || /stp=[^&]*c[\d.]+a_/i.test(url || '');
    }

    function isTinyStp(url) {
        const m = String(url || '').match(/s(\d+)x(\d+)/i);
        if (!m) return false;
        return parseInt(m[1], 10) <= 150 && parseInt(m[2], 10) <= 150;
    }

    /** IG 片封面（e15 / video_default_cover_frame），唔係普通相 */
    function isVideoCoverUrl(url) {
        const u = String(url || '');
        if (!u) return false;
        if (/[?&]stp=[^&]*e15/i.test(u)) return true;
        if (/video_default_cover_frame/i.test(u)) return true;
        return false;
    }

    // ==========================================
    // Harvest GraphQL media
    // ==========================================
    function usernameOf(media) {
        const u = media && media.user;
        if (u && typeof u === 'object') {
            return u.username || u.unique_id || '';
        }
        if (media && media.owner && typeof media.owner === 'object') {
            return media.owner.username || '';
        }
        return '';
    }

    function candidatesOf(media) {
        const iv = media && media.image_versions2;
        if (iv && Array.isArray(iv.candidates)) return iv.candidates;
        if (Array.isArray(media && media.display_resources)) return media.display_resources;
        return [];
    }

    function bestImage(candidates) {
        let best = null;
        let bestScore = -1;
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            const url = (c && (c.url || c.src)) || '';
            if (!url) continue;
            const w = Number(c.width || c.config_width) || 0;
            const h = Number(c.height || c.config_height) || 0;
            const area = w * h || 1;
            const cropped = isCroppedStp(url);
            const tiny = isTinyStp(url) || (w > 0 && w <= 150 && h <= 150);
            // 優先：未裁切、非細圖、面積大
            const score = (cropped ? 0 : 1e13) + (tiny ? 0 : 1e12) + area;
            if (score > bestScore) {
                bestScore = score;
                best = { url, width: w, height: h };
            }
        }
        return best;
    }

    function bestVideo(versions) {
        let best = null;
        let bestArea = -1;
        const list = Array.isArray(versions) ? versions : [];
        for (let i = 0; i < list.length; i++) {
            const v = list[i];
            const url = (v && v.url) || '';
            if (!url) continue;
            const w = Number(v.width) || 0;
            const h = Number(v.height) || 0;
            const area = w * h || 1;
            if (area > bestArea) {
                bestArea = area;
                best = { url, width: w, height: h, type: v.type };
            }
        }
        return best;
    }

    function carouselItems(media) {
        const c = media && media.carousel_media;
        if (Array.isArray(c) && c.length) return c;
        if (c && Array.isArray(c.edges) && c.edges.length) {
            const out = [];
            for (let i = 0; i < c.edges.length; i++) {
                const e = c.edges[i];
                const node = e && (e.node || e.media || e);
                if (node && typeof node === 'object') out.push(node);
            }
            if (out.length) return out;
        }
        return [media];
    }

    function isVideoItem(item) {
        if (!item) return false;
        if (item.media_type === 2) return true;
        if (Array.isArray(item.video_versions) && item.video_versions.length) return true;
        if (typeof item.video_url === 'string' && item.video_url) return true;
        return false;
    }

    function dashUrlsFromXml(xml) {
        const urls = [];
        if (typeof xml !== 'string' || xml.length < 20) return urls;
        const re = /<BaseURL>([^<]+)<\/BaseURL>/gi;
        let m;
        while ((m = re.exec(xml))) {
            const u = String(m[1] || '').replace(/&amp;/g, '&').trim();
            if (u) urls.push(u);
        }
        return uniqueUrls(urls);
    }

    function filesFromMedia(media) {
        if (!media || typeof media !== 'object') return [];
        const code = media.code || '';
        const user = usernameOf(media);
        const prefix = datePrefix(media.taken_at) + safePart(user, 'user') + '_' + safePart(code || media.pk, 'post');
        const items = carouselItems(media);
        const files = [];
        const multi = items.length > 1;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const slot = multi ? '_' + String(i + 1).padStart(2, '0') : '';
            if (isVideoItem(item)) {
                const vid = bestVideo(item.video_versions) ||
                    (item.video_url ? { url: item.video_url, width: 0, height: 0 } : null);
                if (vid && vid.url) {
                    files.push({
                        kind: 'video',
                        url: vid.url,
                        width: vid.width,
                        height: vid.height,
                        filename: prefix + slot + '.' + extFromUrl(vid.url, 'mp4'),
                        pk: item.pk != null ? String(item.pk) : '',
                        dashUrls: dashUrlsFromXml(item.video_dash_manifest)
                    });
                    continue;
                }
            }
            const img = bestImage(candidatesOf(item));
            if (img && img.url) {
                files.push({
                    kind: 'image',
                    url: img.url,
                    width: img.width,
                    height: img.height,
                    filename: prefix + slot + '.' + extFromUrl(img.url, 'jpg'),
                    pk: item.pk != null ? String(item.pk) : ''
                });
            }
        }
        return files;
    }

    function uniqueUrls(list) {
        const out = [];
        const seen = new Set();
        const src = Array.isArray(list) ? list : [];
        for (let i = 0; i < src.length; i++) {
            const u = src[i];
            if (!u || seen.has(u)) continue;
            seen.add(u);
            out.push(u);
        }
        return out;
    }

    /** Oz DASH BaseURL（同 video_versions muxed mp4 唔同 path） */
    function dashUrlsOf(media) {
        const urls = [];
        const items = carouselItems(media);
        for (let i = 0; i < items.length; i++) {
            const part = dashUrlsFromXml(items[i] && items[i].video_dash_manifest);
            for (let j = 0; j < part.length; j++) urls.push(part[j]);
        }
        return uniqueUrls(urls);
    }

    /**
     * 對 DOM 媒體去 GraphQL files。
     * carousel 虛擬化得 3 格 li，slideIdx 只喺 li 數 === files 數先可信。
     */
    function pickHarvestFile(rec, opts) {
        const files = rec && Array.isArray(rec.files) ? rec.files : [];
        if (!files.length) return null;
        const want = opts && opts.want;
        const itemPk = opts && opts.itemPk ? String(opts.itemPk) : '';
        const slideIdx = opts && opts.slideIdx;
        const slideCount = opts && opts.slideCount;
        if (itemPk) {
            for (let i = 0; i < files.length; i++) {
                const f = files[i];
                if (f && f.pk === itemPk && (!want || f.kind === want)) return f;
            }
        }
        if (
            slideIdx != null &&
            slideIdx >= 0 &&
            slideCount > 0 &&
            files.length === slideCount &&
            files[slideIdx] &&
            (!want || files[slideIdx].kind === want)
        ) {
            return files[slideIdx];
        }
        const kindFiles = want ? files.filter((f) => f && f.kind === want) : files;
        if (kindFiles.length === 1) return kindFiles[0];
        return null;
    }

    function filesScore(files) {
        const list = Array.isArray(files) ? files : [];
        let score = list.length;
        for (let i = 0; i < list.length; i++) {
            const f = list[i];
            const area = (Number(f.width) || 0) * (Number(f.height) || 0);
            score += (f.kind === 'video' ? 1e12 : 1e11) + area;
        }
        return score;
    }

    function looksLikeMediaNode(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
        const hasImg = obj.image_versions2 && (
            Array.isArray(obj.image_versions2.candidates) ||
            Array.isArray(obj.image_versions2)
        );
        const hasVid = Array.isArray(obj.video_versions) && obj.video_versions.length > 0;
        if (!hasImg && !hasVid && obj.media_type !== 1 && obj.media_type !== 2 && obj.media_type !== 8) {
            return false;
        }
        if (!obj.code && obj.pk == null && obj.id == null) return false;
        // 頭像／系統物件通常冇 code，而且 candidate 只有 s150
        if (!obj.code && !hasVid && obj.media_type == null) return false;
        return true;
    }

    function rememberPost(media) {
        if (!looksLikeMediaNode(media)) return false;
        if (CONFIG.skipAds && media.product_type === 'ad') return false;
        const files = filesFromMedia(media);
        if (!files.length) return false;

        const code = media.code ? String(media.code) : '';
        const pk = media.pk != null ? String(media.pk) : '';
        const id = media.id != null ? String(media.id) : '';
        const dashUrls = dashUrlsOf(media);
        const rec = {
            code,
            pk,
            id,
            mediaType: media.media_type,
            productType: media.product_type || '',
            username: usernameOf(media),
            takenAt: media.taken_at || 0,
            files,
            dashUrls
        };

        const prev = (code && postsByKey.get(code)) || (pk && postsByKey.get(pk));
        if (prev && prev.dashUrls && prev.dashUrls.length) {
            rec.dashUrls = uniqueUrls(prev.dashUrls.concat(dashUrls));
        }
        // pagination 有時只送 0x0／縮圖；保留較完整嗰份（有片、有解像、檔數多）
        if (prev && filesScore(prev.files) >= filesScore(rec.files)) {
            if (dashUrls.length) {
                prev.dashUrls = uniqueUrls((prev.dashUrls || []).concat(dashUrls));
            }
            return false;
        }

        const isNew = !prev;
        if (code) postsByKey.set(code, rec);
        if (pk) postsByKey.set(pk, rec);
        if (id && id !== pk) postsByKey.set(id, rec);
        for (let i = 0; i < files.length; i++) {
            if (files[i].pk && files[i].pk !== pk) postsByKey.set(files[i].pk, rec);
        }
        if (isNew) stats.harvested++;
        log('harvest', rec.username, code || pk, rec.files.map((f) => f.kind + ' ' + f.width + 'x' + f.height));
        return true;
    }

    function walkHarvest(obj, budget) {
        if (budget.n > CONFIG.maxWalkNodes) return;
        if (!obj || typeof obj !== 'object') return;
        budget.n++;

        if (looksLikeMediaNode(obj)) rememberPost(obj);
        if (obj.media && typeof obj.media === 'object') rememberPost(obj.media);

        if (Array.isArray(obj)) {
            const n = Math.min(obj.length, 400);
            for (let i = 0; i < n; i++) walkHarvest(obj[i], budget);
            return;
        }
        for (const k in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
            const v = obj[k];
            if (v && typeof v === 'object') walkHarvest(v, budget);
            if (budget.n > CONFIG.maxWalkNodes) return;
        }
    }

        function harvest(data) {
            if (!data || typeof data !== 'object') return;
            walkHarvest(data, { n: 0 });
            if (typeof onHarvest === 'function') onHarvest();
        }

        function looksCompleteJson(text) {
            const s = String(text || '').trim();
            if (s.length < 2) return false;
            const a = s[0];
            const b = s[s.length - 1];
            return (a === '{' && b === '}') || (a === '[' && b === ']');
        }

        function inspectText(text) {
            if (!text || typeof text !== 'string') return false;
            if (text.length < 40 || text.length > CONFIG.maxInspectBytes) return false;
            if (!MEDIA_HINT.test(text)) return false;
            let s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
            if (s.startsWith(FB_FOR_PREFIX)) s = s.slice(FB_FOR_PREFIX.length);
            s = s.trim();
            if (s[0] !== '{' && s[0] !== '[') return false;
            if (!looksCompleteJson(s)) return false;
            try {
                const data = JSON.parse(s);
                stats.inspectedJson++;
                harvest(data);
                return true;
            } catch (err) {
                log('json parse fail', err && err.message ? err.message : err);
                return false;
            }
        }

        function lookupPost(code, pk) {
            if (code && postsByKey.has(code)) return postsByKey.get(code);
            if (pk && postsByKey.has(pk)) return postsByKey.get(pk);
            return null;
        }

        // 只用來比較 GraphQL candidate；唔好改已經有 oh= 簽名嘅 live CDN URL，
        // 否則 Instagram 會 403（簽名包埋 stp）。
        function upgradeDomImageUrl(url) {
            if (!url || url.indexOf('stp=') < 0) return url;
            return url.replace(/([?&]stp=)([^&]*)/, (_, p, stp) => {
                let s = stp;
                s = s.replace(/c[\d.]+a_/g, '');
                s = s.replace(/_p\d+x\d+/g, '');
                s = s.replace(/_s\d+x\d+/g, '');
                s = s.replace(/_sh[\d.]+/g, '');
                return p + s;
            });
        }

        function listPosts() {
            const uniq = [];
            const seen = new Set();
            postsByKey.forEach((rec) => {
                const k = rec.code || rec.pk;
                if (!k || seen.has(k)) return;
                seen.add(k);
                uniq.push({
                    code: rec.code,
                    pk: rec.pk,
                    username: rec.username,
                    mediaType: rec.mediaType,
                    productType: rec.productType,
                    takenAt: rec.takenAt,
                    files: rec.files.map((f) => ({
                        kind: f.kind,
                        width: f.width,
                        height: f.height,
                        filename: f.filename,
                        url: f.url
                    }))
                });
            });
            return uniq;
        }

        return {
            VERSION,
            CONFIG,
            stats,
            parseUrl,
            parsePostPath,
            parsePostHref,
            currentRouteCode,
            isInspectUrl,
            pkFromIgCacheKey,
            safePart,
            datePrefix,
            extFromUrl,
            isCroppedStp,
            isTinyStp,
            isVideoCoverUrl,
            usernameOf,
            candidatesOf,
            bestImage,
            bestVideo,
            carouselItems,
            isVideoItem,
            filesFromMedia,
            dashUrlsFromXml,
            dashUrlsOf,
            pickHarvestFile,
            looksLikeMediaNode,
            harvest,
            inspectText,
            looksCompleteJson,
            filesScore,
            lookupPost,
            listPosts,
            upgradeDomImageUrl,
            log
        };
    }

    // Tampermonkey 有時會包 CJS `module`；唔好用 `typeof module` 判斷 Node，否則腳本會即刻 return。
    function isNodeEnv() {
        try {
            const p = typeof globalThis !== 'undefined' ? globalThis.process : undefined;
            return !!(p && p.versions && typeof p.versions.node === 'string');
        } catch (_) {
            return false;
        }
    }
    if (isNodeEnv()) {
        // Node CJS 嘅 `module` 係 wrapper 參數，唔係 globalThis.module
        module.exports = { VERSION, createHarvest, DEFAULT_CONFIG };
        return;
    }

    if (root.__instagramPostDownloadActive) return;
    root.__instagramPostDownloadActive = true;

    let bootDebug = false;
    try {
        if (localStorage.getItem('instagram_postDownload_debug') === '1') bootDebug = true;
    } catch (_) { /* private mode */ }

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
                console.debug('[Instagram PostDownload] wrapMethod failed', prop, err);
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
            console.debug('[Instagram PostDownload] wrapMethod define failed', prop, err);
            return false;
        }
    }

    function wrapSetter(proto, prop, makeSetter, makeGetter) {
        if (!proto) return false;
        let desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc || !desc.set) {
            let curr = Object.getPrototypeOf(proto);
            while (curr && (!desc || !desc.set)) {
                desc = Object.getOwnPropertyDescriptor(curr, prop);
                if (desc && desc.set) break;
                curr = Object.getPrototypeOf(curr);
            }
        }
        if (!desc || typeof desc.set !== 'function') return false;
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
            console.debug('[Instagram PostDownload] wrapSetter failed', prop, err);
            return false;
        }
    }

    const core = createHarvest({ debug: bootDebug });
    const {
        CONFIG,
        stats,
        parseUrl,
        parsePostPath,
        parsePostHref,
        currentRouteCode,
        isInspectUrl,
        pkFromIgCacheKey,
        isTinyStp,
        isVideoCoverUrl,
        harvest,
        inspectText,
        lookupPost,
        listPosts,
        pickHarvestFile,
        log
    } = core;

    Object.assign(stats, {
        blockedFetch: 0,
        blockedXhr: 0,
        lockedImg: 0,
        lockedVideo: 0,
        unlockedImg: 0,
        unlockedVideo: 0,
        ignored: 0,
        preloadDropped: 0,
        deferredFetch: 0,
        deferredXhr: 0,
        deferredDropped: 0,
        replayedFetch: 0
    });
    const logSparseCount = Object.create(null);
    function logSparse(key, every, ...args) {
        const n = (logSparseCount[key] || 0) + 1;
        logSparseCount[key] = n;
        if (n <= 3 || n % every === 0) log(...args, '#' + n);
    }

    const PLACEHOLDER =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const STATE_LOCKED = 'locked';
    const STATE_UNLOCKED = 'unlocked';
    const STATE_IGNORED = 'ignored';
    const DS = {
        state: 'igPdState',
        processed: 'igPdProcessed',
        src: 'igPdSrc',
        srcset: 'igPdSrcset',
        poster: 'igPdPoster',
        unlockable: 'igPdUnlockable',
        managed: 'igPdManaged'
    };
    const GATE = {
        mediaHosts: ['cdninstagram.com', 'fbcdn.net', 'facebook.com', 'instagram.com'],
        smallMediaMaxPx: 150,
        blockDialogMedia: false,
        blockStoryMedia: false,
        swallowTimeoutMs: 500,
        pauseBlockMs: 400,
        videoNetworkPassMs: 20000,
        maxDeferredVideo: 24,
        /** MediaSource 已 closed／error 之後幾耐改用 GraphQL muxed mp4 */
        mseFallbackMs: 1200
    };

    function isDataUrl(url) {
        return typeof url === 'string' && /^data:/i.test(url);
    }
    function isBlobUrl(url) {
        return typeof url === 'string' && /^blob:/i.test(url);
    }
    function isPlaceholder(url) {
        return typeof url === 'string' && (url === PLACEHOLDER || url === '' || url === 'about:blank');
    }
    function toStoredUrl(raw) {
        if (raw == null) return '';
        const s = String(raw).trim();
        if (!s || isPlaceholder(s) || isDataUrl(s)) return '';
        return s;
    }
    function hostMatches(hostname, domain) {
        const h = String(hostname || '').toLowerCase();
        const d = String(domain || '').toLowerCase();
        if (!h || !d) return false;
        return h === d || h.endsWith('.' + d);
    }
    function isStaticAssetHost(hostname) {
        const h = String(hostname || '').toLowerCase();
        return h === 'static.cdninstagram.com' || h.endsWith('.static.cdninstagram.com');
    }
    function isMetaMediaHost(hostname) {
        const h = String(hostname || '').toLowerCase();
        if (!h) return false;
        if (isStaticAssetHost(h)) return false;
        if (h.includes('scontent')) return true;
        return GATE.mediaHosts.some((d) => hostMatches(h, d));
    }
    function looksLikeVideoPath(urlObj) {
        if (!urlObj) return false;
        const path = (urlObj.pathname || '') + (urlObj.search || '');
        if (/\.(?:mp4|m4v|mov|webm|mkv|m3u8|mpd)(?:$|[?#])/i.test(path)) return true;
        if (/\/o1\/v\/t\d+\//i.test(urlObj.pathname || '')) return true;
        if (/\/v\/t(?:2|50)\./i.test(urlObj.pathname || '')) return true;
        if (/[?&](?:_nc_vs|vs=)/i.test(urlObj.search || '')) return true;
        return false;
    }
    function looksLikeImagePath(urlObj) {
        if (!urlObj) return false;
        if (looksLikeVideoPath(urlObj)) return false;
        const path = (urlObj.pathname || '') + (urlObj.search || '');
        if (/favicon/i.test(path)) return false;
        if (/\/rsrc\.php\//i.test(urlObj.pathname || '')) return false;
        if (/\/(?:graphql\/|api\/v1\/|ajax\/)/i.test(urlObj.pathname || '')) return false;
        if (/\.(?:jpe?g|png|gif|webp|avif|heic|heif|bmp)(?:$|[?#])/i.test(path)) return true;
        if (/[?&](?:stp=|ig_cache_key=)/i.test(urlObj.search || '')) return true;
        if (/\/v\/t51\./i.test(urlObj.pathname || '')) return true;
        return false;
    }
    function isTinyCdnSize(urlObj) {
        if (!urlObj) return false;
        const m = (urlObj.pathname + urlObj.search).match(/s(\d+)x(\d+)/i);
        if (!m) return false;
        return parseInt(m[1], 10) <= GATE.smallMediaMaxPx && parseInt(m[2], 10) <= GATE.smallMediaMaxPx;
    }
    function isProfileCdnPath(urlObj) {
        if (!urlObj) return false;
        if (/\/v\/t\d+\.[\d.]+-19\//i.test(urlObj.pathname || '')) return true;
        const blob = (urlObj.pathname || '') + (urlObj.search || '');
        if (/profile_pic/i.test(blob)) return true;
        if (/InByb2ZpbGVfcGlj|cHJvZmlsZV9waWM/i.test(blob)) return true;
        return false;
    }
    function rememberAllowedImage(url) {
        const urlObj = parseUrl(url);
        if (!urlObj) return;
        allowedImagePaths.add(urlObj.origin + urlObj.pathname);
    }
    function isAllowedImagePath(urlObj) {
        if (!urlObj) return false;
        return allowedImagePaths.has(urlObj.origin + urlObj.pathname);
    }
    function shouldBlockNetworkMedia(value) {
        const urlObj = parseUrl(value);
        if (!urlObj) return false;
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return false;
        if (!isMetaMediaHost(urlObj.hostname)) return false;
        if (isTinyCdnSize(urlObj)) return false;
        if (isProfileCdnPath(urlObj)) return false;
        if (isAllowedImagePath(urlObj)) return false;
        if (looksLikeVideoPath(urlObj)) return false;
        if (/favicon/i.test(urlObj.pathname + urlObj.search)) return false;
        return looksLikeImagePath(urlObj);
    }

    function inDialog(el) {
        return !!(el && el.closest && el.closest('[role="dialog"], [aria-modal="true"]'));
    }
    function isStoryRoute() {
        try {
            return /^\/stories(\/|$)/.test(location.pathname || '');
        } catch (_) {
            return false;
        }
    }
    function inExemptViewer(el) {
        if (GATE.blockDialogMedia) return false;
        if (inDialog(el)) return true;
        if (!GATE.blockStoryMedia && isStoryRoute()) return true;
        return false;
    }

    let videoNetworkHeld = false;
    let videoNetworkReleaseTimer = null;
    const pendingVideoFetches = [];
    const inflightVideoFetch = new Map();
    const mseByBlobUrl = new Map();
    const unlockedVideoCodes = new Set();
    const unlockedVideoRoots = new WeakSet();
    const allowedImagePaths = new Set();
    const allowedVideoPaths = new Set();

    function rememberAllowedVideo(url) {
        const urlObj = parseUrl(url);
        if (!urlObj) return;
        allowedVideoPaths.add(urlObj.origin + urlObj.pathname);
    }
    function isAllowedVideoPath(urlObj) {
        if (!urlObj) return false;
        return allowedVideoPaths.has(urlObj.origin + urlObj.pathname);
    }
    function isHorizontalCarouselUl(ul) {
        if (!ul || ul.tagName !== 'UL' || ul.childElementCount < 2) return false;
        const n = Math.min(ul.childElementCount, 8);
        for (let i = 0; i < n; i++) {
            const li = ul.children[i];
            if (!li) continue;
            let st = '';
            try { st = li.getAttribute('style') || ''; } catch (_) { st = ''; }
            if (/translateX\(/i.test(st)) return true;
        }
        return false;
    }
    function carouselSlideOf(el) {
        if (!el || !el.closest) return null;
        const li = el.closest('ul > li');
        if (!li) return null;
        const ul = li.parentElement;
        // Reels / home clips 列表都係 ul>li；相簿先有 translateX
        if (!isHorizontalCarouselUl(ul)) return null;
        return li;
    }

    function rememberUnlockedVideo(video) {
        try {
            const slide = carouselSlideOf(video);
            const root = slide || (video && video.closest && (
                video.closest('article') ||
                video.closest('[role="dialog"], [aria-modal="true"]')
            ));
            if (root) unlockedVideoRoots.add(root);
            // carousel 唔好用 shortcode：同一 post 第二格片要繼續鎖定
            if (!slide) {
                const code = shortcodeFromNode(root || video);
                if (code) unlockedVideoCodes.add(code);
            }
        } catch (_) { /* ignore */ }
    }
    function videoBelongsToUnlockedPost(video) {
        if (!video) return false;
        try {
            const slide = carouselSlideOf(video);
            if (slide) return unlockedVideoRoots.has(slide);
            const root = video.closest && (
                video.closest('article') ||
                video.closest('[role="dialog"], [aria-modal="true"]')
            );
            if (root && unlockedVideoRoots.has(root)) return true;
            const code = shortcodeFromNode(root || video);
            if (code && unlockedVideoCodes.has(code)) return true;
        } catch (_) { /* ignore */ }
        return false;
    }
    function hasLiveVideoNeed() {
        try {
            // 鎖定中嘅 dialog 片唔算：唔係咁樣 processVideo ignore 時會以為 network 已開，唔 flush deferred DASH
            if (!GATE.blockDialogMedia) {
                const vids = document.querySelectorAll('[role="dialog"] video, [aria-modal="true"] video');
                for (let i = 0; i < vids.length; i++) {
                    if (!isLocked(vids[i])) return true;
                }
            }
            if (!GATE.blockStoryMedia && isStoryRoute()) return true;
        } catch (_) { /* ignore */ }
        return false;
    }
    function isVideoNetworkOpen() {
        return videoNetworkHeld || hasLiveVideoNeed();
    }
    function shouldDeferVideoNetwork(value) {
        const urlObjEarly = parseUrl(value);
        if (isAllowedVideoPath(urlObjEarly)) return false;
        if (isVideoNetworkOpen()) return false;
        try {
            if (!GATE.blockStoryMedia && isStoryRoute()) return false;
        } catch (_) { /* ignore */ }
        const urlObj = urlObjEarly;
        if (!urlObj) return false;
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return false;
        if (!isMetaMediaHost(urlObj.hostname)) return false;
        if (isTinyCdnSize(urlObj)) return false;
        if (isProfileCdnPath(urlObj)) return false;
        if (looksLikeImagePath(urlObj)) return false;
        if (looksLikeVideoPath(urlObj)) return true;
        const h = String(urlObj.hostname || '').toLowerCase();
        if (h.includes('scontent')) return true;
        if (hostMatches(h, 'fbcdn.net') && /\/v\/t\d+/.test(urlObj.pathname || '')) return true;
        return false;
    }
    let parkedDeferredVideo = null;
    function parkDeferredVideo() {
        if (!parkedDeferredVideo) parkedDeferredVideo = new Promise(() => {});
        return parkedDeferredVideo;
    }
    function deferVideoWork(run, key) {
        const pathKey = key ? String(key).split('|')[0] : '__anon__';
        // 同一檔唔同 bytestart 合併，唔係 Oz 會對每段 range 再開 fetch 直至 queue full
        for (let i = 0; i < pendingVideoFetches.length; i++) {
            if (pendingPath(pendingVideoFetches[i]) === pathKey) {
                return new Promise((resolve, reject) => {
                    pendingVideoFetches[i].waiters.push({ resolve, reject });
                });
            }
        }
        if (pendingVideoFetches.length >= GATE.maxDeferredVideo) {
            stats.deferredDropped++;
            logSparse('deferDrop', 100, 'defer video drop (queue full, parked)');
            // 唔好 AbortError：播放器會即刻再 fetch，console 洗版
            return parkDeferredVideo();
        }
        return new Promise((resolve, reject) => {
            const waiters = [{ resolve, reject }];
            pendingVideoFetches.push({
                key: key || pathKey,
                waiters,
                run() {
                    try {
                        const result = run();
                        const ok = (v) => {
                            for (let i = 0; i < waiters.length; i++) {
                                let out = v;
                                if (i > 0 && v && typeof v.clone === 'function') {
                                    try { out = v.clone(); } catch (_) { out = v; }
                                }
                                waiters[i].resolve(out);
                            }
                        };
                        const bad = (e) => { for (let i = 0; i < waiters.length; i++) waiters[i].reject(e); };
                        if (result && typeof result.then === 'function') result.then(ok, bad);
                        else ok(result);
                    } catch (err) {
                        for (let i = 0; i < waiters.length; i++) {
                            try { waiters[i].reject(err); } catch (_) { /* ignore */ }
                        }
                    }
                }
            });
        });
    }
    let flushingVideo = false;
    function pendingPath(item) {
        const k = item && item.key ? String(item.key) : '';
        const i = k.indexOf('|');
        return i < 0 ? k : k.slice(0, i);
    }
    function rejectDeferredItem(item, err) {
        const waiters = item && item.waiters;
        if (!waiters) return;
        for (let j = 0; j < waiters.length; j++) {
            try { waiters[j].reject(err); } catch (_) { /* ignore */ }
        }
    }
    function flushDeferredVideoNetwork(pathFilter) {
        if (flushingVideo) return;
        flushingVideo = true;
        try {
            let batch;
            if (pathFilter && pathFilter.size) {
                const rest = [];
                batch = [];
                for (let i = 0; i < pendingVideoFetches.length; i++) {
                    const item = pendingVideoFetches[i];
                    const path = pendingPath(item);
                    if (!path || pathFilter.has(path)) batch.push(item);
                    else rest.push(item);
                }
                pendingVideoFetches.length = 0;
                for (let i = 0; i < rest.length; i++) pendingVideoFetches.push(rest[i]);
            } else {
                batch = pendingVideoFetches.splice(0);
            }
            for (let i = 0; i < batch.length; i++) {
                try { batch[i].run(); } catch (err) {
                    rejectDeferredItem(batch[i], err);
                }
            }
        } finally {
            flushingVideo = false;
        }
    }
    function scheduleVideoNetworkRelease() {
        if (videoNetworkReleaseTimer != null) clearTimeout(videoNetworkReleaseTimer);
        videoNetworkReleaseTimer = setTimeout(() => {
            videoNetworkReleaseTimer = null;
            if (hasLiveVideoNeed()) {
                scheduleVideoNetworkRelease();
                return;
            }
            videoNetworkHeld = false;
        }, GATE.videoNetworkPassMs);
    }
    function recForVideo(video) {
        try {
            const root = findMediaRoot(video);
            const route = currentRouteCode();
            const code = shortcodeFromNode(root) || (route && route.code) || '';
            const pk = pkFromNode(root) || pkFromIgCacheKey(storedSrcOf(video));
            return lookupPost(code, pk);
        } catch (_) {
            return null;
        }
    }
    function pathsForVideo(video) {
        const set = new Set();
        const rec = recForVideo(video);
        if (!rec) return set;
        const add = (url) => {
            const urlObj = parseUrl(url);
            if (urlObj) set.add(urlObj.origin + urlObj.pathname);
        };
        const files = rec.files || [];
        for (let i = 0; i < files.length; i++) {
            if (files[i] && files[i].url) add(files[i].url);
            const extra = files[i] && files[i].dashUrls;
            if (extra) {
                for (let j = 0; j < extra.length; j++) add(extra[j]);
            }
        }
        const dash = rec.dashUrls || [];
        for (let i = 0; i < dash.length; i++) add(dash[i]);
        return set;
    }
    function allowVideoUrls(urls) {
        const paths = new Set();
        const list = urls || [];
        for (let i = 0; i < list.length; i++) {
            const urlObj = parseUrl(list[i]);
            if (!urlObj) continue;
            const p = urlObj.origin + urlObj.pathname;
            allowedVideoPaths.add(p);
            paths.add(p);
        }
        if (paths.size) flushDeferredVideoNetwork(paths);
        return paths;
    }
    function allowVideoNetworkTemporarily(video, opts) {
        const progressiveUrl = opts && opts.progressiveUrl;
        if (progressiveUrl) {
            allowVideoUrls([progressiveUrl]);
            return;
        }
        if (!video) {
            videoNetworkHeld = true;
            flushDeferredVideoNetwork(null);
            scheduleVideoNetworkRelease();
            return;
        }
        const gql = graphqlFileFor(video);
        const urls = [];
        if (gql && gql.url) urls.push(gql.url);
        if (gql && gql.dashUrls) {
            for (let i = 0; i < gql.dashUrls.length; i++) urls.push(gql.dashUrls[i]);
        }
        if (urls.length && gql && gql.dashUrls && gql.dashUrls.length) {
            allowVideoUrls(urls);
            return;
        }
        // 認唔到呢格 DASH（虛擬化 li／未 harvest 尾段 carousel）：放行全部 deferred
        if (urls.length) allowVideoUrls(urls);
        videoNetworkHeld = true;
        flushDeferredVideoNetwork(null);
        scheduleVideoNetworkRelease();
    }
    function videoRequestKey(input, init) {
        const urlObj = parseUrl(input);
        if (!urlObj) return '';
        // pathname 已唯一；bytestart 分開，唔計 _nc_gid 等會令 retry 打爆 CDN
        let key = urlObj.origin + urlObj.pathname;
        try {
            const start = urlObj.searchParams.get('bytestart') || '';
            const end = urlObj.searchParams.get('byteend') || '';
            if (start || end) key += '|b=' + start + '-' + end;
        } catch (_) { /* ignore */ }
        try {
            let range = '';
            if (typeof Request !== 'undefined' && input instanceof Request) {
                range = input.headers.get('Range') || '';
            } else if (init && init.headers) {
                const h = init.headers;
                range = typeof h.get === 'function' ? (h.get('Range') || '') : String(h.Range || h.range || '');
            }
            if (range) key += '|R=' + range;
        } catch (_) { /* ignore */ }
        return key;
    }
    function nativeFetchFresh(nativeFetch, ctx, args) {
        try {
            const input = args[0];
            const init = args[1];
            let signal = null;
            if (init && init.signal) signal = init.signal;
            else if (typeof Request !== 'undefined' && input instanceof Request) {
                try { signal = input.signal; } catch (_) { signal = null; }
            }
            if (!signal || !signal.aborted) {
                return nativeFetch.apply(ctx, args);
            }
            // Oz FetchWithTimeout 喺 hang 期間已經 abort；換新 signal 先唔會即刻 AbortError
            const fresh = { signal: new AbortController().signal };
            if (typeof Request !== 'undefined' && input instanceof Request) {
                return nativeFetch.call(ctx, new Request(input, fresh));
            }
            const nextInit = Object.assign({}, init || {}, fresh);
            return nativeFetch.call(ctx, input, nextInit);
        } catch (_) {
            return nativeFetch.apply(ctx, args);
        }
    }
    function fetchVideoShared(nativeFetch, ctx, args) {
        const key = videoRequestKey(args[0], args[1]);
        if (key && inflightVideoFetch.has(key)) {
            return inflightVideoFetch.get(key).then((pair) => {
                const src = pair && (pair.copy || pair.res);
                try { return src.clone(); } catch (_) { return src; }
            });
        }
        const p = Promise.resolve(nativeFetchFresh(nativeFetch, ctx, args)).then((res) => {
            let copy = null;
            try { copy = res.clone(); } catch (_) { copy = null; }
            return { res, copy };
        });
        if (key) {
            inflightVideoFetch.set(key, p);
            p.finally(() => inflightVideoFetch.delete(key));
        }
        return p.then((pair) => pair.res);
    }

    function emptyMediaResponse() {
        return new Response(null, {
            status: 204,
            statusText: 'No Content',
            headers: { 'Cache-Control': 'no-store' }
        });
    }

    function inspectResponse(res) {
        if (!res || !res.ok) return;
        try {
            if (res.type === 'opaque' || res.type === 'opaqueredirect') return;
            const urlObj = parseUrl(res.url);
            if (urlObj && !isInspectUrl(urlObj)) return;
            const path = (urlObj && urlObj.pathname) || '';
            if (!/\/graphql|\/api\/v1\/(?:feed|media|clips)|\/query/i.test(path)) return;
            const cl = res.headers && res.headers.get('content-length');
            if (cl && Number(cl) > CONFIG.maxInspectBytes) return;
            const ct = String((res.headers && res.headers.get('content-type')) || '').toLowerCase();
            const maybeJson =
                ct.includes('json') ||
                ct.includes('javascript') ||
                ct.includes('text/plain') ||
                ct === '' ||
                /graphql|\/api\//i.test(path);
            if (!maybeJson) return;
            const clone = res.clone();
            clone.text().then((text) => {
                const run = () => { try { inspectText(text); } catch (_) { /* ignore */ } };
                if (typeof requestIdleCallback === 'function') {
                    requestIdleCallback(run, { timeout: 1200 });
                } else {
                    setTimeout(run, 0);
                }
            }).catch(() => {});
        } catch (err) {
            log('inspectResponse error', err);
        }
    }

    wrapMethod(window, 'fetch', (nativeFetch) => function (...args) {
        try {
            if (shouldBlockNetworkMedia(args[0])) {
                stats.blockedFetch++;
                log('block fetch', parseUrl(args[0]) && parseUrl(args[0]).href);
                return Promise.resolve(emptyMediaResponse());
            }
            if (shouldDeferVideoNetwork(args[0])) {
                stats.deferredFetch++;
                logSparse('deferFetch', 100, 'defer video fetch');
                return deferVideoWork(
                    () => fetchVideoShared(nativeFetch, this, args),
                    videoRequestKey(args[0], args[1])
                );
            }
            if (looksLikeVideoPath(parseUrl(args[0]))) {
                return fetchVideoShared(nativeFetch, this, args);
            }
            const urlObj = parseUrl(args[0]);
            if (isInspectUrl(urlObj)) {
                const p = nativeFetch.apply(this, args);
                return Promise.resolve(p).then((res) => {
                    inspectResponse(res);
                    return res;
                });
            }
        } catch (err) {
            log('fetch gate error', err);
        }
        return nativeFetch.apply(this, args);
    });

    (function patchXHR() {
        if (typeof XMLHttpRequest === 'undefined') return;
        const proto = XMLHttpRequest.prototype;
        const nativeOpen = proto.open;
        const nativeSend = proto.send;
        proto.open = function (method, url, ...rest) {
            try {
                this._igPdUrl = url;
                this._igPdBlock = shouldBlockNetworkMedia(url);
                this._igPdDeferVideo = !this._igPdBlock && shouldDeferVideoNetwork(url);
            } catch (_) {
                this._igPdBlock = false;
                this._igPdDeferVideo = false;
            }
            return nativeOpen.call(this, method, url, ...rest);
        };
        proto.send = function (...args) {
            if (this._igPdBlock) {
                stats.blockedXhr++;
                log('block xhr', this._igPdUrl);
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
            if (this._igPdDeferVideo && !isVideoNetworkOpen()) {
                stats.deferredXhr++;
                logSparse('deferXhr', 100, 'defer video xhr');
                deferVideoWork(() => nativeSend.apply(this, args)).catch(() => {});
                return;
            }
            try {
                this.addEventListener('load', function () {
                    try {
                        if (this.status < 200 || this.status >= 300) return;
                        const urlObj = parseUrl(this._igPdUrl || this.responseURL);
                        if (urlObj && !isInspectUrl(urlObj)) return;
                        const t = this.responseType;
                        if (t && t !== '' && t !== 'text' && t !== 'json') return;
                        if (t === 'json' && this.response) harvest(this.response);
                        else inspectText(this.responseText);
                    } catch (err) {
                        log('xhr harvest error', err);
                    }
                });
            } catch (_) { /* ignore */ }
            return nativeSend.apply(this, args);
        };
    })();

    function harvestInlineScripts(root) {
        try {
            const scope = root && root.querySelectorAll ? root : document;
            const scripts = scope.querySelectorAll('script[type="application/json"], script[data-sjs]');
            for (let i = 0; i < scripts.length; i++) {
                const el = scripts[i];
                if (el._igPdRead) continue;
                const text = el.textContent || '';
                if (text.length < 40) continue;
                const declared = Number(el.getAttribute('data-content-len') || 0);
                if (declared > 0 && text.length < declared) continue;
                if (!core.looksCompleteJson(text)) continue;
                if (inspectText(text)) {
                    el._igPdRead = true;
                    continue;
                }
                if (el._igPdJsonLen === text.length) {
                    el._igPdJsonFails = (el._igPdJsonFails || 0) + 1;
                    if (el._igPdJsonFails >= 3) el._igPdRead = true;
                } else {
                    el._igPdJsonLen = text.length;
                    el._igPdJsonFails = 1;
                }
            }
        } catch (err) {
            log('harvestInlineScripts error', err);
        }
    }

    function isUnlocking(el) {
        return !!(el && el._igPdUnlocking);
    }
    function withUnlocking(el, fn) {
        if (!el) return;
        el._igPdUnlocking = true;
        try { fn(); } finally { el._igPdUnlocking = false; }
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
    function flush() {
        scheduled = false;
        if (pending.size === 0) return;
        const batch = Array.from(pending);
        pending.clear();
        for (let i = 0; i < batch.length; i++) {
            try { handleElement(batch[i]); } catch (err) {
                log('handleElement error', err);
            }
        }
        refreshLoadAllButton();
    }

    const cssRule = `
        video[data-ig-pd-state="locked"] {
            cursor: pointer !important;
        }
        video[data-ig-pd-state="locked"]::-webkit-media-controls {
            display: none !important;
        }
        [data-ig-pd-video-lock="1"] {
            position: relative !important;
        }
        [data-ig-pd-video-lock="1"]::after {
            content: '' !important;
            position: absolute !important;
            inset: 0 !important;
            background-color: #1a1a1a !important;
            background-image: url('data:image/svg+xml;utf8,<svg width="48" height="48" viewBox="0 0 24 24" fill="%23ffffff" xmlns="http://www.w3.org/2000/svg"><path d="M8 5v14l11-7z"/></svg>') !important;
            background-position: center !important;
            background-repeat: no-repeat !important;
            background-size: 48px !important;
            pointer-events: none !important;
            z-index: 3 !important;
        }
        [data-ig-pd-video-lock="1"]:hover::after {
            background-color: #2a2a2a !important;
            background-size: 56px !important;
        }
        [data-ig-pd-hidden-error="1"] {
            display: none !important;
            pointer-events: none !important;
        }
        video[data-ig-pd-empty="1"] {
            opacity: 0 !important;
        }
        img[data-ig-pd-state="locked"] {
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
            object-fit: cover !important;
        }
        img[data-ig-pd-state="locked"]:hover,
        img[data-ig-pd-state="locked"]:focus-visible {
            background-color: #2a2a2a !important;
            background-size: 40px !important;
        }
        img[data-ig-pd-state="locked"]:focus-visible,
        video[data-ig-pd-state="locked"]:focus-visible {
            outline: 2px solid #0095f6 !important;
            outline-offset: 2px !important;
        }
        [role="dialog"] video[data-ig-pd-state="locked"],
        [role="dialog"] img[data-ig-pd-state="locked"],
        [aria-modal="true"] video[data-ig-pd-state="locked"],
        [aria-modal="true"] img[data-ig-pd-state="locked"] {
            filter: none !important;
            background: none !important;
            content: none !important;
            cursor: default !important;
            min-height: 0 !important;
        }
        #instagram-post-download-load-all {
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
        #instagram-post-download-load-all:hover,
        #instagram-post-download-load-all:focus-visible {
            background: rgba(42,42,42,0.96);
            outline: 2px solid #0095f6;
            outline-offset: 2px;
        }
        #instagram-post-download-load-all[hidden] {
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
        try {
            const video = source.closest && source.closest('video');
            if (video) {
                const key = prop === 'srcset' ? DS.srcset : DS.src;
                if (value) storeMediaUrl(source, key, value);
                if (
                    isUnlocking(video) ||
                    isUnlocked(video) ||
                    getState(video) === STATE_IGNORED ||
                    (!GATE.blockDialogMedia && inExemptViewer(video))
                ) {
                    return prevSet ? prevSet.call(source, value) : undefined;
                }
                setState(video, STATE_LOCKED);
                markProcessed(video, false);
                queueElement(video);
                if (prop === 'srcset' && prevSet) return prevSet.call(source, '');
                return;
            }
        } catch (_) { /* ignore */ }
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
        } catch (_) { /* ignore */ }
        if (prop === 'srcset' && prevSet) return prevSet.call(source, '');
        if (prop === 'src') return;
        return prevSet ? prevSet.call(source, value) : undefined;
    }
    function gateVideoSrc(video, value, prevSet) {
        if (video && video._igPdKeepProgressive) {
            if (isBlobUrl(value)) return;
            if (isUnlocking(video)) return prevSet.call(video, value);
            return;
        }
        if (isUnlocking(video) || isUnlocked(video) || getState(video) === STATE_IGNORED) {
            return prevSet.call(video, value);
        }
        if (!GATE.blockDialogMedia && inExemptViewer(video)) {
            return prevSet.call(video, value);
        }
        if (isDataUrl(value) || isPlaceholder(value)) {
            return prevSet.call(video, value);
        }
        if (isBlobUrl(value)) {
            storeMediaUrl(video, DS.src, value);
            setState(video, STATE_LOCKED);
            markProcessed(video, false);
            queueElement(video);
            // 鎖定唔 attach blob：一 attach MSE 就會狂 fetch DASH
            return;
        }
        if (value) storeMediaUrl(video, DS.src, value);
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
    function gateVideoSrcObject(video, value, prevSet) {
        if (video && video._igPdKeepProgressive && value) return;
        if (isUnlocking(video) || isUnlocked(video) || getState(video) === STATE_IGNORED) {
            return prevSet.call(video, value);
        }
        if (!GATE.blockDialogMedia && inExemptViewer(video)) {
            return prevSet.call(video, value);
        }
        if (value == null) {
            return prevSet.call(video, value);
        }
        try {
            if (video.srcObject === value) return;
        } catch (_) { /* ignore */ }
        video._igPdSrcObject = value;
        setState(video, STATE_LOCKED);
        markProcessed(video, false);
        queueElement(video);
        return;
    }

    wrapSetter(
        HTMLImageElement.prototype,
        'src',
        (prevSet) => function (val) {
            try { return gateImageSrc(this, val, prevSet); } catch (err) {
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
            try { return gateImageSrcset(this, val, prevSet); } catch (err) {
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
            try { return gateSourceAttr(this, 'src', val, prevSet); } catch (err) {
                log('source.src error', err);
                return prevSet.call(this, val);
            }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.src]) return this.dataset[DS.src];
            return prevGet ? prevGet.call(this) : '';
        }
    );
    wrapSetter(
        HTMLSourceElement.prototype,
        'srcset',
        (prevSet) => function (val) {
            try { return gateSourceAttr(this, 'srcset', val, prevSet); } catch (err) {
                log('source.srcset error', err);
                return prevSet.call(this, val);
            }
        },
        (prevGet) => function () {
            if (!isUnlocking(this) && this.dataset && this.dataset[DS.srcset]) return this.dataset[DS.srcset];
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
        'srcObject',
        (prevSet) => function (val) {
            try {
                if (this.tagName === 'VIDEO') return gateVideoSrcObject(this, val, prevSet);
                return prevSet.call(this, val);
            } catch (err) {
                log('media.srcObject error', err);
                return prevSet.call(this, val);
            }
        },
        (prevGet) => function () {
            if (this.tagName === 'VIDEO' && !isUnlocking(this) && this._igPdSrcObject && isLocked(this)) {
                return this._igPdSrcObject;
            }
            return prevGet ? prevGet.call(this) : null;
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
        HTMLVideoElement.prototype,
        'poster',
        (prevSet) => function (val) {
            try { return gateVideoPoster(this, val, prevSet); } catch (err) {
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

    function isMediaPreloadLink(el) {
        if (!el || el.tagName !== 'LINK') return false;
        const rel = String(el.getAttribute('rel') || el.rel || '').toLowerCase();
        const asAttr = String(el.getAttribute('as') || el.as || '').toLowerCase();
        if (!rel.split(/\s+/).includes('preload')) return false;
        return asAttr === 'image' || asAttr === 'video';
    }
    function neutralizePreloadLink(link) {
        if (!link || !isMediaPreloadLink(link)) return false;
        try {
            const asAttr = String(link.getAttribute('as') || link.as || '').toLowerCase();
            const href = link.getAttribute('href') || '';
            const urlObj = parseUrl(href);
            const disarm = () => {
                // 先拎走 rel=preload，唔好留空 href 令 Chrome 報 invalid href
                try { link.setAttribute('rel', 'ig-pd-blocked'); } catch (_) { /* ignore */ }
                try { link.removeAttribute('as'); } catch (_) { /* ignore */ }
                try { link.removeAttribute('href'); } catch (_) { /* ignore */ }
                try { link.removeAttribute('imagesrcset'); } catch (_) { /* ignore */ }
                try { link.removeAttribute('imagesizes'); } catch (_) { /* ignore */ }
            };
            if (asAttr === 'video' || (urlObj && looksLikeVideoPath(urlObj))) {
                disarm();
                stats.preloadDropped++;
                return true;
            }
            if (urlObj && (isTinyCdnSize(urlObj) || isProfileCdnPath(urlObj))) return false;
            if (href && !shouldBlockNetworkMedia(href) && urlObj && !isMetaMediaHost(urlObj.hostname)) return false;
            disarm();
            stats.preloadDropped++;
            return true;
        } catch (err) {
            log('neutralizePreload error', err);
            return false;
        }
    }

    (function patchSetAttribute() {
        const prev = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            try {
                if (!this || typeof name !== 'string') return prev.call(this, name, value);
                const attr = name.toLowerCase();
                if (this.tagName === 'LINK') {
                    if (attr === 'rel' || attr === 'as' || attr === 'href' || attr === 'imagesrcset' || attr === 'imagesizes') {
                        const result = prev.call(this, name, value);
                        if (isMediaPreloadLink(this)) neutralizePreloadLink(this);
                        return result;
                    }
                }
                if (isUnlocking(this)) return prev.call(this, name, value);
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
                    if (this.closest('video')) {
                        const video = this.closest('video');
                        const key = attr === 'srcset' ? DS.srcset : DS.src;
                        if (value) storeMediaUrl(this, key, value);
                        if (
                            isUnlocking(video) ||
                            isUnlocked(video) ||
                            getState(video) === STATE_IGNORED ||
                            (!GATE.blockDialogMedia && inExemptViewer(video))
                        ) {
                            return prev.call(this, name, value);
                        }
                        setState(video, STATE_LOCKED);
                        markProcessed(video, false);
                        queueElement(video);
                        if (attr === 'srcset') return prev.call(this, name, '');
                        return;
                    }
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
                    return;
                }
                if (this.tagName === 'VIDEO') {
                    if (attr === 'src') {
                        if (this._igPdKeepProgressive) {
                            if (isBlobUrl(value)) return;
                            if (isUnlocking(this)) return prev.call(this, name, value);
                            return;
                        }
                        if (isUnlocked(this) || getState(this) === STATE_IGNORED) {
                            return prev.call(this, name, value);
                        }
                        if (!GATE.blockDialogMedia && inExemptViewer(this)) {
                            return prev.call(this, name, value);
                        }
                        if (isDataUrl(value) || isPlaceholder(value)) {
                            return prev.call(this, name, value);
                        }
                        if (value) storeMediaUrl(this, DS.src, value);
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
                }
            } catch (err) {
                log('setAttribute error', err);
            }
            return prev.call(this, name, value);
        };
    })();

    const originalPlay = HTMLVideoElement.prototype.play;
    function enqueueHeldPlay(video) {
        if (video._igPdPlayHoldPromise) return video._igPdPlayHoldPromise;
        video._igPdPlayHoldPromise = new Promise((resolve, reject) => {
            video._igPdPlayHold = { resolve, reject };
        });
        return video._igPdPlayHoldPromise;
    }
    function flushHeldPlay(video) {
        const hold = video._igPdPlayHold;
        video._igPdPlayHold = null;
        video._igPdPlayHoldPromise = null;
        let p;
        try {
            p = originalPlay.call(video);
        } catch (err) {
            if (hold) hold.reject(err);
            return Promise.reject(err);
        }
        if (hold) {
            if (p && typeof p.then === 'function') p.then(hold.resolve, hold.reject);
            else hold.resolve();
        }
        return p;
    }
    try {
        wrapMethod(URL, 'createObjectURL', (native) => function (obj) {
            const url = native.call(this, obj);
            try {
                if (typeof MediaSource !== 'undefined' && obj instanceof MediaSource && url) {
                    mseByBlobUrl.set(url, obj);
                }
            } catch (_) { /* ignore */ }
            return url;
        });
        wrapMethod(URL, 'revokeObjectURL', (native) => function (url) {
            try { mseByBlobUrl.delete(url); } catch (_) { /* ignore */ }
            return native.call(this, url);
        });
    } catch (_) { /* ignore */ }

    wrapMethod(HTMLVideoElement.prototype, 'play', (nativePlay) => function (...args) {
        if (isUnlocked(this) || getState(this) === STATE_IGNORED) {
            return nativePlay.apply(this, args);
        }
        if (!GATE.blockDialogMedia && inExemptViewer(this)) {
            return nativePlay.apply(this, args);
        }
        if (videoBelongsToUnlockedPost(this)) {
            setState(this, STATE_UNLOCKED);
            return nativePlay.apply(this, args);
        }
        setState(this, STATE_LOCKED);
        queueElement(this);
        return enqueueHeldPlay(this);
    });
    wrapMethod(HTMLMediaElement.prototype, 'pause', (nativePause) => function (...args) {
        if (this.tagName === 'VIDEO' && this._igPdBlockPause) return;
        return nativePause.apply(this, args);
    });
    wrapMethod(HTMLMediaElement.prototype, 'load', (nativeLoad) => function (...args) {
        if (this.tagName === 'VIDEO' && this._igPdKeepProgressive && !isUnlocking(this)) {
            return;
        }
        if (
            this.tagName === 'VIDEO' &&
            !isUnlocking(this) &&
            !isUnlocked(this) &&
            getState(this) !== STATE_IGNORED &&
            !( !GATE.blockDialogMedia && inExemptViewer(this) )
        ) {
            log('skip video.load while locked');
            return;
        }
        return nativeLoad.apply(this, args);
    });

    window.addEventListener('error', (e) => {
        const t = e.target;
        if (!t || !t.tagName) return;
        if ((t.tagName === 'IMG' || t.tagName === 'VIDEO' || t.tagName === 'SOURCE') && isLocked(t)) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }
    }, true);

    const visibleLocked = new Set();
    const io = new IntersectionObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const el = entry.target;
            if (entry.isIntersecting && isLocked(el) && el.isConnected) {
                visibleLocked.add(el);
                if (el.tagName === 'VIDEO') {
                    markVideoLockOverlay(el, true);
                    hideIgPlaybackErrorNear(el);
                }
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
    function inStoryTray(img) {
        try {
            const host = img.closest('[aria-label^="Story by"], [aria-label^="Highlight by"]');
            if (!host) return false;
            const r = img.getBoundingClientRect();
            if (r.width > 0 && r.width <= 120 && r.height <= 120) return true;
            return true;
        } catch (_) {
            return false;
        }
    }
    function shouldIgnoreImage(img) {
        if (!img || img.tagName !== 'IMG') return true;
        if (img.closest('svg')) return true;
        if (!GATE.blockDialogMedia && inExemptViewer(img)) return true;
        const alt = String(img.getAttribute('alt') || img.alt || '').toLowerCase();
        if (
            alt.includes('profile') ||
            alt.includes('avatar') ||
            alt.includes('頭像') ||
            alt.includes('プロフィール') ||
            alt.includes('프로필') ||
            alt.includes('foto del perfil') ||
            alt.includes('foto de perfil')
        ) {
            return true;
        }
        if (isSmallByAttributes(img)) return true;
        if (inStoryTray(img)) return true;
        const stored = img.dataset[DS.src] || '';
        const attrSrc = img.getAttribute('src') || '';
        const check = stored || attrSrc;
        if (/favicon/i.test(check)) return true;
        const urlObj = parseUrl(check);
        if (urlObj) {
            if (isTinyCdnSize(urlObj)) return true;
            if (isProfileCdnPath(urlObj)) return true;
        }
        if (isTinyStp(check)) return true;
        try {
            const link = img.closest('a[role="link"], a[href^="/"]');
            if (link) {
                const href = String(link.getAttribute('href') || '');
                const isContentLink = /^\/(p|reel|reels|tv)\//.test(href);
                if (!isContentLink) {
                    const r = link.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && r.width <= 64 && r.height <= 64) return true;
                }
            }
        } catch (_) { /* ignore */ }
        return false;
    }
    function isNearVideoPoster(img) {
        if (!img) return false;
        try {
            // 普通 carousel 相（_aagu）唔好當片封面，即使同一 li 留低咗上格 video
            if (img.closest && img.closest('._aagu, ._aagv')) return false;
        } catch (_) { /* ignore */ }
        const src = storedSrcOf(img) || img.getAttribute('src') || '';
        const coverHint =
            isVideoCoverUrl(src) ||
            img.getAttribute('aria-hidden') === 'true' ||
            !!(img.closest && img.closest('[aria-label="Video player"]'));
        const slide = carouselSlideOf(img);
        let curr = img.parentElement;
        let nearVideo = false;
        for (let i = 0; i < 4 && curr && curr !== document.body && curr.tagName !== 'ARTICLE'; i++) {
            if (curr.tagName === 'UL') break;
            if (slide && curr === slide.parentElement) break;
            if (curr.querySelector && curr.querySelector(':scope > video, :scope > * > video')) {
                nearVideo = true;
                break;
            }
            if (slide && curr === slide) {
                nearVideo = !!slide.querySelector('video');
                break;
            }
            curr = curr.parentElement;
        }
        if (!nearVideo) return false;
        return coverHint || nearVideo;
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
    function markVideoLockOverlay(video, on) {
        if (!video) return;
        const prev = video._igPdLockParent;
        if (!on) {
            if (prev && prev.dataset) delete prev.dataset.igPdVideoLock;
            video._igPdLockParent = null;
            return;
        }
        let chosen = video.parentElement;
        try {
            const vr = video.getBoundingClientRect();
            if (chosen && vr.width > 8 && vr.height > 8) {
                const r = chosen.getBoundingClientRect();
                if (r.width > vr.width * 1.6 || r.height > vr.height * 1.6) chosen = null;
            }
        } catch (_) { /* ignore */ }
        if (prev && prev !== chosen && prev.dataset) delete prev.dataset.igPdVideoLock;
        if (chosen && chosen.dataset) {
            chosen.dataset.igPdVideoLock = '1';
            video._igPdLockParent = chosen;
        }
    }
    const IG_PLAYBACK_ERROR_RE = /having trouble(?: with)? playing this video/i;
    function hideErrorBox(el, host) {
        if (!el || el === host) return;
        let box = el;
        for (let k = 0; k < 4 && box && box !== host; k++) {
            if (box.childElementCount > 8) break;
            const next = box.parentElement;
            if (!next || next === host) break;
            box = next;
        }
        if (!box || box === host) return;
        try {
            const br = box.getBoundingClientRect();
            const tooBig =
                br.height > (window.innerHeight || 800) * 0.55 &&
                br.width > (window.innerWidth || 800) * 0.55;
            if (tooBig) box.style.setProperty('pointer-events', 'none', 'important');
            else box.setAttribute('data-ig-pd-hidden-error', '1');
        } catch (_) {
            try { box.setAttribute('data-ig-pd-hidden-error', '1'); } catch (__) { /* ignore */ }
        }
    }
    function hideIgPlaybackErrorNear(video) {
        if (!video || !video.isConnected) return;
        try {
            const host =
                (video.parentElement && video.parentElement.parentElement) ||
                video.closest('[data-instancekey]') ||
                video.parentElement;
            if (!host || !host.querySelectorAll) return;
            const overlay = host.querySelector('[aria-label="Video player"]') || host;
            const nodes = overlay.querySelectorAll('span');
            const n = Math.min(nodes.length, 48);
            for (let i = 0; i < n; i++) {
                const el = nodes[i];
                if (el.childElementCount > 2) continue;
                const raw = el.textContent;
                if (!raw || raw.length > 180) continue;
                if (!IG_PLAYBACK_ERROR_RE.test(raw)) continue;
                hideErrorBox(el, overlay);
                return;
            }
        } catch (err) {
            log('hideIgPlaybackError error', err);
        }
    }
    function hideIgPlaybackErrorInNode(node) {
        if (!node || node.nodeType !== 1) return;
        if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'LINK') return;
        try {
            if (node.childElementCount > 12) return;
            const raw = node.textContent;
            if (!raw || raw.length > 220 || !IG_PLAYBACK_ERROR_RE.test(raw)) return;
            const video = node.querySelector && node.querySelector('video');
            if (video) hideIgPlaybackErrorNear(video);
            else {
                const host = node.closest && node.closest('[aria-label="Video player"], [data-instancekey]');
                if (host) hideErrorBox(node, host);
            }
        } catch (_) { /* ignore */ }
    }
    function prepareLockedVideo(video) {
        const attrSrc = video.getAttribute('src');
        const attrPoster = video.getAttribute('poster');
        if (attrSrc && !isPlaceholder(attrSrc) && !isDataUrl(attrSrc) && !isBlobUrl(attrSrc)) {
            storeMediaUrl(video, DS.src, attrSrc);
        }
        if (attrPoster && !isPlaceholder(attrPoster) && !isDataUrl(attrPoster)) {
            storeMediaUrl(video, DS.poster, attrPoster);
        }
        try {
            if (video.srcObject && !video._igPdSrcObject) video._igPdSrcObject = video.srcObject;
        } catch (_) { /* ignore */ }
        withUnlocking(video, () => {
            try {
                video.removeAttribute('autoplay');
                video.autoplay = false;
                try { video.pause(); } catch (_) { /* ignore */ }
                if (attrSrc && !isPlaceholder(attrSrc) && !isDataUrl(attrSrc)) {
                    if (isBlobUrl(attrSrc)) storeMediaUrl(video, DS.src, attrSrc);
                    video.removeAttribute('src');
                }
                try {
                    if (video.srcObject) {
                        video._igPdSrcObject = video.srcObject;
                        video.srcObject = null;
                    }
                } catch (_) { /* ignore */ }
                if (attrPoster && !isPlaceholder(attrPoster)) {
                    video.setAttribute('poster', PLACEHOLDER);
                }
            } catch (err) {
                log('prepareLockedVideo error', err);
            }
        });
        markVideoLockOverlay(video, true);
        hideIgPlaybackErrorNear(video);
    }
    function processVideo(video) {
        if (!video || video.tagName !== 'VIDEO') return;
        if (isUnlocked(video)) return;
        if (videoBelongsToUnlockedPost(video)) {
            setState(video, STATE_UNLOCKED);
            markProcessed(video, true);
            return;
        }
        if (isProcessed(video) && isLocked(video)) {
            observeLocked(video);
            return;
        }
        if (!GATE.blockDialogMedia && inExemptViewer(video)) {
            silenceAsIgnored(video);
            allowVideoNetworkTemporarily(video);
            recoverDeferredVideo(video);
            return;
        }
        const firstManage = video.dataset[DS.managed] !== '1';
        video.dataset[DS.managed] = '1';
        markProcessed(video, true);
        setState(video, STATE_LOCKED);
        prepareLockedVideo(video);
        makeUnlockableA11y(video, 'video');
        observeLocked(video);
        if (firstManage) {
            stats.lockedVideo++;
            log('locked video');
        }
        const slide = carouselSlideOf(video);
        let curr = video.parentElement;
        for (let i = 0; i < 2 && curr; i++) {
            if (slide && curr === slide.parentElement) break;
            if (curr.tagName === 'UL') break;
            const imgs = curr.querySelectorAll(':scope > img, :scope > * > img');
            for (let j = 0; j < imgs.length; j++) {
                const img = imgs[j];
                if (slide && !slide.contains(img)) continue;
                if (isNearVideoPoster(img) && (isLocked(img) || !isProcessed(img))) {
                    silenceAsIgnored(img);
                    stripA11y(img);
                }
            }
            if (slide && curr === slide) break;
            curr = curr.parentElement;
        }
    }
    function processImage(img) {
        if (!img || img.tagName !== 'IMG') return;
        if (isUnlocked(img)) return;
        if (isProcessed(img) && isLocked(img)) {
            if (shouldIgnoreImage(img)) unlockImage(img, true);
            else observeLocked(img);
            return;
        }
        if (shouldIgnoreImage(img)) {
            markProcessed(img, true);
            unlockImage(img, true);
            return;
        }
        if (getState(img) === STATE_IGNORED && carouselSlideOf(img) && !isNearVideoPoster(img)) {
            try { img.style.removeProperty('pointer-events'); } catch (_) { /* ignore */ }
            img.dataset[DS.managed] = '1';
            markProcessed(img, true);
            setState(img, STATE_LOCKED);
            forceStripImageNetwork(img);
            makeUnlockableA11y(img, 'image');
            observeLocked(img);
            return;
        }
        if (isNearVideoPoster(img)) {
            markProcessed(img, true);
            silenceAsIgnored(img);
            forceStripImageNetwork(img);
            return;
        }
        const itemPk = pkFromIgCacheKey(img.dataset[DS.src] || img.getAttribute('src') || '');
        if (itemPk) {
            const slide = carouselSlideOf(img);
            const root = slide || (img.closest && img.closest('article, [role="dialog"], [aria-modal="true"]'));
            const imgs = root && root.querySelectorAll ? root.querySelectorAll('img') : [];
            let clone = false;
            for (let i = 0; i < imgs.length; i++) {
                if (imgs[i] === img) continue;
                if (pkFromIgCacheKey(storedSrcOf(imgs[i])) === itemPk) {
                    clone = true;
                    break;
                }
            }
            if (clone) {
                silenceAsIgnored(img);
                stripA11y(img);
                forceStripImageNetwork(img);
                try { img.style.setProperty('pointer-events', 'none', 'important'); } catch (_) { /* ignore */ }
                return;
            }
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
        else if (el.tagName === 'LINK' && isMediaPreloadLink(el)) neutralizePreloadLink(el);
    }

    function shortcodeFromNode(root) {
        if (!root) return '';
        if (root.tagName === 'A') {
            const direct = parsePostHref(root.getAttribute('href') || root.href);
            if (direct) return direct.code;
        }
        const links = root.querySelectorAll ? root.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]') : [];
        for (let i = 0; i < links.length; i++) {
            const parsed = parsePostHref(links[i].getAttribute('href') || links[i].href);
            if (parsed) return parsed.code;
        }
        const route = currentRouteCode();
        if (route && (root === document.body || (root.closest && root.closest('[role="dialog"], [aria-modal="true"]')))) {
            return route.code;
        }
        return route && root === document.documentElement ? route.code : '';
    }
    function storedSrcOf(el) {
        if (!el) return '';
        return (el.dataset && el.dataset[DS.src]) || el.currentSrc || el.getAttribute('src') || '';
    }
    function pkFromNode(root) {
        if (!root || !root.querySelectorAll) return '';
        const imgs = root.querySelectorAll('img');
        for (let i = 0; i < imgs.length; i++) {
            const pk = pkFromIgCacheKey(storedSrcOf(imgs[i]));
            if (pk) return pk;
        }
        return '';
    }
    function findMediaRoot(el) {
        if (!el || !el.closest) return el;
        return el.closest('article') ||
            el.closest('[role="dialog"], [aria-modal="true"]') ||
            el.closest('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]') ||
            el;
    }
    function videoCount(node) {
        if (!node) return 0;
        let n = node.tagName === 'VIDEO' ? 1 : 0;
        if (node.querySelectorAll) n += node.querySelectorAll('video').length;
        return n;
    }
    function findPlayRoot(el) {
        if (!el || !el.closest) return el;
        const slide = carouselSlideOf(el);
        if (slide) return slide;
        const article = el.closest('article');
        if (article) return article;
        const dialog = el.closest('[role="dialog"], [aria-modal="true"]');
        if (dialog) return dialog;
        let curr = el;
        for (let i = 0; i < 10 && curr && curr.parentElement; i++) {
            const parent = curr.parentElement;
            if (parent === document.body || parent === document.documentElement) return curr;
            const pVids = videoCount(parent);
            const cVids = videoCount(curr);
            if (pVids > Math.max(cVids, 1) && cVids >= 1) return curr;
            curr = parent;
        }
        return curr;
    }

    function isContentMedia(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.tagName === 'VIDEO') return getState(el) !== STATE_IGNORED;
        if (el.tagName !== 'IMG') return false;
        if (getState(el) === STATE_IGNORED) return false;
        if (shouldIgnoreImage(el)) return false;
        return true;
    }
    function contentMediaInRoot(root) {
        if (!root || !root.querySelectorAll) return [];
        const list = root.querySelectorAll('img, video');
        const out = [];
        for (let i = 0; i < list.length; i++) {
            if (isContentMedia(list[i])) out.push(list[i]);
        }
        return out;
    }
    function isCarouselMediaLi(li) {
        if (!li || li.tagName !== 'LI') return false;
        return !!li.querySelector('img, video');
    }
    function carouselMediaIndex(el) {
        const slide = carouselSlideOf(el);
        if (!slide || !slide.parentElement) return -1;
        const kids = slide.parentElement.children;
        let idx = 0;
        for (let i = 0; i < kids.length; i++) {
            if (!isCarouselMediaLi(kids[i])) continue;
            if (kids[i] === slide) return idx;
            idx++;
        }
        return -1;
    }
    function itemPkForElement(el) {
        let pk = pkFromIgCacheKey(storedSrcOf(el));
        if (pk) return pk;
        if (!el || el.tagName !== 'VIDEO') return '';
        const slide = carouselSlideOf(el);
        const scope = slide || el.parentElement;
        if (!scope || !scope.querySelectorAll) return '';
        const imgs = scope.querySelectorAll('img');
        for (let i = 0; i < imgs.length; i++) {
            pk = pkFromIgCacheKey(storedSrcOf(imgs[i]));
            if (pk) return pk;
        }
        return '';
    }
    function graphqlFileFor(el) {
        const root = findMediaRoot(el);
        const code = shortcodeFromNode(root) || (currentRouteCode() && currentRouteCode().code) || '';
        const pk = pkFromNode(root) || pkFromIgCacheKey(storedSrcOf(el));
        const rec = lookupPost(code, pk);
        if (!rec || !rec.files || !rec.files.length) return null;
        const want = el.tagName === 'VIDEO' ? 'video' : 'image';
        const slide = carouselSlideOf(el);
        let slideCount = 0;
        if (slide && slide.parentElement) {
            const kids = slide.parentElement.children;
            for (let i = 0; i < kids.length; i++) {
                if (isCarouselMediaLi(kids[i])) slideCount++;
            }
        }
        return pickHarvestFile(rec, {
            want,
            itemPk: itemPkForElement(el),
            slideIdx: carouselMediaIndex(el),
            slideCount
        });
    }

    function restorePictureSources(img) {
        const picture = img.closest && img.closest('picture');
        if (!picture) return;
        const sources = picture.querySelectorAll('source');
        for (let i = 0; i < sources.length; i++) {
            const source = sources[i];
            source._igPdUnlocking = true;
            try {
                if (source.dataset[DS.srcset]) source.srcset = source.dataset[DS.srcset];
                if (source.dataset[DS.src]) source.src = source.dataset[DS.src];
            } finally {
                source._igPdUnlocking = false;
            }
        }
    }
    function unlockImage(img, silent) {
        if (!img || img.tagName !== 'IMG') return;
        setState(img, silent ? STATE_IGNORED : STATE_UNLOCKED);
        markProcessed(img, true);
        delete img.dataset[DS.managed];
        unobserve(img);
        stripA11y(img);
        try { img.style.removeProperty('pointer-events'); } catch (_) { /* ignore */ }
        const gql = silent ? null : graphqlFileFor(img);
        const exact = img.dataset[DS.src] || '';
        const src = (!silent && gql && gql.url) ? gql.url : exact;
        if (src) rememberAllowedImage(src);
        if (exact) rememberAllowedImage(exact);
        withUnlocking(img, () => {
            try {
                // GraphQL candidate 自己有 oh/oe；DOM 原 URL 唔好改 stp，唔係 CDN 403。
                if (!silent && gql && gql.url) {
                    try { img.removeAttribute('srcset'); } catch (_) { /* ignore */ }
                    img.src = gql.url;
                } else {
                    restorePictureSources(img);
                    if (exact) img.src = exact;
                    if (img.dataset[DS.srcset]) img.srcset = img.dataset[DS.srcset];
                }
            } catch (err) {
                log('unlockImage error', err);
            }
        });
        if (!silent) {
            stats.unlockedImg++;
            log('unlocked image', gql && gql.url ? 'graphql' : 'stored');
        }
        refreshLoadAllButton();
    }
    function videoHasLiveMediaSource(video) {
        if (!video) return false;
        try {
            if (video.srcObject) return true;
        } catch (_) { /* ignore */ }
        let live = '';
        try { live = video.getAttribute('src') || ''; } catch (_) { /* ignore */ }
        return isBlobUrl(live);
    }
    function mediaSourceOf(video) {
        if (!video) return null;
        try {
            const src = video.getAttribute('src') || '';
            if (isBlobUrl(src) && mseByBlobUrl.has(src)) return mseByBlobUrl.get(src);
        } catch (_) { /* ignore */ }
        return null;
    }
    function videoMseIsDead(video) {
        const ms = mediaSourceOf(video);
        if (ms) {
            try {
                if (ms.readyState === 'closed') return true;
            } catch (_) { /* ignore */ }
        }
        try {
            if (video.error) return true;
        } catch (_) { /* ignore */ }
        return false;
    }
    function kickPlay(video) {
        try {
            const p = flushHeldPlay(video);
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) { /* autoplay policy */ }
    }
    function mutePosterClicks(img) {
        if (!img || img.tagName !== 'IMG') return;
        silenceAsIgnored(img);
        stripA11y(img);
        try { img.style.setProperty('pointer-events', 'none', 'important'); } catch (_) { /* ignore */ }
    }
    function syncVideoSurface(video) {
        if (!video || video.tagName !== 'VIDEO') return;
        try {
            if (video.readyState >= 2) delete video.dataset.igPdEmpty;
            else video.dataset.igPdEmpty = '1';
        } catch (_) { /* ignore */ }
    }
    function hookVideoSurface(video) {
        if (!video || video._igPdSurfaceHook) return;
        video._igPdSurfaceHook = true;
        const onReady = () => syncVideoSurface(video);
        try {
            video.addEventListener('loadeddata', onReady);
            video.addEventListener('canplay', onReady);
            video.addEventListener('playing', onReady);
            video.addEventListener('error', onReady);
        } catch (_) { /* ignore */ }
    }
    function recoverDeferredVideo(video) {
        if (!video) return;
        hookVideoSurface(video);
        syncVideoSurface(video);
        kickPlay(video);
        setTimeout(() => {
            if (!video || !video.isConnected) return;
            if (video.readyState >= 2) {
                syncVideoSurface(video);
                return;
            }
            log('video stalled, fallback progressive');
            if (!attachProgressiveMp4(video)) {
                try { video.load(); } catch (_) { /* ignore */ }
                kickPlay(video);
            }
            syncVideoSurface(video);
        }, GATE.mseFallbackMs);
    }
    function attachProgressiveMp4(video) {
        const gql = graphqlFileFor(video);
        const url = gql && gql.kind === 'video' ? gql.url : '';
        if (!url) return false;
        rememberAllowedVideo(url);
        video._igPdKeepProgressive = true;
        withUnlocking(video, () => {
            try {
                try { video.srcObject = null; } catch (_) { /* ignore */ }
                video.src = url;
                try { video.load(); } catch (_) { /* ignore */ }
            } catch (err) {
                log('progressive mp4 error', err);
            }
        });
        kickPlay(video);
        return true;
    }
    function unlockVideo(video) {
        if (!video || video.tagName !== 'VIDEO') return;
        if (isUnlocked(video)) {
            if (videoHasLiveMediaSource(video) && !videoMseIsDead(video)) {
                allowVideoNetworkTemporarily(video);
            }
            kickPlay(video);
            return;
        }
        setState(video, STATE_UNLOCKED);
        markProcessed(video, true);
        delete video.dataset[DS.managed];
        unobserve(video);
        stripA11y(video);
        markVideoLockOverlay(video, false);
        rememberUnlockedVideo(video);
        hookVideoSurface(video);
        syncVideoSurface(video);
        const mseDead = videoMseIsDead(video);
        const useMse = videoHasLiveMediaSource(video) && !mseDead;
        if (useMse) {
            allowVideoNetworkTemporarily(video);
        } else {
            const gql = graphqlFileFor(video);
            const url = gql && gql.kind === 'video' ? gql.url : '';
            if (url) allowVideoNetworkTemporarily(video, { progressiveUrl: url });
            else allowVideoNetworkTemporarily(video);
        }
        withUnlocking(video, () => {
            try {
                const sources = video.querySelectorAll('source');
                for (let i = 0; i < sources.length; i++) {
                    const source = sources[i];
                    source._igPdUnlocking = true;
                    try {
                        if (source.dataset[DS.srcset]) source.srcset = source.dataset[DS.srcset];
                        if (source.dataset[DS.src]) source.src = source.dataset[DS.src];
                    } finally {
                        source._igPdUnlocking = false;
                    }
                }
                if (mseDead || !useMse) {
                    // 鎖定時冇 attach blob；優先 GraphQL muxed mp4，否則先俾回 blob／srcObject
                    if (!attachProgressiveMp4(video)) {
                        const src = video.dataset[DS.src] || '';
                        if (isBlobUrl(src)) {
                            video.src = src;
                            try { video.load(); } catch (_) { /* ignore */ }
                        } else if (src && !isDataUrl(src) && !isPlaceholder(src)) {
                            video.src = src;
                            try { video.load(); } catch (_) { /* ignore */ }
                        } else if (video._igPdSrcObject) {
                            video.srcObject = video._igPdSrcObject;
                        }
                    }
                } else if (!video.srcObject && video._igPdSrcObject) {
                    video.srcObject = video._igPdSrcObject;
                }
                if (video.dataset[DS.poster]) video.poster = video.dataset[DS.poster];
            } catch (err) {
                log('unlockVideo error', err);
            }
        });
        video._igPdBlockPause = true;
        // pointerdown 手勢入面同步 play，唔好淨係 rAF（會丟 user activation）
        kickPlay(video);
        requestAnimationFrame(() => kickPlay(video));
        setTimeout(() => {
            if (video) video._igPdBlockPause = false;
        }, GATE.pauseBlockMs);
        setTimeout(() => {
            if (!video || !video.isConnected || !isUnlocked(video)) return;
            if (video.readyState >= 2) return;
            if (useMse || videoMseIsDead(video)) {
                log('mse stalled, fallback progressive');
                attachProgressiveMp4(video);
            }
        }, GATE.mseFallbackMs);
        stats.unlockedVideo++;
        log('unlocked video', mseDead ? 'progressive-fallback' : (useMse ? 'mse' : 'progressive-gql'));
        refreshLoadAllButton();
    }
    function videoBeside(el) {
        if (!el) return null;
        if (el.tagName === 'VIDEO') return el;
        const slide = carouselSlideOf(el);
        let curr = el;
        for (let i = 0; i < 5 && curr && curr !== document.body; i++) {
            if (curr.tagName === 'VIDEO') return curr;
            if (curr.querySelector) {
                const v = curr.querySelector(':scope > video, :scope > * > video');
                if (v && (!slide || slide.contains(v))) return v;
            }
            if (slide && (curr === slide || curr === slide.parentElement)) break;
            if (curr.tagName === 'UL') break;
            if (curr.tagName === 'ARTICLE' || (curr.getAttribute && curr.getAttribute('role') === 'dialog')) {
                break;
            }
            curr = curr.parentElement;
        }
        return null;
    }
    function clipVideoInRoot(root, fromEl) {
        if (fromEl && fromEl.tagName === 'VIDEO') return fromEl;
        const slide = carouselSlideOf(fromEl) || (root && root.tagName === 'LI' ? root : null);
        if (fromEl && fromEl.tagName === 'IMG') {
            if (slide) {
                const v = slide.querySelector('video');
                return (v && isNearVideoPoster(fromEl)) ? v : null;
            }
            const near = videoBeside(fromEl);
            if (near) return near;
            if (!isNearVideoPoster(fromEl)) return null;
        }
        const near = videoBeside(fromEl);
        if (near) return near;
        if (fromEl && fromEl.tagName === 'IMG' && !isNearVideoPoster(fromEl)) return null;
        if (!root || !root.querySelectorAll) return null;
        const vids = root.querySelectorAll('video');
        if (vids.length === 1) return vids[0];
        return null;
    }
    function unlockPlayRoot(fromEl) {
        const root = findPlayRoot(fromEl);
        const video = clipVideoInRoot(root, fromEl);
        if (video) {
            unlockVideo(video);
            const slide = carouselSlideOf(video);
            if (fromEl && fromEl.tagName === 'IMG' && (!slide || slide.contains(fromEl))) {
                mutePosterClicks(fromEl);
            }
            const scope = slide || video.parentElement;
            const imgs = scope && scope.querySelectorAll ? scope.querySelectorAll('img') : [];
            for (let j = 0; j < imgs.length; j++) {
                if (getState(imgs[j]) === STATE_IGNORED) continue;
                if (shouldIgnoreImage(imgs[j])) continue;
                if (isNearVideoPoster(imgs[j])) mutePosterClicks(imgs[j]);
            }
            return root;
        }
        if (fromEl && fromEl.tagName === 'IMG') unlockImage(fromEl, false);
        return root;
    }
    function unlockElement(el) {
        if (!el) return;
        if (el.tagName === 'VIDEO' || el.tagName === 'IMG') unlockPlayRoot(el);
    }
    function unlockAllVisible() {
        pruneVisible();
        const seenPk = new Set();
        const list = Array.from(visibleLocked);
        for (let i = 0; i < list.length; i++) {
            const el = list[i];
            if (el.tagName === 'IMG') {
                const pk = pkFromIgCacheKey(storedSrcOf(el));
                if (pk) {
                    if (seenPk.has(pk)) continue;
                    seenPk.add(pk);
                }
            }
            unlockElement(el);
        }
        log('unlock all visible', list.length);
    }
    function loadPost(code) {
        const rec = lookupPost(code, code);
        if (!rec) return 0;
        let n = 0;
        const roots = document.querySelectorAll('article, [role="dialog"], [aria-modal="true"]');
        for (let i = 0; i < roots.length; i++) {
            const root = roots[i];
            const sc = shortcodeFromNode(root);
            const pk = pkFromNode(root);
            if (sc !== rec.code && pk !== rec.pk && sc !== code && pk !== code) continue;
            const media = root.querySelectorAll('img, video');
            for (let j = 0; j < media.length; j++) {
                if (isLocked(media[j])) {
                    unlockElement(media[j]);
                    n++;
                }
            }
        }
        return n;
    }

    let loadAllBtn = null;
    function ensureLoadAllButton() {
        if (loadAllBtn || !document.documentElement) return;
        loadAllBtn = document.createElement('button');
        loadAllBtn.type = 'button';
        loadAllBtn.id = 'instagram-post-download-load-all';
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
        loadAllBtn.textContent = `載入可見媒體（${n}）`;
    }

    let isSwallowing = false;
    let swallowRoot = null;
    let swallowTimer = null;
    function clearSwallow() {
        isSwallowing = false;
        swallowRoot = null;
        if (swallowTimer != null) {
            clearTimeout(swallowTimer);
            swallowTimer = null;
        }
    }
    function beginSwallow(root) {
        let scoped = root && root.nodeType === 1 ? root : null;
        try {
            if (scoped) {
                const r = scoped.getBoundingClientRect();
                const vw = window.innerWidth || 0;
                const vh = window.innerHeight || 0;
                if (vw && vh && r.width > vw * 0.95 && r.height > vh * 0.95) scoped = null;
            }
        } catch (_) { /* ignore */ }
        isSwallowing = !!scoped;
        swallowRoot = scoped;
        if (swallowTimer != null) clearTimeout(swallowTimer);
        if (!scoped) return;
        swallowTimer = setTimeout(clearSwallow, GATE.swallowTimeoutMs);
    }
    function inSwallowRoot(target) {
        if (!swallowRoot || !target) return false;
        try {
            if (swallowRoot === target) return true;
            return !!(swallowRoot.contains && swallowRoot.contains(target));
        } catch (_) {
            return false;
        }
    }
    function findLockedFromPoint(x, y) {
        let stack;
        try { stack = document.elementsFromPoint(x, y); } catch (_) { stack = []; }
        let lockedVideo = null;
        let lockedImg = null;
        let unlockedVideoEl = null;
        for (let i = 0; i < stack.length; i++) {
            const el = stack[i];
            if (!el || el.nodeType !== 1) continue;
            if (el.id === 'instagram-post-download-load-all') return null;
            if (el.tagName === 'VIDEO') {
                if (isUnlocked(el)) unlockedVideoEl = unlockedVideoEl || el;
                else if (isLocked(el) && !lockedVideo) lockedVideo = el;
                continue;
            }
            if (el.tagName === 'IMG') {
                if (isLocked(el) && !lockedImg) lockedImg = el;
                else if (
                    !lockedImg &&
                    getState(el) === STATE_IGNORED &&
                    carouselSlideOf(el) &&
                    !shouldIgnoreImage(el) &&
                    !isNearVideoPoster(el)
                ) {
                    lockedImg = el;
                }
                continue;
            }
            if (el.dataset && el.dataset.igPdVideoLock === '1') {
                const v = el.querySelector && el.querySelector('video');
                if (v && isUnlocked(v)) unlockedVideoEl = unlockedVideoEl || v;
                else if (v && isLocked(v) && !lockedVideo) lockedVideo = v;
            }
        }
        if (unlockedVideoEl && lockedImg) {
            const imgSlide = carouselSlideOf(lockedImg);
            const vidSlide = carouselSlideOf(unlockedVideoEl);
            if (imgSlide && imgSlide !== vidSlide) return lockedImg;
            return null;
        }
        if (unlockedVideoEl) return null;
        return lockedVideo || lockedImg;
    }
    function isPrimaryPointer(e) {
        if (e.pointerType === 'touch' || e.pointerType === 'pen') return true;
        if (e.button == null) return true;
        return e.button === 0;
    }
    function onPointerDown(e) {
        if (!e.isTrusted) return;
        if (!isPrimaryPointer(e)) return;
        if (e.target && e.target.closest && e.target.closest('#instagram-post-download-load-all')) return;
        // 同 detox：下一手勢先清 swallow，唔好食「載入之後再撳播放」
        if (isSwallowing) clearSwallow();
        const x = e.clientX;
        const y = e.clientY;
        if (x == null || y == null) return;
        const hit = findLockedFromPoint(x, y);
        if (!hit) return;
        const root = unlockPlayRoot(hit);
        beginSwallow(root && root.nodeType === 1 ? root : hit);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }
    function onSwallowable(e) {
        if (!e.isTrusted) return;
        if (!isPrimaryPointer(e)) return;
        if (!isSwallowing || !swallowRoot) return;
        if (!inSwallowRoot(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.type === 'click' || e.type === 'dblclick') clearSwallow();
    }
    function onKeyActivate(e) {
        if (!e.isTrusted) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const t = e.target;
        if (!t || (t.tagName !== 'IMG' && t.tagName !== 'VIDEO')) return;
        if (!isLocked(t) && !(t.tagName === 'IMG' && videoBeside(t))) return;
        e.preventDefault();
        e.stopPropagation();
        const root = unlockPlayRoot(t);
        beginSwallow(root && root.nodeType === 1 ? root : t);
    }
    window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: false });
    ['pointerup', 'click', 'dblclick', 'touchend'].forEach((evt) => {
        window.addEventListener(evt, onSwallowable, { capture: true, passive: false });
    });
    window.addEventListener('keydown', onKeyActivate, { capture: true });

    function queueNode(node) {
        if (!node || node.nodeType !== 1) return;
        if (node.tagName === 'SCRIPT') harvestInlineScripts(node.parentNode || document);
        hideIgPlaybackErrorInNode(node);
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
        harvestInlineScripts(document);
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
            if (m.type !== 'childList') continue;
            const nodes = m.addedNodes;
            for (let j = 0; j < nodes.length; j++) queueNode(nodes[j]);
        }
        if (pending.size) scheduleFlush();
    });
    function hookHistory() {
        const proto = typeof History !== 'undefined' ? History.prototype : history;
        ['pushState', 'replaceState'].forEach((name) => {
            wrapMethod(proto, name, (native) => function (...args) {
                const ret = native.apply(this, args);
                scanAll();
                return ret;
            });
        });
        window.addEventListener('popstate', scanAll);
    }
    function start() {
        injectStyle();
        harvestInlineScripts(document);
        try {
            observer.observe(document.documentElement || document, { childList: true, subtree: true });
        } catch (err) {
            log('observe failed', err);
        }
        hookHistory();
        ensureLoadAllButton();
        scanAll();
    }

    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            injectStyle();
            ensureLoadAllButton();
            harvestInlineScripts(document);
            scanAll();
        }, { once: true });
    } else {
        ensureLoadAllButton();
        harvestInlineScripts(document);
        scanAll();
    }

    try {
        Object.defineProperty(window, 'InstagramPostDownload', {
            configurable: true,
            enumerable: false,
            get() {
                const uniq = listPosts();
                return {
                    version: VERSION,
                    config: { ...CONFIG, ...GATE },
                    stats: {
                        ...stats,
                        cached: uniq.length,
                        visibleLocked: visibleLocked.size,
                        deferredVideo: pendingVideoFetches.length,
                        deferredDropped: stats.deferredDropped
                    },
                    posts: uniq,
                    filesFor(code) {
                        const rec = lookupPost(code, code);
                        return rec ? rec.files.slice() : [];
                    },
                    load(code) {
                        return loadPost(code);
                    },
                    loadVisible() {
                        unlockAllVisible();
                    }
                };
            }
        });
    } catch (_) { /* ignore */ }

    log('initialized', { skipAds: CONFIG.skipAds, gate: GATE });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
