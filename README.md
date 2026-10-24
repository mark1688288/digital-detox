# digital-detox

Userscripts that stop Instagram and Threads from auto-downloading post photos and videos. Media stays locked until you tap it (or use **Load visible media**).

Profile pictures, small icons, and UI assets still load. Stories and in-app dialogs / lightboxes are left alone by default.

<img width="688" height="384" alt="Engineering_Digital_Autonomy_-_Slide_1" src="https://github.com/user-attachments/assets/45e02cfb-5455-44c2-a7c3-99c5f63f88c6" />

## The Scientific & Legal Context

Modern social media platforms are not neutral utilities; they are intentionally engineered to induce behavioral addiction. This is not merely a theoretical claim—it is now a matter of documented legal and scientific record:
* **The Legal Precedent**: In landmark lawsuits such as the multi-state action against Meta (e.g., *Case 4:23-cv-05448* filed by dozens of U.S. Attorneys General [[1](#references)]) and the historic *K.G.M. v. Meta* bellwether trial [[2](#references)], courts have focused strictly on **"defective product design choices"** rather than the content itself [[2](#references)]. Features like infinite scrolling and algorithmic recommendations are legally challenged as intentionally addictive design architecture [[2](#references)].
* **The Slot Machine Effect**: Platforms exploit **Variable Reward Schedules**—the exact same psychological mechanism that makes slot machines addictive. When you pull to refresh or scroll down, you do not know if the next piece of content will be dull or highly stimulating. This unpredictability triggers a burst of **dopamine** (the brain's anticipation-of-reward chemical) before the content even loads, locking you into a compulsive "feedback loop" of infinite scrolling.

<img width="688" height="384" alt="Engineering_Digital_Autonomy_-_Slide_4" src="https://github.com/user-attachments/assets/85793312-4a09-4d64-8da3-ad4f589dda01" />


## How This Tool Reverses the Addiction Loop

This JavaScript tool intervenes directly at the point of data interaction, reversing the platform's exploitative design through two main technical interventions:

### 1. From Passive "Push" to Conscious "Pull"
* **The Platform's Design**: Social media uses **infinite scrolling** and **lazy-loading** to seamlessly stream media into your eyes, eliminating all natural "stopping cues" [[1](#references)]. **Autoplay** forces sensory stimulation onto your brain before you can consciously choose to look away [[1](#references)].
* **Our Intervention**: The script intercepts lazy-loading images and completely disables video autoplay.
* **The Result**: Media is no longer "pushed" to you. To view an image or watch a video, you must **actively and consciously click to load** that specific piece of media. 

### 2. Introducing "Cognitive Friction"
* **System 1 vs. System 2 Thinking**: Fast, compulsive social media browsing relies on **System 1** (automatic, low-effort, subconscious) thinking.
* **Our Intervention**: By requiring an explicit click to load each image or video, this script injects **cognitive friction**—a brief, intentional delay.
* **The Result**: This pause disrupts the automatic reflex loop. It forces your brain to engage **System 2** (reflective, analytical, high-effort) thinking. The brief moment of friction gives your prefrontal cortex the critical window of time it needs to ask: *"Do I actually want to spend my attention on this?"*

<img width="688" height="384" alt="The_JavaScript_Addiction_Patch_-_Slide_5" src="https://github.com/user-attachments/assets/fdfd8589-25de-45a4-976f-d7c812a76177" />
<img width="688" height="384" alt="The_JavaScript_Addiction_Patch_-_Slide_6" src="https://github.com/user-attachments/assets/ab345759-f851-493b-bc2b-ec88c77a80f4" />

## Scripts

| File | Platform | Site |
| --- | --- | --- |
| [`instagram-detox-reworked.js`](instagram-detox-reworked.js) | Desktop (Tampermonkey) | instagram.com |
| [`ios/instagram-detox-reworked-ios.js`](ios/instagram-detox-reworked-ios.js) | iPhone Safari + Tampermonkey | Instagram |
| [`threads-detox.js`](threads-detox.js) | Desktop (Tampermonkey) | threads.com / threads.net |
| [`ios/threads-detox-ios.js`](ios/threads-detox-ios.js) | iPhone Safari + Tampermonkey | Threads |

Do **not** run more than one Instagram script at a time, and do **not** run both Threads desktop and iOS scripts in the same browser. They hook the same `fetch` / media APIs and will fight each other.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari).
2. Open the raw script you want:
   - Instagram (desktop): [instagram-detox-reworked.js](https://raw.githubusercontent.com/mark1688288/digital-detox/main/instagram-detox-reworked.js)
   - Instagram (iOS): [ios/instagram-detox-reworked-ios.js](https://raw.githubusercontent.com/mark1688288/digital-detox/main/ios/instagram-detox-reworked-ios.js)
   - Threads (desktop): [threads-detox.js](https://raw.githubusercontent.com/mark1688288/digital-detox/main/threads-detox.js)
   - Threads (iOS): [ios/threads-detox-ios.js](https://raw.githubusercontent.com/mark1688288/digital-detox/main/ios/threads-detox-ios.js)
3. Tampermonkey > Utilities > Import from URL > paste the script url and click **Install**. Confirm.

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

## Demo

![workflow](imgs/demo.gif)

## References

The scientific and legal claims cited in this document are grounded in official court filings and documented public reports:

* **[1] Case 4:23-cv-05448 (US District Court, N.D. California)**: *Complaint for Injunctive and Other Relief* filed by the State Attorneys General on October 24, 2023. Hosted on California Department of Justice ([CA.gov](https://oag.ca.gov)). View the official news coverage of the filing on [The Guardian](https://www.theguardian.com/technology/2023/nov/27/meta-instagram-facebook-kids-addicted-lawsuit).
* **[2] K.G.M. v. Meta et al.**: The historic bellwether case where a jury awarded $6M over negligent product design. Read the details on [Wikipedia](https://en.wikipedia.org/wiki/K.G.M._v._Meta_et_al.).
