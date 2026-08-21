# digital-detox

Userscripts that stop Instagram and Threads from auto-downloading post photos and videos. Media stays locked until you tap it (or use **Load visible media**).

Profile pictures, small icons, and UI assets still load. Stories and in-app dialogs / lightboxes are left alone by default.

## Scripts

| File | Platform | Site |
| --- | --- | --- |
| [`instagram-detox-reworked.js`](instagram-detox-reworked.js) | Desktop (Tampermonkey) | [instagram.com](https://www.instagram.com/) |
| [`ios/instagram-detox-reworked-ios.js`](ios/instagram-detox-reworked-ios.js) | iPhone Safari + Tampermonkey | Instagram |
| [`threads-detox.js`](threads-detox.js) | Desktop (Tampermonkey) | [threads.com](https://www.threads.com/) / [threads.net](https://www.threads.net/) |
| [`ios/threads-detox-ios.js`](ios/threads-detox-ios.js) | iPhone Safari + Tampermonkey | Threads |

Do **not** run more than one Instagram script at a time, and do **not** run both Threads desktop and iOS scripts in the same browser. They hook the same `fetch` / media APIs and will fight each other.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari).
2. Open the raw script you want:
   - Instagram (desktop): [instagram-detox-reworked.js](https://raw.githubusercontent.com/mark1688288/digital-detox/main/instagram-detox-reworked.js)
   - Instagram (iOS): [ios/instagram-detox-reworked-ios.js](https://raw.githubusercontent.com/mark1688288/digital-detox/main/ios/instagram-detox-reworked-ios.js)
   - Threads (desktop): [threads-detox.js](https://raw.githubusercontent.com/mark1688288/digital-detox/main/threads-detox.js)
   - Threads (iOS): [ios/threads-detox-ios.js](https://raw.githubusercontent.com/mark1688288/digital-detox/main/ios/threads-detox-ios.js)
3. Tampermonkey should prompt **Install**. Confirm.

On iPhone, use Safari + Tampermonkey. The iOS scripts are built for touch: a tap loads media; a scroll is not treated as a tap. Videos unlock with `playsinline` so iOS does not force fullscreen.

## Use

- Feed photos and videos show a placeholder until you click / tap them.
- A floating **Load visible media** button appears when locked items are on screen; it unlocks everything currently in view.
- Clicking a post to open the lightbox, or opening Stories, still loads that viewer normally.

Instagram videos stay paused at the player. The first click unlocks the stream (muxed MP4 when DASH cannot start). Carousel albums unlock one slide at a time.

## Debug

In the site’s console:

```js
localStorage.setItem('instagram_postDownload_debug', '1')  // Instagram
localStorage.setItem('threads_stopMediaLoader_debug', '1') // Threads (desktop + iOS)
```

Reload the tab. Verbose logs go to `console.debug`.

On Instagram, `window.InstagramPostDownload` exposes version, stats, harvested posts, `loadVisible()`, and `load(shortcode)`.

## How it works (short)

Scripts run at `document-start` in the page (`@grant none` on desktop, `@grant unsafeWindow` on iOS, `@sandbox raw`). They:

- Intercept `img` / `video` `src` so content media never hits the CDN until unlock
- Return empty responses for content image fetches; **defer** (do not 204) video / DASH fetches so the Instagram player does not error-loop
- Ignore avatars (`s150x150`, `/v/t51.*-19/`), `static.cdninstagram.com`, and other UI assets
- Harvest GraphQL `image_versions2` / `video_versions` so unlock can request the original still or muxed MP4

## Development

```bash
npm test
```

Harvest / URL helpers in `instagram-detox-reworked.js` also run under Node (`createHarvest`). MIT licensed — see [LICENSE](LICENSE).
