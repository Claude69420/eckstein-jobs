# Eckstein Jobs: Liquid Glass Reskin, Design Brief (v2, critic-corrected, 2026-09-25)

**Scope:** This brief covers the reskin of the vanilla HTML/CSS/JS Leaflet PWA (`C:/Users/Riley/eckstein-jobs`, deployed on GitHub Pages at `https://claude69420.github.io/eckstein-jobs/`). There is no build step and no framework. The primary target is the iPhone Home Screen app (WebKit, standalone mode); desktop Chrome/Edge on Windows is secondary. The brief also covers the new 6-stage job tracker, the Client | Stage filter mode, and one-click routing from the shop.

**Read this with `APP_MASTER.md`.** The file `C:/Users/Riley/eckstein-jobs/APP_MASTER.md` is the single source of truth. Its §4.3 lists the DOM ids, §5 holds "Stage data" (the canonical keys and store shape), §11 R-1 holds the requirements, the open questions Q1–Q10 and the planner prerequisites, and §12 is the CHANGELOG. When this brief and APP_MASTER disagree, APP_MASTER wins. The exception is a rule this brief explicitly amends, and every amendment must be logged in APP_MASTER in the same commit.

**Tags:**
- [A] = Apple guidance
- [C] = community or press source
- [D] = our own design decision
- [M] = measured by us on 2026-09-25
- [Q#] = depends on Riley's answer to APP_MASTER §11 question #

Every factual claim links to a source. The Sources list marks the ones the critic re-checked on 2026-09-25.

---

## 0. Decisions at a glance

1. **The glass material is adapted from `sohumsuthar/liquid-glass`** (`css/liquid-glass-core.css`, MIT, commit `fb0e2dd`, 2026-08-28). We collapse it to one element plus two pseudo-elements. It is pure CSS and needs no React ([repo](https://github.com/sohumsuthar/liquid-glass)).
2. **The iPhone gets no refraction.**
   - `backdrop-filter: url(#svg)` renders only in Chromium ([kube.io](https://kube.io/blog/liquid-glass-css-svg/)).
   - WebKit bug 245510 is still NEW. Its implementation, PR 68614, is still open: last activity 2026-09-20, with prerequisite PR 68613 and follow-up PR 69566 ([245510](https://bugs.webkit.org/show_bug.cgi?id=245510), [PR 68614](https://github.com/WebKit/WebKit/pull/68614)).
   - The Safari 27.0 notes (published 2026-09-17) do not mention backdrop-filter ([Safari 27.0](https://webkit.org/blog/18325/webkit-features-for-safari-27-0/)).
   - On iPhone, the "liquid" look comes from blur, saturation, tint, the specular rim, bezel shine, grain and spring motion.
3. **Refraction is desktop Chromium only.** We vendor `VII-Cae/hyalite--liquid-glass` v0.5.0 unmodified (MIT, commit `b9f2719`, 51,559 bytes). It applies to the side panel and the map-controls capsule only, behind a JS engine gate ([hyalite](https://github.com/VII-Cae/hyalite--liquid-glass)).
4. **Glass goes on the navigation layer only.** That means the map controls, the filter accessory, the tab bar, the sheets or panel, the desktop map card and the toast. Pins, list rows, chips, the segmented control and the slider use flat fills. There is never glass on glass [A] ([HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials), [WWDC25-219](https://developer.apple.com/videos/play/wwdc2025/219/)).
5. **Only the Regular variant is used, with no Clear variant. Each view has at most one control with a coloured background:** Route in the filter bar, and Directions in the detail sheet.
   - A selected chip gets a neutral high-contrast fill. Its colour lives in its dot, because HIG asks you to keep colour off the backgrounds of multiple controls [A] ([HIG Color](https://developer.apple.com/design/human-interface-guidelines/color)).
6. **iPhone layout:**
   - The full-bleed map is the existing `#jmap`.
   - A top-trailing control capsule holds three buttons: locate, reload (`#rf`) and settings.
   - A filter **accessory** sits above a **floating tab bar** (`#tabs`: **Jobs · Routes · Plan**, the three existing views).
   - The accessory expands into a **sheet** (medium, then large and opaque).
   - Tapping a pin or row opens a **detail sheet** with a 6-stop stage slider.
7. **Desktop layout (≥ 900 px):**
   - The same sheet becomes an inset glass panel on the leading (left) edge. Today the list is on the right, so this is a [D] change for Riley to confirm.
   - Hovering a pin opens a glass map card with a compact slider.
8. **Status bar:**
   - Drop `black-translucent`, use `default`, and keep `viewport-fit=cover`.
   - `theme-color` is set dynamically to the map canvas: `#EFEFEF` light, `#474749` dark [M].
   - The icon must be re-added to the Home Screen after this change ([vcsudoku PR 38](https://github.com/tmshv/vcsudoku/pull/38), [airtag-sentry PR 23](https://github.com/mariusgassen/airtag-sentry/pull/23)).
9. **Dark mode swaps tile layers** to Esri Dark Gray Canvas. There is no CSS invert.
10. **Stage persistence goes through the `StageStore` adapter (APP_MASTER R-1).**
    - Version 1 is device-only `localStorage['ej_stages']`.
    - The shared backend is Riley's decision [Q1].
    - A Home Screen app does not share storage with Safari, so any edit token must be pasted inside the installed app ([WebKit 181849](https://bugs.webkit.org/show_bug.cgi?id=181849)).
    - A token is never put in a URL.
11. **Two separate merges to `main`** (APP_MASTER rule):
    - **A = reskin + layout + single-map planner**
    - **B = stages**
    Either one can be reverted alone.
12. **DOM ids stay stable (APP_MASTER §4.3):**
    - Kept: `#jmap`, `#tabs` (`data-v` = `jobs|routes|plan`), `#chips`, `#q`, `#jlist`, `#upd`, `#rf`, `#v-jobs`, `#v-routes`, `#v-plan`, `#rlist` and every planner id.
    - Retired: **`#pmap` only**. The planner now draws on `#jmap`, and this is logged as an ADR.

---

## 1. Reference repos, license obligations, what we borrow

### 1.1 Base material: sohumsuthar/liquid-glass (MIT, "Copyright (c) 2026 Sohum Suthar")

**Repo status:** 2 stars, last commit `fb0e2dd` on 2026-08-28. The README reports a calibration of `glass_L = 0.58·backdrop_L + 34`. The default upstream variant is "clear"; `.lg-regular` is the frosted variant ([README](https://github.com/sohumsuthar/liquid-glass)).

**What we take** (values checked in the [core CSS](https://raw.githubusercontent.com/sohumsuthar/liquid-glass/main/css/liquid-glass-core.css)):
- **Regular variant:**
  - Backdrop filter: blur 10px, saturate 172%, brightness .67, contrast 1.02.
  - Tint: dark `rgba(255,255,255,.134)`, light `rgba(248,248,250,.66)`.
  - We do not use the clear variant (6px / 143% / .75).
- **Measured vertical-axis specular ring:**
  - Rim weights: lit .33 / dark .36 in dark mode, lit 1 / dark .30 in light mode.
  - Geometry: hold 1px, fade 15px, side 6px.
  - The ring is cut with `mask-composite`.
- **Fresnel shine insets** `inset 0 ±16px 16px -16px`: alphas .75/.60 in light mode and .30/.30 in dark mode.
- **Grain concept:**
  - Upstream uses opacity .035 with `soft-light` in dark mode and .05 with `multiply` in light mode.
  - [D] We bake .05 opacity into the SVG and drop blend modes, so the grain can live in `background`.
- **Easings:** `cubic-bezier(.32,.72,0,1)` (apple-out) and `cubic-bezier(.34,1.56,.64,1)` (magnetic).
- **Reduced-transparency tints:** `rgba(28,28,32,.85)` dark and `rgba(250,250,252,.9)` light, with saturate 120%. Upstream's RT blur is 24px; we cap it at 16px [D].
- **Backdrop-root warning:** the following on an ancestor leaves a nested backdrop-filter with nothing to sample: isolation, paint containment, content-visibility, transform, opacity < 1, mask, will-change. Upstream measured the survival of a striped backdrop at 69% versus 1.2%.

**Changes we make:**
- (a) Collapse upstream's 4-layer DOM into one element plus `::before` (rim) and `::after` (glow). Tint and grain move into `background`.
- (b) Put **literal** values on both the prefixed and unprefixed backdrop-filter lines, never `var()`. Evidence that `-webkit-backdrop-filter` ignores custom properties:
  - an open MDN BCD report against Safari 18.3 ([BCD #25914](https://github.com/mdn/browser-compat-data/issues/25914));
  - WebKit bug 289800, filed against WebKitGTK ([289800](https://bugs.webkit.org/show_bug.cgi?id=289800)).
  The evidence is mixed, so treat this as a defensive rule.
- (c) Set **light-mode brightness to 1.0.** Upstream says its light mode has no reference capture, and .67 greys a light map.
- (d) Drop upstream's SVG refraction. Upstream applies it via `filter` on an inner layer and already disables it on `(hover:none),(pointer:coarse)`.
- (e) Drop the conic "travelling highlight" and the hover glow.
- (f) Cap the reduced-transparency blur at 16px.

### 1.2 Desktop enhancement: VII-Cae/hyalite--liquid-glass v0.5.0 (MIT, "Copyright (c) 2026 VII-Cae (VII)")

**What it is:** one vanilla file, `hyalite.js`, with no build step. Pinned at commit `b9f27192a7256bf5295bf027b582b86864f9b59d` (2026-09-11), 51,559 bytes, `sha256-W9bgoiNDjtup/m/Q6ljco7usmk8/pvKWlkdPOgUPKew=` [M].

**How it works:**
- It builds a per-element displacement map, feeds it into `feDisplacementMap`, and exposes the result as `--hyalite`.
- It writes a CSS rim to `--hyalite-edge`.
- Both are **inherited** custom properties, so consume them only on the attached element.

**API:**
- `Hyalite.watch(container, selector, opts) → {stop}`. Several watchers can coexist.
- `Hyalite.unwatch()` stops every watcher.
- `attach(el, opts)`, `detach(el)` and `refresh(el)` (forces a rebuild).
- `setOpts(opts) → Promise`, `info()`, `supported()`, `force(true|false|null)`, `DEFAULTS`.

**Engine gate:**
- `supported()` requires `CSS.supports('backdrop-filter','url(#x)')` **and** a Chromium brand in `navigator.userAgentData`. The fallback is `/Chrome\/\d+/` in the UA plus a vendor of "Google Inc".
- It is false on every iOS browser, including CriOS (whose UA says `CriOS/` and whose vendor is Apple).
- It writes nothing when unsupported.
- `<html data-hyalite="force">` or `Hyalite.force(true)` turns it on when WebKit ships support ([hyalite](https://github.com/VII-Cae/hyalite--liquid-glass), source read 2026-09-25).

**Gotchas:**
- Its maps are `data:` URLs, so a strict CSP needs `img-src data:`.
- `edge: 0` writes `none` into `--hyalite-edge`, which would invalidate our comma-separated `box-shadow` list. **Never pass `edge: 0`.**
- It honours `prefers-reduced-motion`.
- Its README advises a modest number of glass surfaces.

We use it **unmodified** on the `.lens-panel` and `.lens-ctl` elements (at most two visible at once).

### 1.3 Ideas only: rdev/liquid-glass-react (MIT, "Copyright 2025 MAX ROVENSKY")

- This is probably the repo Riley means (about 6.3k stars).
- It is React-only, which ADR-14 rules out.
- Its README says displacement is not visible in Safari or Firefox ([repo](https://github.com/rdev/liquid-glass-react)).
- We borrow only the *idea* of a masked gradient ring and a soft white-text shadow. **We copy no code.**

### 1.4 Not used (reasons not re-verified unless marked)

| Repo | Reason |
|---|---|
| shuding/liquid-glass | Demo that depends on `backdrop-filter:url()` ([repo](https://github.com/shuding/liquid-glass)) |
| deepika-builds/liquid-glass | Superseded by hyalite ([repo](https://github.com/deepika-builds/liquid-glass)) |
| samasante/liquid-glass | React; refracts only the DOM it wraps ([repo](https://github.com/samasante/liquid-glass)) |
| naughtyduk/liquidGL (MIT) | Snapshot/WebGL. It ignores `position:fixed` elements, and Safari can be unstable when the element covers more than 50% of the viewport (checked) ([liquidGL](https://github.com/naughtyduk/liquidGL)). It cannot follow a live Leaflet map |
| dashersw/liquid-glass-js | WebGL snapshot ([repo](https://github.com/dashersw/liquid-glass-js)) |
| AndrewPrifer/liquid-dom, iyinchao/liquid-glass-studio | WebGPU / React studio ([liquid-dom](https://github.com/AndrewPrifer/liquid-dom), [studio](https://github.com/iyinchao/liquid-glass-studio)) |
| lucasromerodb/liquid-glass-effect-macos, archisvaze/liquid-glass | **No license. Copy nothing** ([lucas](https://github.com/lucasromerodb/liquid-glass-effect-macos), [archisvaze](https://github.com/archisvaze/liquid-glass)) |

### 1.5 License obligations

MIT requires the copyright notice and the permission notice in "all copies or substantial portions".

1. **`css/glass.css`** (adapted from sohumsuthar): the file header must carry the full MIT text below with `Copyright (c) 2026 Sohum Suthar`, the upstream commit `fb0e2dd`, and a one-line list of our modifications. Upstream's CSS file has no header of its own, so our header is the notice.
2. **`vendor/hyalite.js`**: ship it byte-for-byte and keep its `/*! … MIT © 2026 VII-Cae (VII) */` banner.
   - Also ship **`vendor/hyalite.LICENSE`** as a verbatim copy of upstream's `LICENSE` file (it exists at the pinned commit), rather than a retyped version.
   - Record the commit SHA and sha256 in APP_MASTER.
3. **rdev:** no code is copied, so there is no obligation. If any code is ever copied, add its MIT notice (`Copyright 2025 MAX ROVENSKY`).
4. **Leaflet 1.9.4 (BSD-2)** is loaded from the CDN file, which keeps its own notice. Keep Leaflet's attribution prefix.
5. **Esri tiles** carry terms-of-use and attribution duties (§7).
6. Record all of the above in **APP_MASTER** under "Third-party code", and reference it from Settings → About.

```text
MIT License

Copyright (c) 2026 Sohum Suthar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.6 Why nothing refracts the map on iPhone (for APP_MASTER)

- **Safari accepts `backdrop-filter:url()` but does not render the SVG part.** `CSS.supports` still says yes, so only engine sniffing works ([hyalite source](https://github.com/VII-Cae/hyalite--liquid-glass), [WebKit 245510](https://bugs.webkit.org/show_bug.cgi?id=245510)).
- **The pending WebKit fix would not help a panned map.** It is a software fallback, and its own notes say an accelerated-moved backdrop only updates when the element repaints ([PR 68614](https://github.com/WebKit/WebKit/pull/68614)).
- **Apple's native glass is private.** `-apple-visual-effect` needs a private WKWebView preference and does not work on the web ([alastair.is](https://alastair.is/apple-has-a-private-css-property-to-add-liquid-glass-effects-to-web-content/)).
- **The other iOS options don't fit a live map.** `filter:url()` on wrapped DOM and WebGL snapshots cannot track a panning map with cross-origin tiles ([samasante BROWSERS.md](https://github.com/samasante/liquid-glass/blob/main/BROWSERS.md), [liquidGL](https://github.com/naughtyduk/liquidGL)).
- **The CSS-only look still matches iOS 27's direction.** iOS 27 brought more diffusion, a darkened edge and brighter specular highlights, plus a transparency slider in Settings ([MacRumors](https://www.macrumors.com/2026/06/10/how-liquid-glass-is-changing-in-ios-27/)).

---

## 2. Layout blueprint

### 2.1 Rules that shape every screen

- **Glass is the navigation layer; content never is.** Content means the map, pins, list rows and planner rows.
  - HIG's one exception: a transient control such as a slider takes on glass **while a person is using it** [A] ([HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials)).
- **No glass on glass.** Inside glass, use fills, transparency and vibrancy [A] ([WWDC25-219](https://developer.apple.com/videos/play/wwdc2025/219/)).
- **Toolbars:** aim for at most 3 groups, and one prominent action on the trailing side [A] ([HIG Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)). Here that action is the Route button.
- **Colour:** apply it sparingly to glass. Put it on the *background* of the primary action only, and don't colour the backgrounds of multiple controls [A] ([HIG Color](https://developer.apple.com/design/human-interface-guidelines/color)).
- **Hit targets** are at least 44×44 px ([HIG Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)).
- **Every glass surface is a direct child of `<body>` and a sibling above `#jmap`.**
  - Any backdrop-root property on an ancestor breaks sampling (§1.1).
  - `filter`, `backdrop-filter`, `transform` and `will-change` on an ancestor also re-anchor `position:fixed` descendants ([MDN containing block](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_display/Containing_block)).
  - Safari 26.0 made `filter` establish that containing block as well ([Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)).
- **The old `<style>` block in `index.html` is deleted, not layered on.** Its `.chip`, `.chips`, `.card`, `.btn`, `.search`, `.dot`, `.pin` and `.row` rules collide with this brief's classes.
  - Job markers are renamed `.jpin`.
  - Route-stop markers are renamed `.rpin`.

### 2.2 iPhone (primary)

```
+----------------------------------------+  status bar: style "default", theme-color = map canvas
|                                  +----+ |
|                                  | L  | |  #ctl .map-controls (glass--sm capsule, 52w)
|        full-bleed Leaflet #jmap  | R  | |   L locate · R reload (#rf) · S settings
|        (100dvh, z 0)             | S  | |
|                                  +----+ |
|      pins: solid dots (stage mode: 1-6 digit)
|  attribution (10px above accessory) -> |
| +------------------------------------+ |
| | [Client|Stage]  7 jobs   [Route 7] | |  #accessory .accessory (glass, r28) = collapsed sheet
| | (All 49)(o Crown 12)(o Harris 9) ->| |   #chips scroll horizontally
| +------------------------------------+ |
| +------------------------------------+ |
| |   Jobs        Routes        Plan   | |  #tabs .tabbar (glass--sm capsule, 62h)
| +------------------------------------+ |
+----------------------------------------+
```

**Glass surfaces:**
- At rest: controls, accessory and tab bar (3).
- Sheet at medium: controls and sheet (2).
- Sheet at large: 0 blurs (the sheet is opaque and the controls are hidden).
- The toast is transient.
- This stays within the 3–5 simultaneous-blur budget for mobile [C] ([openreplay](https://blog.openreplay.com/creating-blurred-backgrounds-css-backdrop-filter/)).

**Geometry [D]:**
- **Horizontal inset:** 16px for every floating element. Apple's iOS 26 tab bar sits 21pt from the edges [C] ([LearnUI](https://www.learnui.design/blog/ios-design-guidelines-templates.html)); we take 16px for chip width.
- **Tab bar:**
  - Height 62px [D]. There is no Apple-published figure; a developer's iOS 26 custom bar uses 62pt ([Apple forums](https://developer.apple.com/forums/thread/796299)).
  - `bottom: max(16px, env(safe-area-inset-bottom) − 13px)`. That gives 21px with a 34px inset, and 16px where standalone reports a 0 inset, which has been observed ([Coffee-SNOB PR 7](https://github.com/ethan8damax/Coffee-SNOB/pull/7)).
- **Accessory:** 8px above the tab bar. Its height is measured by JS into `--acc-h` (about 116px).
- **Controls capsule:** top `max(12px, safe-top + 8px)`.

**States and detents.** HIG uses medium and large detents, and tapping the grabber cycles between them [A] ([HIG Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)). iOS 26 partial sheets are inset glass; a full-height sheet becomes opaque and anchors to the screen edge [A] ([WWDC25-323](https://developer.apple.com/videos/play/wwdc2025/323/)).

| State | What shows | Map |
|---|---|---|
| **Collapsed** (default) | Accessory + tab bar | Fully interactive |
| **Medium** (~52% height) | Sheet with side inset 8px, top radius 32, glass. The header has a title, `#upd`, and ✕ (collapse). In the Jobs view it also holds `#filterbar` and `#q`. Accessory and tab bar are hidden | Interactive above the sheet, no dimming |
| **Large** (top at safe-top + 10) | Full width, top radius 38, **opaque**, no backdrop-filter. Controls capsule hidden | 18% scrim; tapping it returns to medium |

**Sheet behaviours:**
- **Expand:**
  - Tap the accessory's empty area or swipe up on it: opens the Jobs view.
  - Tap a tab: opens that view at medium.
  - Tap the settings button: opens Settings at large.
  - The sheet starts at the accessory's top edge and springs up, so the accessory appears to grow into it [D].
- **Collapse:** drag down past medium, or tap ✕. HIG says to support swipe-to-dismiss [A] ([HIG Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)).
- **Grabber:** tapping the header (outside controls) cycles medium and large.
- **Search:** focusing `#q` goes to **large**. Keyboard padding comes from `visualViewport`, because iOS supports neither `interactive-widget` nor the VirtualKeyboard API ([caniuse interactive-widget](https://caniuse.com/mdn-html_elements_meta_name_viewport_interactive-widget)).

**Tab bar = the three existing views** (`#tabs`, `data-v` = `jobs`, `routes`, `plan`):
- Labels are **Jobs**, **Routes** and **Plan**: single words with filled symbols [A] ([HIG Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)).
- Tabs are for navigation, not actions [A].
- **Routes** is the published route-map list (`#rlist`, `routes/index.json`). **v1 dropped this view; it is restored.**
- **Plan** is the existing planner (`#v-plan` and its ids). Its result now draws on `#jmap` (§4.3), not on `#pmap`.
- **Settings** is not a tab. It opens from the capsule's settings button (desktop: from the panel header) and contains:
  - **Appearance:** Auto · Light · Dark.
  - **Glass:** Liquid · Tinted · Solid.
  - **Stages:** where they are saved, and the token field if [Q1] picks option (b) (§8).
  - **Data:** the `#upd` text; "Sync from Jobber now" (the existing GitHub Actions link, where Riley taps **Run workflow**).
  - **About:** third-party licenses (§1.5).

**Header status (`#upd`).** The old `#top` header is gone.
- `#upd` ("{mapped}/{total} mapped · updated {Mon D, h:mm}") moves under the sheet title.
- The accessory's `#count` shows "Loading…" or "Couldn't load" while those states last.
- The ↻ reload button keeps the id `#rf` and now sits in the capsule.

**Filter mode (Client | Stage):**
- A 2-segment capsule control, `#mode`; HIG allows about 5 segments on iPhone [A] ([HIG Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls)).
- **Client mode:**
  - Chips: All, then Crown, Harris, ACV, MyTec, No Limits and Other. Each chip has a client-colour dot and a count.
  - Pins are coloured by client and carry no digit.
- **Stage mode:**
  - Chips: All plus the 6 stages. Each chip has a stage-colour dot with a 1–6 digit and a count.
  - Pins are coloured by stage and show the digit.
- Colour is never the only signal ([HIG Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)). Several stage and client colours share hues (for example green = Poured and ACV). The digit keeps stage pins distinct; confirm this with Riley [Q5].
- **Selection is "solo, then add" [D]. This changes today's multi-toggle behaviour; confirm with Riley.**
  - Tapping a chip while All is active shows only that group.
  - Tapping further chips adds or removes them.
  - Removing the last one returns to All.
  - Each mode keeps its own selection in `localStorage['ej_filter']` (inside try/catch).
- **Moving a job's stage does not re-filter.** Counts update, and the job leaves the filtered set at the next filter change, so rows never vanish under the finger [D].

**One-click route:**
- The prominent **Route N** button in `#filterbar` routes the **currently filtered, mapped jobs from the shop** through the existing planner, then opens the Plan view at medium.
- In Stage mode with only "Base" selected, that is "all Base jobs from the shop" in one tap.
- The button is disabled when the filter is **All**.
- It is the only control in the view with a coloured background.
- Planner rules from APP_MASTER R-1 apply:
  - numbering `S`, then #1..n;
  - `~` estimates and "no live traffic";
  - Google Maps links of at most 10 points;
  - confirm above about 25 stops;
  - unmapped jobs are listed as "not included";
  - rural legs follow APP_MASTER's interim rule until [Q4].

**Moving a job between stages:**
- **Opening the detail sheet:**
  - Tap a pin or a list row to open the **detail sheet** `#detail` at medium.
  - The list sheet is hidden and restored to its previous detent when the detail sheet closes.
- **Keeping the pin in view:**
  - The map calls `panInside` so the pin stays visible above the sheet.
  - The pin gets `.is-selected` (outlined and scaled).
- **Detail contents:**
  - Title (street) and subtitle (client · #jobNumber · permit), plus unscheduled, pending and not-mapped tags. A ✕ sits on the trailing side.
  - **Stage card:** "● 3 · Base   Stage 3 of 6" above a **6-stop snapping slider**.
    - Six options exceed the segmented-control guidance.
    - HIG sliders fill the track between the minimum and the thumb [A] ([HIG Sliders](https://developer.apple.com/design/human-interface-guidelines/sliders)).
  - Actions:
    - **Directions** (prominent): Google Maps directions to the job; disabled if the job is unmapped.
    - **Add to Plan**: pushes `{name, lat, lon, jobNumber}` into the planner stops.
    - **Copy address**.
- **Slider interaction:**
  - **Input:** tap a stage label or any point on the track, or drag the thumb. The stage snaps on release with a bouncy spring.
  - **Lens:** while dragging, the thumb grows and becomes a lens that magnifies the track. This follows HIG's exception for transient controls taking on glass while in use [A] ([HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials)). It is built from a CSS clone, with no backdrop-filter.
  - **Saving:** the save is optimistic, and a toast reads "Moved to Base · Undo" for 5 s. On a save error the stage reverts and an error toast appears.
  - **Haptics:** there are none by default. `navigator.vibrate` is unsupported on iOS Safari through 27.x ([caniuse](https://caniuse.com/mdn-api_navigator_vibrate)).
    - *Optional [D]:* iOS 18+ gives a haptic tick when an `<input type=checkbox switch>` toggles ([Safari 18.0](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/)).
    - Hidden-switch tricks exist, but since iOS 18.4 they need a click within about 1 s ([ios-vibrator-pro-max](https://github.com/samdenty/ios-vibrator-pro-max)). Use it only on label taps, and treat it as fragile.
  - **Locked state:** if `StageStore.writable` is false, the slider is `aria-disabled` and shows "Stages are read-only on this device. Settings → Stages".

**Status bar and viewport:**
- `viewport-fit=cover`, and the app shell uses `100dvh`. `svh` was measured wrong in standalone mode ([sokosumi PR](https://github.com/masumi-network/sokosumi/pull/4666)).
- Status-bar style `default`, with `theme-color` set to the map canvas colour (§7). An opaque status bar shows the theme-color ([vcsudoku PR 38](https://github.com/tmshv/vcsudoku/pull/38)).
- **What this avoids:**
  - The iOS 26+ scroll-edge wash that appears under `black-translucent` ([vcsudoku PR 38](https://github.com/tmshv/vcsudoku/pull/38)).
  - The bottom-inset clipping reported with `black-translucent` ([airtag-sentry PR 23](https://github.com/mariusgassen/airtag-sentry/pull/23)).
- **Device check:** status-bar text must be legible in Dark theme. If it isn't, the fallback is `black`, the opaque black bar used by airtag-sentry.
- **Re-add the icon after this change.** The `apple-mobile-web-app-*` tags are fixed at install time ([airtag-sentry PR 23](https://github.com/mariusgassen/airtag-sentry/pull/23)).

**Map attribution:**
- Collapsed: 10px above the accessory's top edge, with 7px side padding.
- Medium: 10px above the sheet (JS sets `--attr-b`).
- Large: hidden under the opaque sheet.

### 2.3 Desktop (≥ 900 px, Chrome/Edge)

```
+----------------------------------------------------------------------+
| +-------------------------+                                 +----+  |
| | Jobs     [J][R][P][S]   |      #jmap (full-bleed)         | +  |  |
| | 49/53 mapped · 12:05    |                                 | -  |  |
| | [Client|Stage] [Route 7]|        +------------------+     | L  |  |
| | (chips wrap)            |        | 123 Main St      |     | R  |  |
| | [search...            ] |        | Crown · 3 Base   |     | S  |  |
| | rows...                 |        | o==o==o--.--.--. |     +----+  |
| +-------------------------+        +--------v---------+     .lens-ctl
|  #sheet .lens-panel (380w, inset 12, r24)   #map-card (glass)      |
+----------------------------------------------------------------------+
```

- **Side panel:** the same `#sheet` element, restyled as an inset glass sidebar. iOS 26 sidebars are inset Liquid Glass [A] ([WWDC25-356](https://developer.apple.com/videos/play/wwdc2025/356/)). It is always visible.
  - The tab bar and accessory are hidden.
  - The header has the view title plus icon buttons: Jobs · Routes · Plan · Settings.
  - `#filterbar` lives in the Jobs view header, and its chips wrap.
- **Detail view:** `#detail` takes the same frame. The list panel is `hidden` while it is open; ✕ acts as Back.
- **Hover card:**
  - Hovering a pin opens a glass **map card** after 120 ms. It shows the street, client and a **compact slider** (track only, stage name above).
  - It stays open while the pointer is over the pin or the card, with a 250 ms grace period. That grace period covers the gap APP_MASTER R-1 warned about.
  - Hover is bound only when `(hover: hover) and (pointer: fine)` matches, **not** by width. Otherwise an iPad or a touch laptop would get hover cards from simulated mouse events.
- **Clicks:** clicking a pin pins the card, selects the row and scrolls to it. Clicking a row opens the detail view.
- **Map controls:** zoom +/−, locate, reload (`#rf`) and settings. The map is created with `zoomControl:false`.
- **fitBounds padding:** left 404px, so the panel never covers jobs.
- **Glass surfaces:** panel, controls and hover card (3). The first two get hyalite refraction (§5.3).

### 2.4 DOM skeleton (z-order: map 0 · card 30 · controls 40 · accessory/tabbar 50 · scrim 55 · sheets 60 · toast 70)

```html
<body>
  <div id="jmap" aria-label="Job map"></div>

  <nav class="map-controls glass glass--sm lens-ctl" id="ctl" aria-label="Map controls">
    <button class="icon-btn pressable desktop-only" data-act="zoom-in"  aria-label="Zoom in">…</button>
    <button class="icon-btn pressable desktop-only" data-act="zoom-out" aria-label="Zoom out">…</button>
    <button class="icon-btn pressable" data-act="locate"   aria-label="My location">…</button>
    <button class="icon-btn pressable" id="rf"             aria-label="Reload latest data">…</button>
    <button class="icon-btn pressable" data-act="settings" aria-label="Settings">…</button>
  </nav>

  <div class="accessory glass" id="accessory">
    <div class="acc-slot">
      <div class="filterbar" id="filterbar">            <!-- JS moves this node between the accessory and the Jobs sheet head -->
        <div class="filterbar-row">
          <div class="seg" id="mode" role="radiogroup" aria-label="Filter by" style="--n:2;--i:0">
            <button type="button" class="pressable" role="radio" aria-checked="true"  data-mode="client">Client</button>
            <button type="button" class="pressable" role="radio" aria-checked="false" data-mode="stage">Stage</button>
            <span class="seg-thumb" aria-hidden="true"></span>
          </div>
          <span class="count" id="count" role="status">Loading…</span>
          <button type="button" class="btn btn--prominent pressable" id="routeSel" disabled>Route</button>
        </div>
        <div class="chips" id="chips" role="toolbar" aria-label="Filter">
          <button type="button" class="chip pressable" data-k="" aria-pressed="true">All <span class="n">49</span></button>
          <button type="button" class="chip pressable" data-k="base" aria-pressed="false">
            <span class="dot" style="--c:var(--stage-3)">3</span>Base <span class="n">7</span></button>
          <!-- … -->
        </div>
      </div>
    </div>
  </div>

  <nav class="tabbar glass glass--sm" id="tabs" role="tablist" aria-label="Views" style="--i:0">
    <span class="tab-blob" aria-hidden="true"></span>
    <button type="button" class="tab pressable on" role="tab" aria-selected="true"  data-v="jobs">…<span>Jobs</span></button>
    <button type="button" class="tab pressable"    role="tab" aria-selected="false" data-v="routes">…<span>Routes</span></button>
    <button type="button" class="tab pressable"    role="tab" aria-selected="false" data-v="plan">…<span>Plan</span></button>
  </nav>

  <div class="scrim" id="scrim"></div>

  <section class="sheet glass lens-panel" id="sheet" data-view="jobs" data-detent="closed" hidden aria-label="Jobs">
    <header class="sheet-head">
      <div class="grabber" aria-hidden="true"></div>
      <div class="sheet-top">
        <h2 class="sheet-title">Jobs</h2>
        <div class="panel-views desktop-only"><!-- icon-btns data-v: jobs, routes, plan, settings --></div>
        <button type="button" class="close-btn pressable phone-only" data-act="collapse" aria-label="Close">✕</button>
      </div>
      <div class="sheet-sub" id="upd">loading…</div>
      <!-- #filterbar lands here in the Jobs view (always on desktop; while open on iPhone) -->
      <input class="search" id="q" type="search" placeholder="Search address, client, permit, job #" enterkeyhint="search">
    </header>
    <div class="sheet-body">
      <div class="view on" id="v-jobs"><div class="job-list" id="jlist" role="list"></div></div>
      <div class="view" id="v-routes"><div id="rlist" class="muted"></div></div>
      <div class="view" id="v-plan"><!-- existing planner markup, ids unchanged: #stops #addr #addAddr #addShop #pickJob
           #clearStops #pickbox #fxs #fxe #rt #opt #pres (#plist, #saveR inside) #savedlist — #pmap removed --></div>
      <div class="view" id="v-settings"><!-- §2.2 Settings groups --></div>
    </div>
  </section>

  <section class="sheet glass lens-panel" id="detail" data-detent="closed" hidden aria-label="Job details">
    <header class="sheet-head">
      <div class="grabber" aria-hidden="true"></div>
      <div class="detail-head">
        <div><h2 class="detail-title">123 Main St</h2><p class="detail-sub">Crown Pipeline · #699 · Permit …</p></div>
        <button type="button" class="close-btn pressable" data-act="close-detail" aria-label="Close">✕</button>
      </div>
    </header>
    <div class="sheet-body">
      <div class="card">
        <div class="stage" role="slider" tabindex="0" aria-label="Job stage" aria-valuemin="1" aria-valuemax="6"
             aria-valuenow="1" aria-valuetext="Ready to start">
          <div class="stage-now"><span class="dot">1</span><span class="name">Ready to start</span><small>Stage 1 of 6</small></div>
          <div class="stage-track">
            <div class="stage-rail"></div><div class="stage-fill"></div>
            <i class="stage-tick" data-k="0" style="--k:0"></i><i class="stage-tick" data-k="1" style="--k:1"></i>
            <i class="stage-tick" data-k="2" style="--k:2"></i><i class="stage-tick" data-k="3" style="--k:3"></i>
            <i class="stage-tick" data-k="4" style="--k:4"></i><i class="stage-tick" data-k="5" style="--k:5"></i>
            <div class="stage-thumb"><div class="stage-lens" aria-hidden="true">
              <div class="stage-rail"></div><div class="stage-fill"></div><!-- same 6 .stage-tick with data-k --></div></div>
          </div>
          <ol class="stage-labels">
            <li><button type="button" data-k="0" style="--k:0">Ready</button></li><li><button type="button" data-k="1" style="--k:1">Excav.</button></li>
            <li><button type="button" data-k="2" style="--k:2">Base</button></li><li><button type="button" data-k="3" style="--k:3">Prep</button></li>
            <li><button type="button" data-k="4" style="--k:4">Passed</button></li><li><button type="button" data-k="5" style="--k:5">Poured</button></li>
          </ol>
        </div>
      </div>
      <div class="actions"><!-- Directions (btn--prominent), Add to Plan, Copy address --></div>
    </div>
  </section>

  <div class="map-card glass" id="map-card"><!-- .mc-title, .mc-sub, .stage.stage--compact (same inner markup, labels hidden) --></div>
  <div class="toast glass glass--sm" id="toast" role="status"><span class="msg"></span><button type="button" class="btn pressable">Undo</button></div>
</body>
```

### 2.5 Stage model (canonical keys from APP_MASTER §5; colours are [D] proposals pending [Q5])

| Order | Key (stored) | Label | Short | Glyph | Colour, light / dark ([HIG Color](https://developer.apple.com/design/human-interface-guidelines/color)) | Glyph ink |
|---|---|---|---|---|---|---|
| 0 | `ready` | Ready to start | Ready | 1 | Indigo 97,85,245 / 109,124,255 | white |
| 1 | `excavation` | Excavation | Excav. | 2 | Brown 172,127,94 / 183,138,102 | white |
| 2 | `base` | Base | Base | 3 | Orange 255,141,40 / 255,146,48 | white |
| 3 | `prep` | Prep | Prep | 4 | Yellow 255,204,0 / 255,214,0 | **black** |
| 4 | `inspected` | Passed inspection | Passed | 5 | Purple 203,48,224 / **219,52,242** | white |
| 5 | `poured` | Poured | Poured | 6 | Green 52,199,89 / 48,209,88 | white |

- The store and the code use **keys**, never numbers. The glyph is order + 1.
- A missing or unknown value means `ready`.
- The accent (Route, Directions, selected tab text) is Blue 0,136,255 / 0,145,255 and is never used for a stage.
- These colours replace APP_MASTER's placeholder column once Riley answers Q5. Record the choice there.

---

## 3. Token set: `css/tokens.css` (load first)

Backdrop-filter values are deliberately **not** tokens. They are literal in `glass.css` (§1.1 b).

```css
/* tokens.css — Eckstein Jobs Liquid Glass tokens. Light is default; dark via :root[data-theme="dark"]. */
:root{
  color-scheme: light;

  /* Canvas & text. Canvas = dominant colour of the Esri Light Gray Base tile z14/5560/3771 (Winnipeg) [M 2026-09-25] */
  --canvas:#EFEFEF;
  --label:#000;
  --on-label:#fff;                          /* text on a --label fill (selected chip) */
  --label-2:rgba(60,60,67,.60);
  --label-3:rgba(60,60,67,.30);
  --on-accent:#fff;

  /* Fills — used INSIDE glass (never glass-on-glass) [D: UIKit system-fill family] */
  --fill-1:rgba(120,120,128,.20);
  --fill-2:rgba(120,120,128,.16);
  --fill-3:rgba(118,118,128,.12);
  --fill-4:rgba(116,116,128,.08);
  --separator:rgba(60,60,67,.18);
  --seg-thumb:#fff;
  --knob:#fff;

  /* Colour (HIG iOS system colours) */
  --accent:rgb(0 136 255);
  --danger:rgb(255 56 60);
  --stage-1:rgb(97 85 245);    /* ready */
  --stage-2:rgb(172 127 94);   /* excavation */
  --stage-3:rgb(255 141 40);   /* base */
  --stage-4:rgb(255 204 0);    /* prep (black glyph) */
  --stage-5:rgb(203 48 224);   /* inspected */
  --stage-6:rgb(52 199 89);    /* poured */
  /* Client colours: same values as COL in index.html. A new client (APP_MASTER §7.8) is added here AND in COL. */
  --client-Crown:#2563eb; --client-Harris:#dc2626; --client-ACV:#16a34a;
  --client-MyTec:#7c3aed; --client-NoLimits:#0d9488; --client-Other:#f59e0b;
  --uns-ring:#b45309;          /* unscheduled (as today) */
  --pend-ring:#7c3aed;         /* pending 9000+ (as today) */
  --pin-ring:#fff;

  /* Glass paint */
  --glass-tint:rgba(250,250,252,.64);      /* large/regular surfaces */
  --glass-tint-sm:rgba(255,255,255,.52);   /* icon capsule, tab bar, toast */
  --glass-opaque:rgba(250,250,252,.97);    /* large sheet, Solid mode, no-support fallback */
  --glass-hc:#fff;                         /* Increase Contrast */
  --glass-shine:inset 0 16px 16px -16px rgba(255,255,255,.75), inset 0 -16px 16px -16px rgba(255,255,255,.60);
  --glass-edge:0 0 0 .5px rgba(0,0,0,.10); /* iOS 27 darkened edge */
  --glass-lift:0 2px 6px -2px rgba(0,0,0,.12), 0 10px 28px -8px rgba(0,0,0,.18);
  --glass-lift-sm:0 1px 3px rgba(0,0,0,.10), 0 6px 16px -6px rgba(0,0,0,.16);
  --glass-glow:rgba(255,255,255,.30);
  /* Specular ring geometry (sohumsuthar, light-mode weights) */
  --rim-lit:1; --rim-dark:.30; --rim-hold:1px; --rim-fade:15px; --rim-side:6px;
  --grain:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.05'/%3E%3C/svg%3E");
  --scrim:rgba(0,0,0,.18);

  /* Shape (concentric: inner = outer − padding, WWDC25-356) */
  --r-xs:8px; --r-sm:12px; --r-md:16px; --r-lg:24px; --r-acc:28px; --r-sheet:32px; --r-sheet-lg:38px; --r-pill:999px;

  /* Space & geometry */
  --s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px; --s-5:20px; --s-6:24px; --s-8:32px;
  --hit:44px;
  --inset:16px;
  --safe-t:env(safe-area-inset-top,0px);
  --safe-b:env(safe-area-inset-bottom,0px);
  --tabbar-h:62px;
  --tabbar-b:max(16px, calc(var(--safe-b) - 13px));
  --acc-h:116px;                           /* JS writes the measured accessory height inline on <html> */
  --attr-b:calc(var(--tabbar-b) + var(--tabbar-h) + 8px + var(--acc-h) + 10px);   /* JS overrides at medium */
  --sheet-top:max(10px, calc(var(--safe-t) + 10px));
  --panel-w:380px;

  /* Type (HIG iOS sizes) */
  --font:-apple-system, system-ui, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  --t-large:700 34px/41px var(--font);
  --t-title2:700 22px/28px var(--font);
  --t-title3:600 20px/25px var(--font);
  --t-headline:600 17px/22px var(--font);
  --t-body:400 17px/22px var(--font);
  --t-callout:400 16px/21px var(--font);
  --t-subhead:400 15px/20px var(--font);
  --t-subhead-em:600 15px/20px var(--font);
  --t-footnote:400 13px/18px var(--font);
  --t-caption:400 12px/16px var(--font);
  --t-caption-em:600 12px/16px var(--font);
  --t-tab:500 11px/13px var(--font);

  /* Motion */
  --ease-out:cubic-bezier(.32,.72,0,1);        /* sohumsuthar "apple-out" */
  --ease-magnetic:cubic-bezier(.34,1.56,.64,1);
  --ease-std:cubic-bezier(.4,0,.6,1);
  --ease-quick:cubic-bezier(.28,.11,.32,1);
  --spring-ios:linear(0, 0.021 2.5%, 0.074 5%, 0.147 7.5%, 0.496 17.5%, 0.648 22.5%, 0.712 25%, 0.817 30%, 0.892 35%, 0.944 40%, 0.987 47.5%, 1.008 57.5%, 1);
  --d-ios:760ms;      /* sheet detents */
  --spring-snappy:linear(0, 0.021 2.5%, 0.075 5%, 0.148 7.5%, 0.495 17.5%, 0.644 22.5%, 0.762 27.5%, 0.81 30%, 0.884 35%, 0.935 40%, 0.979 47.5%, 1.002 57.5%, 1.003 87.5%, 1);
  --d-snappy:490ms;   /* press release, segmented/tab thumbs, toast, map card */
  --spring-bouncy:linear(0, 0.029 2.5%, 0.103 5%, 0.204 7.5%, 0.55 15%, 0.653 17.5%, 0.745 20%, 0.823 22.5%, 0.887 25%, 0.938 27.5%, 0.977 30%, 1.006 32.5%, 1.037 37.5%, 1.046 42.5%, 1.032 52.5%, 1.003 70%, 0.999 97.5%, 1);
  --d-bouncy:820ms;   /* stage-slider snap only */
  --d-press:120ms;
}

:root[data-theme="dark"]{
  color-scheme: dark;
  --canvas:#474749;                          /* dominant Esri Dark Gray Base colour, same tile [M] */
  --label:#fff;
  --on-label:#000;
  --label-2:rgba(235,235,245,.70);
  --label-3:rgba(235,235,245,.30);
  --fill-1:rgba(120,120,128,.36);
  --fill-2:rgba(120,120,128,.32);
  --fill-3:rgba(118,118,128,.24);
  --fill-4:rgba(116,116,128,.18);
  --separator:rgba(84,84,88,.45);
  --seg-thumb:rgb(99 99 102);
  --accent:rgb(0 145 255);
  --danger:rgb(255 66 69);
  --stage-1:rgb(109 124 255);
  --stage-2:rgb(183 138 102);
  --stage-3:rgb(255 146 48);
  --stage-4:rgb(255 214 0);
  --stage-5:rgb(219 52 242);
  --stage-6:rgb(48 209 88);
  --glass-tint:rgba(255,255,255,.134);       /* sohumsuthar regular, dark */
  --glass-tint-sm:rgba(255,255,255,.134);
  --glass-opaque:rgba(28,28,30,.97);
  --glass-hc:#000;
  --glass-shine:inset 0 16px 16px -16px rgba(255,255,255,.30), inset 0 -16px 16px -16px rgba(255,255,255,.30);
  --glass-edge:0 0 0 .5px rgba(255,255,255,.06);
  --glass-lift:0 2px 6px -2px rgba(0,0,0,.30), 0 8px 24px -8px rgba(0,0,0,.40);
  --glass-lift-sm:0 1px 3px rgba(0,0,0,.30), 0 4px 12px -4px rgba(0,0,0,.35);
  --glass-glow:rgba(255,255,255,.12);
  --rim-lit:.33; --rim-dark:.36;
  --scrim:rgba(0,0,0,.32);
}

/* "Tinted" = the in-app equivalent of iOS 26.1's Tinted / Reduce Transparency: frostier, more opaque */
:root[data-glass="tinted"]{ --glass-tint:rgba(250,250,252,.90); --glass-tint-sm:rgba(250,250,252,.90); }
:root[data-theme="dark"][data-glass="tinted"]{ --glass-tint:rgba(28,28,32,.85); --glass-tint-sm:rgba(28,28,32,.85); }
```

**Where the values come from:**
- **Tints, rim, shine and reduced-transparency values:** [sohumsuthar core CSS](https://raw.githubusercontent.com/sohumsuthar/liquid-glass/main/css/liquid-glass-core.css).
- **System colours:** [HIG Color](https://developer.apple.com/design/human-interface-guidelines/color).
- **Darkened edge:** [MacRumors iOS 27](https://www.macrumors.com/2026/06/10/how-liquid-glass-is-changing-in-ios-27/).
- **Type:** [HIG Typography](https://developer.apple.com/design/human-interface-guidelines/typography).
- **Secondary text colours:** [LearnUI](https://www.learnui.design/blog/ios-design-guidelines-templates.html) [C].
- **Springs:**
  - The iOS default spring sampled into `linear()` ([Apple spring](https://developer.apple.com/documentation/swiftui/animation/spring(response:dampingfraction:blendduration:)), [WWDC23-10158](https://developer.apple.com/videos/play/wwdc2023/10158/)).
  - `linear()` works in Safari 17.2+ and Chrome 113+ ([caniuse](https://caniuse.com/mdn-css_types_easing-function_linear-function)).
- **Alphas:** Apple publishes no CSS numbers, so every alpha is a tuned approximation [D].

---

## 4. Component recipes

### 4.1 `css/glass.css`: the material (load second)

```css
/*! glass.css — Liquid Glass material for Eckstein Jobs.
 * Adapted from sohumsuthar/liquid-glass css/liquid-glass-core.css @ fb0e2dd — https://github.com/sohumsuthar/liquid-glass
 * [paste the full MIT text from brief §1.5 here, "Copyright (c) 2026 Sohum Suthar"]
 * Modifications: 4-layer DOM → one element + ::before/::after; literal backdrop-filter values; light-mode
 * brightness 1.0; SVG refraction removed (desktop refraction via vendor/hyalite.js); hover/conic highlight removed;
 * grain baked into background; reduced-transparency blur capped at 16px.
 *
 * FILE RULES
 * 1. Every selector = one class, optionally prefixed by :where(...). SOURCE ORDER IS PRECEDENCE. Don't add specificity.
 * 2. -webkit-backdrop-filter and backdrop-filter always carry IDENTICAL LITERAL values. Never var() inside them
 *    (only exception: block 10, which exists only on Chromium).
 * 3. Never put isolation, contain, content-visibility, filter, transform, opacity<1, mask, clip-path, mix-blend-mode
 *    or will-change on a .glass element's ANCESTORS, and never opacity<1 on .glass itself (backdrop-root rule).
 *    Transform on the .glass element itself is fine (sheets move with it).
 * 4. components.css owns geometry; this file owns material (background, backdrop-filter, box-shadow).
 */

/* 1 — Regular glass, light, large surfaces: accessory, sheets/panel, map card */
.glass{
  position:relative;
  border-radius:var(--r-lg);
  color:var(--label);
  background:var(--grain) 0 0 / 140px 140px, var(--glass-tint);
  -webkit-backdrop-filter:blur(16px) saturate(180%);
          backdrop-filter:blur(16px) saturate(180%);
  box-shadow:var(--glass-shine), var(--glass-edge), var(--glass-lift);
}
/* Specular ring — vertical-axis light: bright top/bottom hairline, dark flanks (sohumsuthar) */
.glass::before{
  content:""; position:absolute; inset:0; border-radius:inherit; padding:1px; pointer-events:none;
  background:
    linear-gradient(to right,
      rgba(0,0,0,var(--rim-dark)) 0, rgba(0,0,0,0) var(--rim-side),
      rgba(0,0,0,0) calc(100% - var(--rim-side)), rgba(0,0,0,var(--rim-dark)) 100%),
    linear-gradient(to bottom,
      rgba(255,255,255,var(--rim-lit)) 0, rgba(255,255,255,var(--rim-lit)) var(--rim-hold),
      rgba(255,255,255,0) var(--rim-fade), rgba(255,255,255,0) calc(100% - var(--rim-fade)),
      rgba(255,255,255,var(--rim-lit)) calc(100% - var(--rim-hold)), rgba(255,255,255,var(--rim-lit)) 100%);
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;
          mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
          mask-composite:exclude;
}
/* Self-illumination from the touch point (WWDC25-219) */
.glass::after{
  content:""; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
  background:radial-gradient(180px circle at var(--px,50%) var(--py,50%), var(--glass-glow), transparent 70%);
  opacity:0; transition:opacity 240ms var(--ease-out);
}
.is-lit::after{ opacity:1; transition-duration:var(--d-press); }

/* 2 — Regular glass, dark, large */
:where([data-theme="dark"]) .glass{
  -webkit-backdrop-filter:blur(16px) saturate(172%) brightness(.67) contrast(1.02);
          backdrop-filter:blur(16px) saturate(172%) brightness(.67) contrast(1.02);
}

/* 3 — Small glass, light: control capsule, tab bar, toast */
.glass--sm{
  background:var(--grain) 0 0 / 140px 140px, var(--glass-tint-sm);
  -webkit-backdrop-filter:blur(10px) saturate(180%) brightness(1.05);
          backdrop-filter:blur(10px) saturate(180%) brightness(1.05);
  box-shadow:var(--glass-shine), var(--glass-edge), var(--glass-lift-sm);
}

/* 4 — Small glass, dark */
:where([data-theme="dark"]) .glass--sm{
  -webkit-backdrop-filter:blur(10px) saturate(172%) brightness(.67) contrast(1.02);
          backdrop-filter:blur(10px) saturate(172%) brightness(.67) contrast(1.02);
}

/* 5 — Tinted mode (frostier; tint comes from tokens) */
:where([data-glass="tinted"]) .glass,
:where([data-glass="tinted"]) .glass--sm{
  -webkit-backdrop-filter:blur(16px) saturate(120%);
          backdrop-filter:blur(16px) saturate(120%);
}

/* 6 — Solid mode + fully expanded sheet (iOS 26: full-height sheet becomes opaque) */
:where([data-glass="solid"]) .glass,
:where([data-glass="solid"]) .glass--sm,
.is-opaque{
  background:var(--glass-opaque);
  -webkit-backdrop-filter:none;
          backdrop-filter:none;
}

/* 7 — No backdrop-filter support at all */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
  .glass, .glass--sm{ background:var(--glass-opaque); }
}

/* 8 — Increase Contrast: predominantly black/white with a contrasting border (WWDC25-219) */
@media (prefers-contrast: more){
  .glass, .glass--sm, .is-opaque{
    background:var(--glass-hc);
    -webkit-backdrop-filter:none;
            backdrop-filter:none;
    box-shadow:0 0 0 1.5px var(--label), var(--glass-lift-sm);
  }
  .glass::before{ display:none; }
}

/* 9 — Squircle corners where supported (Chromium 139+ only; Safari has no corner-shape).
      Capsules stay true semicircles. */
@supports (corner-shape: squircle){
  .glass:not(.glass--sm){ corner-shape:squircle; }
  .glass:not(.glass--sm)::before, .glass:not(.glass--sm)::after{ corner-shape:inherit; }
}

/* 10 — Desktop Chromium refraction (html.lg-refract is set by JS only when hyalite is live).
       Refracting elements go back to round corners: hyalite's map assumes circular radii. */
.lg-refract .lens-panel{
  corner-shape:round;
  -webkit-backdrop-filter:var(--hyalite, blur(16px)) saturate(180%);
          backdrop-filter:var(--hyalite, blur(16px)) saturate(180%);
  box-shadow:var(--hyalite-edge, 0 0 transparent), var(--glass-shine), var(--glass-edge), var(--glass-lift);
}
.lg-refract .lens-ctl{
  -webkit-backdrop-filter:var(--hyalite, blur(10px)) saturate(180%);
          backdrop-filter:var(--hyalite, blur(10px)) saturate(180%);
  box-shadow:var(--hyalite-edge, 0 0 transparent), var(--glass-shine), var(--glass-edge), var(--glass-lift-sm);
}
```

**Notes on block 10:**
- `var()` in `-webkit-backdrop-filter` is safe there, because `.lg-refract` only ever exists on Chromium.
- The `box-shadow` fallback is `0 0 transparent`, not `none`, because `none` inside a shadow list invalidates the whole declaration. For the same reason, never pass `edge:0` to hyalite (§1.2).
- The appended `saturate(180%)` keeps the centre matching the non-refracted look. hyalite's `sat` only touches the bevel ring. Verify it in DevTools, and if the lens disappears, drop the appended `saturate()`.
- `corner-shape` is Chromium 139+ ([squircle.js](https://squircle.js.org/blog/squircles-in-css)). `@supports` keeps Safari on plain `border-radius`.

### 4.2 `css/components.css`: geometry (load third)

```css
[hidden]{ display:none !important; }
html, body{ margin:0; height:100%; background:var(--canvas); color:var(--label); font:var(--t-body); -webkit-text-size-adjust:100%; }
body{ overflow:hidden; overscroll-behavior:none; -webkit-tap-highlight-color:transparent; }
button{ font:inherit; color:inherit; background:none; border:0; padding:0; cursor:pointer;
  touch-action:manipulation; -webkit-user-select:none; user-select:none; }
/* position:fixed + z-index:0 makes #jmap a stacking context that contains Leaflet's pane (200–700) and control (800/1000) z-indexes */
#jmap{ position:fixed; top:0; left:0; right:0; height:100dvh; z-index:0; background:var(--canvas); }
.desktop-only{ display:none; }
.view{ display:none; } .view.on{ display:block; }
.muted{ padding:12px 8px; font:var(--t-subhead); color:var(--label-2); }

/* ---------- Press: grows on press, then springs back ---------- */
.pressable{ transition:scale var(--d-snappy) var(--spring-snappy); }
.pressable.is-pressed{ scale:1.04; transition:scale var(--d-press) var(--ease-out); }

/* ---------- Pill button (fill-based; lives inside glass) ---------- */
.btn{ position:relative; display:inline-flex; align-items:center; justify-content:center; gap:6px;
  min-height:var(--hit); padding:0 16px; border-radius:var(--r-pill);
  background:var(--fill-2); color:var(--label); font:var(--t-subhead-em); white-space:nowrap; text-decoration:none; }
.btn svg{ width:18px; height:18px; fill:currentColor; }
.btn--prominent{ background:var(--accent); color:var(--on-accent); }
.btn:disabled, .btn[aria-disabled="true"]{ background:var(--fill-4); color:var(--label-3); cursor:default; }
.filterbar .btn{ min-height:36px; }
.filterbar .btn::after{ content:""; position:absolute; inset:-4px 0; } /* 44px hit */

/* ---------- Map controls capsule (glass glass--sm) ---------- */
.map-controls{ position:fixed; z-index:40; top:max(12px, calc(var(--safe-t) + 8px)); right:var(--inset);
  display:flex; flex-direction:column; gap:2px; padding:4px; border-radius:var(--r-pill); }
.icon-btn{ width:var(--hit); height:var(--hit); border-radius:50%; display:grid; place-items:center; color:var(--label); }
.icon-btn svg{ width:22px; height:22px; fill:currentColor; }

/* ---------- Accessory = collapsed sheet (glass) ---------- */
.accessory{ position:fixed; z-index:50; left:var(--inset); right:var(--inset);
  bottom:calc(var(--tabbar-b) + var(--tabbar-h) + 8px); border-radius:var(--r-acc); padding:8px 12px 12px;
  touch-action:none; }                              /* swipe-up is handled in JS; #chips overrides with pan-x */
.filterbar{ display:grid; gap:8px; }
.filterbar-row{ display:flex; align-items:center; gap:8px; min-height:var(--hit); }
.filterbar .count{ margin-left:auto; font:var(--t-footnote); color:var(--label-2); white-space:nowrap; font-variant-numeric:tabular-nums; }

/* ---------- Segmented control: Client | Stage (capsule, fill-based) ---------- */
.seg{ position:relative; display:grid; grid-auto-flow:column; grid-auto-columns:1fr; height:36px; padding:2px;
  border-radius:var(--r-pill); background:var(--fill-3); }
.seg > button{ position:relative; z-index:1; min-width:76px; padding:0 14px; border-radius:var(--r-pill);
  font:var(--t-subhead-em); color:var(--label); }
.seg > button::after{ content:""; position:absolute; inset:-4px 0; }
.seg-thumb{ position:absolute; z-index:0; top:2px; bottom:2px; left:2px; width:calc((100% - 4px) / var(--n));
  border-radius:var(--r-pill); background:var(--seg-thumb);
  box-shadow:0 3px 8px rgba(0,0,0,.12), 0 1px 1px rgba(0,0,0,.04), 0 0 0 .5px rgba(0,0,0,.04);
  translate:calc(100% * var(--i)) 0; transition:translate var(--d-snappy) var(--spring-snappy); }

/* ---------- Chips (fill-based; selected = neutral --label fill, colour stays in the dot) ---------- */
.chips{ display:flex; gap:8px; overflow-x:auto; scrollbar-width:none; margin:0 -12px; padding:4px 12px;
  touch-action:pan-x; overscroll-behavior-x:contain;
  -webkit-mask-image:linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 12px), transparent);
          mask-image:linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 12px), transparent); }
.chips::-webkit-scrollbar{ display:none; }
.chip{ flex:none; position:relative; display:inline-flex; align-items:center; gap:6px; height:36px; padding:0 12px 0 6px;
  border-radius:var(--r-pill); background:var(--fill-3); color:var(--label); font:var(--t-subhead-em); white-space:nowrap;
  transition:scale var(--d-snappy) var(--spring-snappy), background-color 200ms var(--ease-out), color 200ms var(--ease-out); }
.chip[data-k=""]{ padding-left:12px; }
.chip::after{ content:""; position:absolute; inset:-4px 0; }
.chip .dot{ width:24px; height:24px; line-height:24px; font-size:12px; box-shadow:0 0 0 1.5px var(--pin-ring); }
.chip .n{ font:var(--t-footnote); color:var(--label-2); font-variant-numeric:tabular-nums; }
.chip[aria-pressed="true"]{ background:var(--label); color:var(--on-label); }
.chip[aria-pressed="true"] .n{ color:inherit; opacity:.75; }

/* ---------- Tab bar (glass glass--sm) ---------- */
.tabbar{ position:fixed; z-index:50; left:var(--inset); right:var(--inset); bottom:var(--tabbar-b); height:var(--tabbar-h);
  box-sizing:border-box; padding:4px; border-radius:var(--r-pill); display:grid; grid-template-columns:repeat(3, 1fr); }
.tab{ position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px;
  border-radius:var(--r-pill); color:var(--label); font:var(--t-tab); }
.tab svg{ width:26px; height:26px; fill:currentColor; }
.tab[aria-selected="true"]{ color:var(--accent); }
.tab-blob{ position:absolute; z-index:0; top:4px; bottom:4px; left:4px; width:calc((100% - 8px) / 3);
  border-radius:var(--r-pill); background:var(--fill-3);
  translate:calc(100% * var(--i)) 0; transition:translate var(--d-snappy) var(--spring-snappy); }

/* ---------- Sheet (iPhone) / side panel (desktop) — glass lens-panel ---------- */
.sheet{
  --sheet-tr:transform var(--d-ios) var(--spring-ios), left 240ms var(--ease-quick), right 240ms var(--ease-quick),
             border-radius 240ms var(--ease-quick), background-color 240ms var(--ease-quick);
  position:fixed; z-index:60; top:var(--sheet-top); bottom:0; left:8px; right:8px;
  display:flex; flex-direction:column; overflow:hidden;
  border-radius:var(--r-sheet) var(--r-sheet) 0 0;
  transform:translate3d(0, var(--y, 100vh), 0);
  transition:var(--sheet-tr);
}
.sheet.is-dragging{ transition:none; will-change:transform; }
.sheet.is-large{ left:0; right:0; border-radius:var(--r-sheet-lg) var(--r-sheet-lg) 0 0; }
/* Go opaque first, drop the blur 240ms later (no sharp-map flash); leaving large restores blur instantly */
.sheet.is-opaque{ transition:var(--sheet-tr), -webkit-backdrop-filter 0s linear 240ms, backdrop-filter 0s linear 240ms; }
.sheet-head{ flex:none; padding:6px 16px 8px; touch-action:none; }
.grabber{ width:36px; height:5px; margin:0 auto 6px; border-radius:3px; background:var(--label-3); }
.sheet-top{ display:flex; align-items:center; gap:8px; min-height:36px; }
.sheet-title{ margin:0; font:var(--t-title3); }
.sheet-top .close-btn{ margin-left:auto; }
.sheet-sub{ font:var(--t-footnote); color:var(--label-2); margin:0 0 8px; }
.search{ display:block; width:100%; box-sizing:border-box; height:36px; margin-top:8px; padding:0 12px; border:0; border-radius:10px;
  background:var(--fill-3); color:var(--label); font:var(--t-body); -webkit-appearance:none; appearance:none; }
.sheet:not([data-view="jobs"]) .search{ display:none; }
.sheet-body{ flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; touch-action:pan-y;
  padding:0 8px calc(var(--hidden, 0px) + var(--kb, 0px) + var(--safe-b) + 16px);
  -webkit-mask-image:linear-gradient(to bottom, transparent 0, #000 12px);   /* scroll-edge effect; drop if it janks on device */
          mask-image:linear-gradient(to bottom, transparent 0, #000 12px); }
.scrim{ position:fixed; inset:0; z-index:55; background:var(--scrim); opacity:0; pointer-events:none;
  transition:opacity 240ms var(--ease-quick); }
.scrim.is-on{ opacity:1; pointer-events:auto; }

/* ---------- List (content: NO glass) ---------- */
.job-list{ margin:0; padding:0; }
.grp{ display:flex; align-items:center; gap:8px; padding:14px 8px 6px; font:var(--t-footnote); font-weight:600; color:var(--label-2); }
.job-row{ display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:12px; min-height:60px; padding:8px;
  border-radius:var(--r-sm); cursor:pointer; }
.job-row > div{ min-width:0; }
.job-row.is-selected{ background:var(--fill-3); }
@media (hover:hover){ .job-row:hover{ background:var(--fill-4); } }
.job-row .t{ font:var(--t-subhead-em); }
.job-row .s{ font:var(--t-footnote); color:var(--label-2); }
.job-row .t, .job-row .s{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dot{ display:inline-block; flex:none; width:22px; height:22px; border-radius:50%; background:var(--c);
  color:var(--on-c, #fff); font:700 11px/22px var(--font); text-align:center; }
.stage-badge{ display:inline-flex; align-items:center; height:24px; padding:0 9px; border-radius:var(--r-pill);
  font:var(--t-caption-em); color:var(--label); background:color-mix(in oklab, var(--c) 22%, transparent); }
.tag{ display:inline-block; margin-left:6px; padding:0 6px; border-radius:6px; font:var(--t-caption-em);
  background:var(--fill-3); color:var(--label-2); }
.tag.uns{ color:var(--uns-ring); } .tag.pend{ color:var(--pend-ring); }

/* ---------- Detail sheet ---------- */
.detail-head{ display:grid; grid-template-columns:1fr auto; align-items:start; gap:12px; }
.detail-title{ margin:0; font:var(--t-title3); }
.detail-sub{ margin:2px 0 0; font:var(--t-subhead); color:var(--label-2); }
.close-btn{ position:relative; width:30px; height:30px; border-radius:50%; background:var(--fill-2); color:var(--label-2);
  display:grid; place-items:center; }
.close-btn::after{ content:""; position:absolute; inset:-7px; }
.card{ display:block; margin:0 8px 12px; padding:12px 14px; border-radius:var(--r-md); background:var(--fill-4);
  color:var(--label); text-decoration:none; }                        /* 32 − 16 = 16 concentric */
.actions{ display:flex; gap:8px; padding:0 8px 12px; }
.actions .btn{ flex:1; }

/* ---------- Planner (existing ids; fills only) ---------- */
#v-plan .field{ display:flex; gap:8px; margin:8px 0; }
#v-plan input[type="text"], #v-plan input:not([type]){ flex:1; height:40px; padding:0 12px; border:0; border-radius:10px;
  background:var(--fill-3); color:var(--label); font:var(--t-body); -webkit-appearance:none; appearance:none; }
#stops{ list-style:none; margin:0; padding:0; }
#stops li{ display:flex; gap:8px; align-items:center; min-height:44px; padding:6px 8px; border-radius:var(--r-sm); background:var(--fill-4); margin-bottom:6px; }
#v-plan .opts{ display:flex; flex-wrap:wrap; gap:12px; font:var(--t-subhead); margin:8px 0; }
#v-plan input[type="checkbox"]{ width:22px; height:22px; accent-color:var(--accent); vertical-align:middle; }
#pres{ margin-top:10px; }
#pickbox{ max-height:220px; overflow:auto; border-radius:var(--r-sm); background:var(--fill-4); }

/* ---------- Stage slider: 6 discrete stops, lens thumb while dragging ---------- */
.stage{ --n:6; --p:0; --c:var(--stage-1); --pad:32px; --thumb:28px; -webkit-user-select:none; user-select:none; outline-offset:4px; }
.stage-now{ display:flex; align-items:center; gap:8px; margin-bottom:4px; font:var(--t-headline); }
.stage-now .dot{ background:var(--c); }
.stage-now small{ margin-left:auto; font:var(--t-footnote); color:var(--label-2); }
.stage-track{ position:relative; height:44px; margin:0 var(--pad); touch-action:none; cursor:pointer; }
.stage-rail, .stage-fill{ position:absolute; left:0; top:50%; height:6px; margin-top:-3px; border-radius:3px; }
.stage-rail{ right:0; background:var(--fill-1); }
.stage-fill{ width:calc(100% * var(--p)); background:var(--c);
  transition:width var(--d-bouncy) var(--spring-bouncy), background-color 200ms var(--ease-out); }
.stage-tick{ position:absolute; top:50%; left:calc(100% * var(--k) / (var(--n) - 1)); width:6px; height:6px;
  margin:-3px 0 0 -3px; border-radius:50%; background:var(--label-3); pointer-events:none; }
.stage-tick.is-done{ background:rgba(255,255,255,.85); }
.stage-thumb{ position:absolute; top:50%; left:calc(100% * var(--p)); width:var(--thumb); height:var(--thumb);
  margin:calc(var(--thumb) / -2) 0 0 calc(var(--thumb) / -2); border-radius:50%; overflow:hidden; background:var(--knob);
  box-shadow:0 .5px 4px rgba(0,0,0,.12), 0 6px 13px rgba(0,0,0,.12), 0 0 0 .5px rgba(0,0,0,.04);
  transition:left var(--d-bouncy) var(--spring-bouncy), scale var(--d-snappy) var(--spring-snappy); }
/* Lens: a clone of rail/fill/ticks aligned under the thumb; scaling the thumb magnifies it (no filters; Safari-safe) */
.stage-lens{ display:none; position:absolute; pointer-events:none; width:var(--tw, 0px); height:44px;
  top:calc(var(--thumb) / 2 - 22px); left:calc(var(--thumb) / 2 - var(--p) * var(--tw, 0px)); }
.stage.is-dragging .stage-lens{ display:block; }
.stage.is-dragging .stage-fill{ transition:none; }
.stage.is-dragging .stage-thumb{ scale:1.35; background:var(--glass-opaque);
  box-shadow:inset 0 0 0 .5px rgba(255,255,255,.7), inset 0 1px 1.5px rgba(255,255,255,.85),
             0 0 0 .5px rgba(0,0,0,.10), 0 6px 16px rgba(0,0,0,.18);
  transition:scale var(--d-snappy) var(--spring-snappy); }   /* no 'left' transition while dragging */
.stage-labels{ position:relative; height:40px; margin:-4px var(--pad) 0; padding:0; list-style:none; }
.stage-labels button{ position:absolute; top:0; left:calc(100% * var(--k) / (var(--n) - 1));
  width:calc(100% / (var(--n) - 1)); min-height:var(--hit); translate:-50% 0;
  font:var(--t-caption); color:var(--label-2); }
.stage-labels button[aria-current="step"]{ font:var(--t-caption-em); color:var(--label); }
.stage[aria-disabled="true"]{ --c:var(--label-3); }
.stage[aria-disabled="true"] .stage-thumb{ display:none; }
.stage[aria-disabled="true"] .stage-track, .stage[aria-disabled="true"] .stage-labels button{ cursor:default; }
.stage--compact .stage-labels{ display:none; }
.stage--compact{ --pad:14px; }

/* ---------- Job pins (content: solid, no glass, no filters) ---------- */
.jpin{ position:relative; width:22px; height:22px; box-sizing:border-box; border-radius:50%; background:var(--c);
  color:var(--on-c, #fff); font:700 11px/22px var(--font); text-align:center; -webkit-touch-callout:none;
  box-shadow:0 0 0 2px var(--pin-ring), 0 1px 3px rgba(0,0,0,.3);
  transition:scale var(--d-snappy) var(--spring-snappy); }
.jpin::before{ content:""; position:absolute; inset:-11px; border-radius:50%; } /* 44px hit */
.jpin.is-uns{ box-shadow:0 0 0 2px var(--uns-ring), 0 1px 3px rgba(0,0,0,.3); }
.jpin.is-pend{ box-shadow:0 1px 3px rgba(0,0,0,.3); outline:2px dashed var(--pend-ring); outline-offset:0; }
.jpin.is-selected{ scale:1.35; box-shadow:0 0 0 2.5px var(--pin-ring), 0 0 0 4px var(--c), 0 3px 10px rgba(0,0,0,.35); }
/* Route stops: rounded squares so "#3" can never be confused with stage digit 3 */
.rpin{ width:26px; height:26px; border-radius:8px; background:var(--accent); color:var(--on-accent);
  font:700 12px/26px var(--font); text-align:center; box-shadow:0 0 0 2px var(--pin-ring), 0 1px 3px rgba(0,0,0,.3); }
.rpin.is-shop{ background:var(--label); color:var(--on-label); }

/* ---------- Desktop map card (glass) ---------- */
.map-card{ position:fixed; z-index:30; left:0; top:0; width:300px; padding:14px 16px 8px; border-radius:20px;
  translate:calc(var(--cx, 0px) - 50%) calc(var(--cy, 0px) - 100% - 18px);
  transform-origin:50% calc(100% + 18px); scale:.9; visibility:hidden; }
.map-card.is-below{ translate:calc(var(--cx, 0px) - 50%) calc(var(--cy, 0px) + 18px); transform-origin:50% -18px; }
.map-card.is-open{ visibility:visible; scale:1; transition:scale var(--d-snappy) var(--spring-snappy); }
.map-card .mc-title{ font:var(--t-headline); } .map-card .mc-sub{ font:var(--t-footnote); color:var(--label-2); margin-bottom:6px; }

/* ---------- Toast (glass glass--sm) ---------- */
.toast{ position:fixed; z-index:70; top:max(12px, calc(var(--safe-t) + 8px)); left:50%;
  display:flex; align-items:center; gap:10px; min-height:var(--hit); padding:0 6px 0 16px; border-radius:var(--r-pill);
  font:var(--t-subhead-em); translate:-50% calc(-100% - 24px); visibility:hidden;
  transition:translate var(--d-snappy) var(--spring-snappy), visibility 0s linear var(--d-snappy); }
.toast.is-on{ translate:-50% 0; visibility:visible; transition:translate var(--d-snappy) var(--spring-snappy), visibility 0s; }
.toast .btn{ min-height:32px; padding:0 12px; }

/* ---------- Leaflet ---------- */
.leaflet-control-attribution{ background:none !important; margin:0 7px 0 0 !important; max-width:calc(100vw - 32px);
  font:10px/1.3 var(--font); color:var(--label-2); }
.leaflet-control-attribution a{ color:inherit; }
.leaflet-bottom.leaflet-right{ bottom:var(--attr-b); }
/* No L.popup / bindPopup anywhere: Leaflet fades popups with INLINE opacity, which CSS cannot override. */

/* ---------- Desktop ---------- */
@media (min-width: 900px){
  .accessory, .tabbar, .scrim, .grabber, .phone-only{ display:none !important; }
  .sheet, .sheet.is-large{ top:12px; bottom:12px; left:12px; right:auto; width:var(--panel-w);
    border-radius:var(--r-lg); transform:none; transition:none; }
  .sheet-head{ touch-action:auto; padding:14px 16px 8px; }
  .sheet-body{ padding-bottom:16px; }
  .panel-views{ display:flex; gap:2px; margin-left:auto; }
  .chips{ flex-wrap:wrap; overflow:visible; margin:0; padding:0; -webkit-mask-image:none; mask-image:none; }
  .map-controls{ top:12px; right:12px; }
  .map-controls .desktop-only{ display:grid; }
  .leaflet-bottom.leaflet-right{ bottom:0; }
}
```

### 4.3 JS (plain scripts, no modules)

The existing inline app code moves out of `index.html` into `js/app.js`, and a new `js/ui.js` holds the shell behaviour. Both load at the end of `<body>` in that order, after Leaflet. This amends ADR-14 ("one vanilla index.html"): there is still **no build step**. Log the amendment in APP_MASTER §9, and list the new files in §2 and §4.3.

**Press, glow and scale (`ui.js`)**

```js
document.addEventListener('pointerdown', function (e) {
  var t = e.target.closest('.pressable'); if (!t || t.disabled) return;
  var g = t.closest('.glass'); if (g && g.classList.contains('sheet')) g = null;  // no glow on big sheets
  if (g) { var r = g.getBoundingClientRect();
    g.style.setProperty('--px', (e.clientX - r.left) + 'px'); g.style.setProperty('--py', (e.clientY - r.top) + 'px');
    g.classList.add('is-lit'); }
  t.classList.add('is-pressed');
  function up() { t.classList.remove('is-pressed'); if (g) g.classList.remove('is-lit');
    removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true); }
  addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
}, { passive: true });
```

**Shell: layout, views, sheets, accessory (`ui.js`)**

The finger is followed directly in JS, and the spring is used only on release. CSS springs have a fixed duration and reverse when interrupted ([Comeau](https://www.joshwcomeau.com/animation/linear-timing-function/)).

```js
var DESK = matchMedia('(min-width: 900px)'), FINE = matchMedia('(hover: hover) and (pointer: fine)');
var root = document.documentElement,
    acc = document.getElementById('accessory'), tabs = document.getElementById('tabs'),
    ctl = document.getElementById('ctl'), scrim = document.getElementById('scrim'),
    filterbar = document.getElementById('filterbar'),
    listEl = document.getElementById('sheet'), detailEl = document.getElementById('detail');
var TITLES = { jobs: 'Jobs', routes: 'Routes', plan: 'Plan a Route', settings: 'Settings' };
var activeSheet = null, returnTo = null;

function placeFilterbar(inSheet) {
  if (inSheet) { var head = listEl.querySelector('.sheet-head'); head.insertBefore(filterbar, head.querySelector('#q')); }
  else acc.querySelector('.acc-slot').append(filterbar);
}
function chrome(show) {                                   // accessory + tab bar = the collapsed state (iPhone)
  acc.hidden = !show; tabs.hidden = !show;
  if (show) { root.style.removeProperty('--attr-b'); placeFilterbar(false); }
}
new ResizeObserver(function () { if (!acc.hidden) root.style.setProperty('--acc-h', acc.offsetHeight + 'px'); }).observe(acc);

function showView(v) {                                    // v = jobs | routes | plan | settings
  listEl.dataset.view = v; listEl.setAttribute('aria-label', TITLES[v]);
  listEl.querySelector('.sheet-title').textContent = TITLES[v];
  listEl.querySelectorAll('.view').forEach(function (n) { n.classList.toggle('on', n.id === 'v-' + v); });
  tabs.querySelectorAll('.tab').forEach(function (b, i) {
    var on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) tabs.style.setProperty('--i', i); });
  if (v === 'jobs' && (DESK.matches || !listEl.hidden)) placeFilterbar(true);
  if (window.onViewChange) onViewChange(v);               // app.js: route layer vs job layer, invalidateSize
}

function Sheet(el) {
  var self = this, head = el.querySelector('.sheet-head'), startTop = 0;
  function curY() { return parseFloat(el.style.getPropertyValue('--y')) || 0; }
  function setY(y) { el.style.setProperty('--y', y + 'px'); }
  function Y(name) {
    if (name === 'large') return 0;
    if (name === 'medium') return Math.max(0, el.offsetHeight - Math.round(innerHeight * 0.52));
    return startTop - el.offsetTop;                       // 'closed' = the edge it grew from
  }
  function settle() {                                      // end of a snap (transitionend OR no movement)
    if (el.dataset.detent === 'large') el.classList.add('is-opaque');
    if (el.dataset.detent === 'closed' && !el.hidden) { el.hidden = true; if (self.onClosed) self.onClosed(); }
  }
  self.snap = function (name) {
    var y = Y(name), moved = Math.abs(curY() - y) > 0.5;
    el.dataset.detent = name;
    el.classList.toggle('is-large', name === 'large');
    if (name !== 'large') el.classList.remove('is-opaque');
    scrim.classList.toggle('is-on', name === 'large');
    ctl.hidden = (name === 'large');
    el.style.setProperty('--hidden', (name === 'medium' ? y : 0) + 'px');   // keeps the last rows reachable
    if (name === 'medium') root.style.setProperty('--attr-b', (innerHeight - el.offsetTop - y + 10) + 'px');
    setY(y);
    if (!moved) settle();                                  // no transform change → no transitionend
  };
  self.open = function (detent) {
    startTop = acc.hidden ? innerHeight : acc.getBoundingClientRect().top;   // measure BEFORE hiding
    chrome(false);
    el.hidden = false; activeSheet = self;
    el.classList.add('is-dragging'); setY(Y('closed')); void el.offsetHeight; el.classList.remove('is-dragging');
    self.snap(detent || 'medium');
  };
  self.close = function () { self.snap('closed'); };
  el.addEventListener('transitionend', function (e) {
    if (e.target === el && e.propertyName === 'transform') settle();
  });
  head.addEventListener('pointerdown', function (e) {
    if (DESK.matches || e.button > 0 || e.target.closest('button, input, a, .chips, .seg')) return;
    var y0 = curY(), p0 = e.clientY, s = [{ y: e.clientY, t: e.timeStamp }];
    head.setPointerCapture(e.pointerId);
    el.classList.add('is-dragging'); el.classList.remove('is-opaque');
    function move(ev) { var y = y0 + ev.clientY - p0; setY(y < 0 ? y / 3 : y);
      s.push({ y: ev.clientY, t: ev.timeStamp }); if (s.length > 5) s.shift(); }
    function end(ev) {                                     // remove ALL three listeners (no stale {once} leftovers)
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', end);
      head.removeEventListener('pointercancel', end);
      el.classList.remove('is-dragging');
      if (ev.type === 'pointercancel') return self.snap(el.dataset.detent);
      if (Math.abs(ev.clientY - p0) < 4) return self.snap(el.dataset.detent === 'large' ? 'medium' : 'large'); // grabber tap cycles
      var a = s[0], b = s[s.length - 1], v = (b.y - a.y) / Math.max(1, b.t - a.t);    // px/ms, + = down
      var target = y0 + ev.clientY - p0 + v * 200;
      self.snap(['large', 'medium', 'closed'].reduce(function (m, n) {
        return Math.abs(Y(n) - target) < Math.abs(Y(m) - target) ? n : m; }));
    }
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  });
}

var listSheet = new Sheet(listEl), detailSheet = new Sheet(detailEl);
function openList(view, detent) { listSheet.open(detent); showView(view); }
listSheet.onClosed = function () { activeSheet = null; chrome(true); };
detailSheet.onClosed = function () {
  if (window.clearSelection) clearSelection();
  if (returnTo) { var d = returnTo; returnTo = null; openList(listEl.dataset.view, d); }
  else { activeSheet = null; chrome(true); }
};
scrim.addEventListener('click', function () { if (activeSheet) activeSheet.snap('medium'); });
addEventListener('resize', function () {
  if (!DESK.matches && activeSheet) activeSheet.snap(activeSheet === listSheet ? listEl.dataset.detent : detailEl.dataset.detent);
});

/* Accessory: tap empty area or swipe up → Jobs sheet */
acc.addEventListener('pointerdown', function (e) {
  if (e.target.closest('button, .chips, .seg')) return;
  var y0 = e.clientY;
  function end(ev) {
    acc.removeEventListener('pointerup', end); acc.removeEventListener('pointercancel', end);
    var dy = y0 - ev.clientY;
    if (ev.type === 'pointerup' && (dy > 24 || Math.abs(dy) < 6)) openList('jobs', 'medium');
  }
  acc.addEventListener('pointerup', end); acc.addEventListener('pointercancel', end);
});
tabs.addEventListener('click', function (e) {
  var b = e.target.closest('.tab'); if (!b) return;
  if (DESK.matches) showView(b.dataset.v); else openList(b.dataset.v, 'medium');
});
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-act]'); if (!b) return;
  switch (b.dataset.act) {
    case 'settings':     if (DESK.matches) showView('settings'); else openList('settings', 'large'); break;
    case 'collapse':     listSheet.close(); break;
    case 'close-detail': closeDetail(); break;
    /* zoom-in / zoom-out / locate are handled in app.js */
  }
});
listEl.querySelector('.panel-views').addEventListener('click', function (e) {
  var b = e.target.closest('[data-v]'); if (b) showView(b.dataset.v);
});
document.getElementById('q').addEventListener('focus', function () { if (!DESK.matches) listSheet.snap('large'); });

/* Keyboard: iOS resizes only the visual viewport */
if (window.visualViewport) {
  var kb = function () { root.style.setProperty('--kb',
    Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop) + 'px'); };
  visualViewport.addEventListener('resize', kb); visualViewport.addEventListener('scroll', kb);
}

/* Detail open/close (both layouts) */
function openDetail(job) {                                 // called by app.js with a job record
  if (window.fillDetail) fillDetail(job);
  if (DESK.matches) { listEl.hidden = true; detailEl.hidden = false; refreshLens(detailEl); return; }
  returnTo = listEl.hidden ? null : listEl.dataset.detent;
  if (!listEl.hidden) { listEl.hidden = true; listEl.dataset.detent = 'closed'; }
  detailSheet.open('medium');
}
function closeDetail() {
  if (DESK.matches) { detailEl.hidden = true; listEl.hidden = false; refreshLens(listEl);
    if (window.clearSelection) clearSelection(); return; }
  detailSheet.close();
}

/* Desktop ⇄ iPhone */
function layout() {
  if (DESK.matches) {
    chrome(false); scrim.classList.remove('is-on'); ctl.hidden = false; activeSheet = null; returnTo = null;
    [listEl, detailEl].forEach(function (s) { s.classList.remove('is-large', 'is-opaque', 'is-dragging');
      s.style.removeProperty('--y'); s.style.removeProperty('--hidden'); s.dataset.detent = 'desktop'; });
    listEl.hidden = !detailEl.hidden;                      // the detail replaces the list while open
    placeFilterbar(listEl.dataset.view === 'jobs');
  } else {
    listEl.hidden = true; detailEl.hidden = true; listEl.dataset.detent = detailEl.dataset.detent = 'closed';
    activeSheet = null; returnTo = null; chrome(true);
  }
}
DESK.addEventListener('change', layout); layout();

/* Toast with optional Undo */
var toastEl = document.getElementById('toast'), toastT = 0, undoFn = null;
function toast(msg, undo) {
  toastEl.querySelector('.msg').textContent = msg;
  toastEl.querySelector('.btn').hidden = !undo; undoFn = undo || null;
  toastEl.classList.add('is-on'); clearTimeout(toastT);
  toastT = setTimeout(function () { toastEl.classList.remove('is-on'); undoFn = null; }, 5000);
}
toastEl.querySelector('.btn').addEventListener('click', function () {
  var f = undoFn; undoFn = null; toastEl.classList.remove('is-on'); if (f) f(); });
```

**Stage model and slider (`ui.js`). Mount it once per `.stage` element and rebind it with `.set(job)`.**

```js
var STAGES = [
  { key: 'ready',      label: 'Ready to start',    short: 'Ready'  },
  { key: 'excavation', label: 'Excavation',        short: 'Excav.' },
  { key: 'base',       label: 'Base',              short: 'Base'   },
  { key: 'prep',       label: 'Prep',              short: 'Prep'   },
  { key: 'inspected',  label: 'Passed inspection', short: 'Passed' },
  { key: 'poured',     label: 'Poured',            short: 'Poured' }
];
var LAST = STAGES.length - 1;
function stageIndex(key) { for (var i = 0; i < STAGES.length; i++) if (STAGES[i].key === key) return i; return 0; } // unknown → ready
function stageVars(k) { return '--c:var(--stage-' + (k + 1) + ')' + (k === 3 ? ';--on-c:#000' : ''); }

function StageSlider(el, onCommit) {                       // onCommit(job, newKey)
  var track = el.querySelector('.stage-track'), now = el.querySelector('.stage-now'), job = null;
  new ResizeObserver(function () { el.style.setProperty('--tw', track.clientWidth + 'px'); }).observe(track);
  function locked() { return !job || el.getAttribute('aria-disabled') === 'true'; }
  function paint(k) {
    var s = STAGES[k];
    el.style.setProperty('--c', 'var(--stage-' + (k + 1) + ')');
    el.style.setProperty('--on-c', k === 3 ? '#000' : '#fff');
    el.setAttribute('aria-valuenow', k + 1); el.setAttribute('aria-valuetext', s.label);
    el.querySelectorAll('.stage-tick').forEach(function (t) { t.classList.toggle('is-done', +t.dataset.k <= k); });
    el.querySelectorAll('.stage-labels button').forEach(function (b) {
      if (+b.dataset.k === k) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
    now.querySelector('.dot').textContent = k + 1;
    now.querySelector('.name').textContent = s.label;
    now.querySelector('small').textContent = 'Stage ' + (k + 1) + ' of ' + STAGES.length;
  }
  function place(k) { el.style.setProperty('--p', k / LAST); paint(k); }
  function commit(k) { place(k); if (STAGES[k].key !== job.stage) onCommit(job, STAGES[k].key); }
  track.addEventListener('pointerdown', function (e) {
    if (locked() || e.button > 0) return;
    track.setPointerCapture(e.pointerId); el.classList.add('is-dragging');
    var r = track.getBoundingClientRect(), raf = 0, p;
    function at(x) { return Math.min(1, Math.max(0, (x - r.left) / r.width)); }
    function draw() { raf = 0; el.style.setProperty('--p', p); paint(Math.round(p * LAST)); }
    p = at(e.clientX); draw();
    function move(ev) { p = at(ev.clientX); if (!raf) raf = requestAnimationFrame(draw); }
    function end(ev) {
      track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', end);
      track.removeEventListener('pointercancel', end);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      el.classList.remove('is-dragging');
      if (ev.type === 'pointercancel') return place(stageIndex(job.stage));
      commit(Math.round(p * LAST));
    }
    track.addEventListener('pointermove', move); track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  });
  el.querySelectorAll('.stage-labels button').forEach(function (b) {
    b.addEventListener('click', function () { if (!locked()) commit(+b.dataset.k); }); });
  el.addEventListener('keydown', function (e) {
    if (locked()) return;
    var k = stageIndex(job.stage), d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (e.key === 'Home') d = -k; if (e.key === 'End') d = LAST - k;
    if (d) { e.preventDefault(); commit(Math.min(LAST, Math.max(0, k + d))); }
  });
  return {
    set: function (j) { job = j; place(stageIndex(j.stage)); },
    lock: function (on) { el.setAttribute('aria-disabled', on ? 'true' : 'false'); }
  };
}
```

**Data, filters, pins, detail, stage moves (`app.js`)**

These are additions to the existing code; `JOBS`, `COL`, `LABEL`, `SHOP`, `optimize`, `showResult`, `renderStops`, the planner `stops` array and `gm()` already exist (APP_MASTER §4.3). Build every new piece of UI with `textContent` or an `escapeHtml` helper, never by concatenating raw job fields into `innerHTML`.

```js
var map = L.map('jmap', { zoomControl: false });            // replaces the old jmap; #pmap is retired
var jobLayer = L.layerGroup().addTo(map), routeLayer = L.layerGroup(), markers = {};
var FILTER = (function () { try { return JSON.parse(localStorage.getItem('ej_filter')) || null; } catch (e) { return null; } })()
             || { mode: 'client', sel: { client: [], stage: [] } };
function saveFilter() { try { localStorage.setItem('ej_filter', JSON.stringify(FILTER)); } catch (e) {} }
function groupKey(x) { return FILTER.mode === 'client' ? x.clientKey : x.stage; }
function sel() { return FILTER.sel[FILTER.mode]; }
function visible(x) { var s = sel(); return !s.length || s.indexOf(groupKey(x)) >= 0; }

function pinHtml(x) {
  var st = FILTER.mode === 'stage', k = stageIndex(x.stage);
  var vars = st ? stageVars(k) : '--c:var(--client-' + x.clientKey + ', var(--client-Other))';
  return '<div class="jpin' + (x.unscheduled ? ' is-uns' : '') + (x.pending ? ' is-pend' : '') +
         (x === selectedJob ? ' is-selected' : '') + '" style="' + vars + '">' + (st ? k + 1 : '') + '</div>';
}
function iconFor(x) { return L.divIcon({ html: pinHtml(x), className: '', iconSize: [22, 22], iconAnchor: [11, 11] }); }
function updatePin(x) { var m = markers[x.jobNumber]; if (m) m.setIcon(iconFor(x)); }

/* Chip click: "solo, then add" */
document.getElementById('chips').addEventListener('click', function (e) {
  var b = e.target.closest('.chip'); if (!b) return;
  var k = b.dataset.k, s = FILTER.sel[FILTER.mode];
  if (!k) s.length = 0;
  else { var i = s.indexOf(k); if (i >= 0) s.splice(i, 1); else s.push(k); }
  saveFilter(); renderAll(); fitVisible();
});
/* Mode switch: re-render chips, pins and list; the segmented thumb moves via --i */
document.getElementById('mode').addEventListener('click', function (e) {
  var b = e.target.closest('[data-mode]'); if (!b || b.dataset.mode === FILTER.mode) return;
  FILTER.mode = b.dataset.mode; saveFilter();
  this.style.setProperty('--i', FILTER.mode === 'client' ? 0 : 1);
  this.querySelectorAll('[data-mode]').forEach(function (n) { n.setAttribute('aria-checked', n === b ? 'true' : 'false'); });
  renderAll();
});
/* renderAll(): chips (All + groups with counts), markers (jobLayer, only ok && visible), #jlist (grouped .grp headers +
   .job-row, including unmapped rows with a "not mapped" tag), #count, and #routeSel:
     var n = JOBS.filter(function (x) { return x.ok && visible(x); }).length;
     routeSel.disabled = !sel().length || !n;  routeSel.textContent = 'Route ' + n;
   Search (#q) matches street, permit, jobNumber, title, city, client label and stage label. */

function fitVisible() {
  var pts = JOBS.filter(function (x) { return x.ok && visible(x); }).map(function (x) { return [x.lat, x.lon]; });
  if (!pts.length) return;
  var accTop = acc.hidden ? innerHeight : acc.getBoundingClientRect().top;
  map.fitBounds(pts, DESK.matches
    ? { maxZoom: 15, paddingTopLeft: [12 + 380 + 24, 24], paddingBottomRight: [80, 24] }
    : { maxZoom: 15, paddingTopLeft: [24, 72], paddingBottomRight: [72, innerHeight - accTop + 24] });
}

/* Selection + detail */
var selectedJob = null;
var detailSlider = StageSlider(detailEl.querySelector('.stage'), moveStage);
function select(x) { var prev = selectedJob; selectedJob = x; if (prev) updatePin(prev); updatePin(x);
  document.querySelectorAll('.job-row.is-selected').forEach(function (r) { r.classList.remove('is-selected'); });
  var row = document.querySelector('.job-row[data-jn="' + x.jobNumber + '"]'); if (row) row.classList.add('is-selected'); }
window.clearSelection = function () { var p = selectedJob; selectedJob = null; if (p) updatePin(p); };
window.fillDetail = function (x) {
  select(x);
  detailEl.querySelector('.detail-title').textContent = x.street || x.title;
  detailEl.querySelector('.detail-sub').textContent = [LABEL[x.clientKey] || x.client, '#' + x.jobNumber, x.permit].filter(Boolean).join(' · ');
  detailSlider.set(x); detailSlider.lock(!StageStore.writable);
  /* actions: Directions → 'https://www.google.com/maps/dir/?api=1&destination=' + x.lat + ',' + x.lon (disabled if !x.ok);
     Add to Plan → stops.push({ name: x.street || x.title, lat: x.lat, lon: x.lon, jobNumber: x.jobNumber }); renderStops();
     Copy address → navigator.clipboard.writeText(x.street + ', ' + x.city) */
  if (x.ok && !DESK.matches) map.panInside([x.lat, x.lon],
    { paddingTopLeft: [16, 72], paddingBottomRight: [16, Math.round(innerHeight * 0.52) + 16] });
};
/* marker.on('click') and .job-row click → openDetail(job) (desktop marker click: openCard + pin card + select row) */

/* Stage move: optimistic, undoable, persisted through the adapter (§8). Never re-filters. */
function applyStage(x, key) {
  x.stage = key; updatePin(x); /* patch the row's badge/dot in place; recount chips */
  if (selectedJob === x) detailSlider.set(x); if (cardJob === x) cardSlider.set(x);
}
function moveStage(x, key) {
  var prev = x.stage; applyStage(x, key);
  var label = STAGES[stageIndex(key)].label;
  StageStore.set(x.jobNumber, key).then(function () {
    toast('Moved to ' + label, function () {
      applyStage(x, prev);
      StageStore.set(x.jobNumber, prev).catch(function () { applyStage(x, key); toast('Couldn’t undo — try again'); });
    });
  }, function () { applyStage(x, prev); toast('Couldn’t save — try again'); });
}

/* Desktop hover card (fine pointer only) */
var card = document.getElementById('map-card'), cardJob = null, showT = 0, hideT = 0;
var cardSlider = StageSlider(card.querySelector('.stage'), moveStage);
function placeCard() { if (!cardJob) return; var p = map.latLngToContainerPoint([cardJob.lat, cardJob.lon]); // #jmap is fixed at 0,0
  card.style.setProperty('--cx', p.x + 'px'); card.style.setProperty('--cy', p.y + 'px');
  card.classList.toggle('is-below', p.y < card.offsetHeight + 40); }
function openCard(x) { cardJob = x; card.querySelector('.mc-title').textContent = x.street || x.title;
  card.querySelector('.mc-sub').textContent = (LABEL[x.clientKey] || x.client) + ' · #' + x.jobNumber;
  cardSlider.set(x); cardSlider.lock(!StageStore.writable); placeCard(); card.classList.add('is-open'); }
function closeCard() { card.classList.remove('is-open', 'is-pinned'); cardJob = null; }
function bindHover(marker, x) {
  marker.on('mouseover', function () { if (!FINE.matches) return; clearTimeout(hideT); showT = setTimeout(function () { openCard(x); }, 120); });
  marker.on('mouseout',  function () { clearTimeout(showT); if (!card.classList.contains('is-pinned')) hideT = setTimeout(closeCard, 250); });
}
card.addEventListener('pointerenter', function () { clearTimeout(hideT); });
card.addEventListener('pointerleave', function () { if (!card.classList.contains('is-pinned')) hideT = setTimeout(closeCard, 250); });
map.on('move zoom', function () { requestAnimationFrame(placeCard); });
map.on('click', closeCard);
```

The card is a fixed sibling of `#jmap`, not an `L.popup`. It never inherits Leaflet's inline popup opacity or its transformed panes.

**Planner on the single map, and the one-click route (`app.js`)**

These are the APP_MASTER R-1 prerequisites, and they ship in Merge A:
- Delete the 300-restart loop, or move `optimize` into a Web Worker behind a spinner.
- Split Google Maps links into parts of at most 10 points with overlapping endpoints.
- Put `jobNumber` on stops.
- `showResult` no longer creates `#pmap`. It clears `routeLayer`, then adds `.rpin` markers (`S`, 1..n) and a polyline:
  - Light theme: `--accent` at 5px over a white 8px casing.
  - Dark theme: the dark accent over an `rgba(0,0,0,.4)` casing.
  - It then calls `fitBounds` with the same sheet-aware padding as `fitVisible`.

```js
window.onViewChange = function (v) {                       // show the route instead of job pins while a result exists
  var route = v === 'plan' && routeLayer.getLayers().length;
  if (route) { map.removeLayer(jobLayer); routeLayer.addTo(map); } else { map.removeLayer(routeLayer); jobLayer.addTo(map); }
};
document.getElementById('routeSel').addEventListener('click', function () {
  var picked = JOBS.filter(visible), mapped = picked.filter(function (x) { return x.ok; });
  var skipped = picked.length - mapped.length; if (!mapped.length) return;
  if (mapped.length > 25 && !confirm('Build a route with ' + mapped.length + ' stops? It will need several Google Maps links.')) return;
  stops.length = 0; stops.push(Object.assign({}, SHOP));
  mapped.forEach(function (x) { stops.push({ name: x.street || x.title, lat: x.lat, lon: x.lon, jobNumber: x.jobNumber }); });
  renderStops();
  var rt = document.getElementById('rt').checked;
  var title = sel().map(function (k) { return FILTER.mode === 'stage' ? STAGES[stageIndex(k)].label : (LABEL[k] || k); }).join(' + ');
  if (DESK.matches) showView('plan'); else openList('plan', 'medium');
  showResult(optimize(stops, true, false, rt), rt, title + ' from shop' + (skipped ? ' (' + skipped + ' unmapped not included)' : ''));
  onViewChange('plan');
});
/* Rural legs: until Q4, follow APP_MASTER R-1's interim rule (exclude out-of-Winnipeg jobs and list them, OR 70 km/h
   for legs > 15 km). Record which one was used in the R-1 Work log. */
```

---

## 5. Progressive enhancement and accessibility

### 5.1 Capability ladder

| Environment | Result |
|---|---|
| iPhone (iOS 26.1+/27, standalone) | Literal `backdrop-filter` recipes; unprefixed since Safari 18 ([Safari 18.0](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/)). No refraction and no `corner-shape` |
| Desktop Chrome/Edge | Same recipes, plus hyalite refraction on `.lens-panel` and `.lens-ctl` when §5.3 passes, plus squircle corners on the other large glass |
| No backdrop-filter | The `@supports not` block uses the opaque `--glass-opaque` fill |
| Increase Contrast (`prefers-contrast: more`, supported in Safari ([caniuse](https://caniuse.com/mdn-css_at-rules_media_prefers-contrast))) | Opaque black or white, 1.5px border, no rim |
| Reduce Transparency | Not detectable on iOS: `prefers-reduced-transparency` is unsupported in Safari through 27.x ([caniuse](https://caniuse.com/wf-prefers-reduced-transparency)). The in-app **Glass: Liquid · Tinted · Solid** setting covers it. On Auto, Chromium's media query selects Tinted. This mirrors iOS 26.1's Clear/Tinted switch (Settings › Display & Brightness › Liquid Glass) ([Engadget](https://www.engadget.com/mobile/smartphones/how-to-adjust-the-liquid-glass-effect-in-ios-261-203634681.html)) and iOS 27's transparency slider ([MacRumors](https://www.macrumors.com/2026/06/10/how-liquid-glass-is-changing-in-ios-27/)) |
| Reduce Motion | All transitions become near-instant, with no press scale and no elastic behaviour ([WWDC25-219](https://developer.apple.com/videos/play/wwdc2025/219/)). hyalite skips its ramps on its own |

### 5.2 `<head>` and boot script (inline, before the stylesheets)

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Eckstein Jobs">
<meta name="theme-color" content="#EFEFEF">
<link rel="manifest" href="manifest.json">                     <!-- "theme_color":"#EFEFEF", "background_color":"#EFEFEF", "display":"standalone" -->
<link rel="apple-touch-icon" sizes="180x180" href="icons/icon-180.png">   <!-- new 180px icon (APP_MASTER R-1) -->
<link rel="icon" href="icons/icon-192.png">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<script>
(function () {
  var d = document.documentElement, p = {};
  try { p = JSON.parse(localStorage.getItem('ej_ui') || '{}') || {}; } catch (e) {}
  var dark = matchMedia('(prefers-color-scheme: dark)'), rt = matchMedia('(prefers-reduced-transparency: reduce)');
  function apply() {
    var theme = (p.theme === 'light' || p.theme === 'dark') ? p.theme : (dark.matches ? 'dark' : 'light');
    var glass = (p.glass === 'liquid' || p.glass === 'tinted' || p.glass === 'solid') ? p.glass : (rt.matches ? 'tinted' : 'liquid');
    d.dataset.theme = theme; d.dataset.glass = glass;
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = theme === 'dark' ? '#474749' : '#EFEFEF';
    dispatchEvent(new CustomEvent('uiprefs', { detail: { theme: theme, glass: glass } }));   // → basemap swap, refract gate
  }
  window.setUiPrefs = function (next) { for (var k in next) p[k] = next[k];               // theme: auto|light|dark
    try { localStorage.setItem('ej_ui', JSON.stringify(p)); } catch (e) {} apply(); };
  if (dark.addEventListener) { dark.addEventListener('change', apply); rt.addEventListener('change', apply); }
  d.classList.toggle('is-standalone', !!(navigator.standalone ||
    matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches));   // iOS reports fullscreen (WebKit 264218)
  apply();
})();
</script>
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/glass.css">
<link rel="stylesheet" href="css/components.css">
<!-- end of <body>: -->
<!-- <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script> -->
<!-- <script src="js/ui.js"></script><script src="js/app.js"></script> -->
```

**Notes on the head:**
- **Leaflet SRI hashes** were computed from unpkg and match leafletjs.com [M].
- **Standalone detection:**
  - `navigator.standalone` is iOS-only ([Apple meta tags](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html)).
  - The `display-mode` query reports `fullscreen` on iOS Home Screen apps ([WebKit 264218](https://bugs.webkit.org/show_bug.cgi?id=264218)).
- **theme-color** colours the opaque status bar of the installed app ([vcsudoku PR 38](https://github.com/tmshv/vcsudoku/pull/38)). In-browser Safari 26 ignores theme-color and tints its toolbar from fixed elements instead ([1ar.io](https://1ar.io/updates/safari-26-liquid-glass-web/)). That only matters when the site is opened in Safari.
- **localStorage:** every access is wrapped in try/catch (APP_MASTER rule). New keys are `ej_ui`, `ej_filter`, `ej_stages`, `ej_device`, and `ej_gh_token` only if [Q1] picks option (b).

### 5.3 Refraction gate (desktop Chromium only)

Gate with JS, **never** `@supports`, because `CSS.supports('backdrop-filter','url(#x)')` is true in every engine ([hyalite source](https://github.com/VII-Cae/hyalite--liquid-glass)). `userAgentData` exists only in Chromium ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/userAgentData)).

```js
function refractGate() {
  var d = document.documentElement;
  var want = !!(navigator.userAgentData && navigator.userAgentData.brands &&
                navigator.userAgentData.brands.some(function (b) { return /Chromium/i.test(b.brand); })) &&
             matchMedia('(hover: hover) and (pointer: fine) and (min-width: 900px)').matches &&
             !matchMedia('(prefers-contrast: more), (prefers-reduced-transparency: reduce)').matches &&
             d.dataset.glass === 'liquid';
  if (!want) { if (window.Hyalite) Hyalite.unwatch(); d.classList.remove('lg-refract'); return; }
  function go() {
    if (!Hyalite.supported()) return;
    Hyalite.unwatch();                                   // stops every watcher; attached elements are detached
    Hyalite.watch(document.body, '.lens-panel', { blur: 12, dispersion: 0, slope: 0.9, settle: 150, materialize: 240 });
    Hyalite.watch(document.body, '.lens-ctl',   { blur: 3,  slope: 0.9 });
    d.classList.add('lg-refract');
  }
  if (window.Hyalite) return go();
  var s = document.createElement('script'); s.src = 'vendor/hyalite.js'; s.onload = go; document.head.append(s);
}
function refreshLens(el) {                               // call right after un-hiding a .lens-panel
  if (window.Hyalite && document.documentElement.classList.contains('lg-refract')) Hyalite.refresh(el);
}
addEventListener('uiprefs', refractGate); DESK.addEventListener('change', refractGate); refractGate();
```

**Hyalite options** (semantics from the hyalite source header):
- `slope < 1` does not fold the field, which keeps the two-pass anti-staircase (`smooth`) active and gives a calm lens. The default of 2.7 folds, which produces the liquid swirl.
- `dispersion: 0` is a single pass, which is cheaper than the three-channel sum.
- `settle` coalesces resizes. The map is otherwise rebuilt `settle` ms after a size change, so call `refreshLens(el)` when `#detail` or `#sheet` is un-hidden.
- `materialize` ramps displacement, shade and rim up from zero.
- **Never pass `edge: 0`** (§1.2).
- **Budget:** at most 2 refracting surfaces visible at once. hyalite's README advises keeping the number of surfaces modest.

### 5.4 Reduced motion (append to components.css)

```css
@media (prefers-reduced-motion: reduce){
  *, *::before, *::after{ transition-duration:.01ms !important; animation-duration:.01ms !important; }
  .pressable.is-pressed, .stage.is-dragging .stage-thumb, .jpin.is-selected{ scale:1 !important; }
}
```

The sheet's `transitionend` still fires at .01ms, and `snap()` also settles when nothing moves.

**No View Transitions on glass.** Snapshots have dropped `backdrop-filter`, and a browser fix is unverified [C] ([CSSWG](https://lists.w3.org/Archives/Public/public-css-archive/2023Sep/0888.html)).

### 5.5 SVG and Leaflet hygiene

- **We ship no hand-written SVG filters.** If one is ever added, its `<svg>` must not be `display:none`, because Blink ignores filters inside a hidden SVG ([hyalite source](https://github.com/VII-Cae/hyalite--liquid-glass)).
- **No `L.popup` / `bindPopup` anywhere.** Leaflet 1.9.4 fades popups by writing **inline** `opacity` from JS (`DivOverlay`: `setOpacity(container, 0 → 1)`), which CSS cannot override ([leaflet-src.js](https://unpkg.com/leaflet@1.9.4/dist/leaflet-src.js)). The job popups and the planner's stop popups are removed: job pins open the detail sheet, and route stops open their job's detail when they have a `jobNumber`.
- **`#jmap{position:fixed; z-index:0}` is required.** Leaflet panes use z-index 200–700 and controls 800/1000 ([leaflet.css](https://unpkg.com/leaflet@1.9.4/dist/leaflet.css), [Leaflet panes](https://leafletjs.com/reference.html#map-pane)).

---

## 6. Performance rules for iPhone

1. **At most 3 glass surfaces over the map at rest.**
   - At rest: controls, accessory and tab bar.
   - Medium: controls and sheet. Large: none.
   - Each blur re-samples as the map pans. A comparable app cut about 20 live blurs down to two bars ([ambience-mixer #2](https://github.com/steverowley/ambience-mixer/issues/2), [openreplay](https://blog.openreplay.com/creating-blurred-backgrounds-css-backdrop-filter/)).
2. **Blur is capped at 16px; small glass uses 10px.**
   - Past 16px the perceptual gain is small and the GPU cost grows super-linearly ([flowrust](https://blog.flowrust.com/2026/07/15/backdrop-filter-stack-glassmorphism-survives-safari/)).
   - Safari 27.0 fixed extremely slow page loads on iPhone caused by large-radius blur filters ([Safari 27.0](https://webkit.org/blog/18325/webkit-features-for-safari-27-0/)).
3. **No glass in content.** Pins, rows, chips, the segmented control, the slider, cards and planner rows use flat fills.
4. **Never animate `opacity`, `filter`, `mask` or `clip-path` on a wrapper around glass**, and never set `opacity < 1` on a glass element.
   - Show and hide glass with `transform`/`scale`/`translate` plus `visibility` or `hidden`.
   - Translucency belongs in the background alpha ([thisdevtool](https://thisdevtool.com/blog/backdrop-filter-not-working-safari-fix)).
5. **Never animate the blur radius.** A static blur is cached and a transitioning one is not ([codefronts](https://codefronts.com/motion/css-transition-designs/glassmorphism-hover-transition/)). The only backdrop-filter change is the delayed switch to `none` when the sheet becomes opaque.
6. **No `will-change: backdrop-filter`.** It caused artifacts, frame drops and excess layers on iOS WebKit ([guitarbeat PR 1072](https://github.com/guitarbeat/personal-website/pull/1072)). Use `will-change: transform` only on `.is-dragging`.
7. **No backdrop-root properties on or above glass.** That covers `isolation`, `contain`, `content-visibility`, `transform`, `opacity < 1`, `mask` and `will-change` on ancestors. Upstream measured 69% versus 1.2% of the backdrop surviving ([core CSS](https://raw.githubusercontent.com/sohumsuthar/liquid-glass/main/css/liquid-glass-core.css), [README](https://github.com/sohumsuthar/liquid-glass)).
8. **Glass elements are direct `<body>` children** (§2.1).
9. **Hidden glass uses `hidden` (`display:none`), not `opacity:0`.** Opacity-hidden fixed elements are still sampled by in-browser Safari 26's toolbar tinting ([1ar.io](https://1ar.io/updates/safari-26-liquid-glass-web/)).
10. **The large sheet is opaque with no blur** [A] ([WWDC25-323](https://developer.apple.com/videos/play/wwdc2025/323/)).
11. **No SVG displacement and no chromatic aberration on iOS** (§0.2).
12. **Drag and map-card positioning are rAF-throttled.** Non-drag listeners are `passive`. Pins are plain `divIcon` DOM with one static box-shadow, no filters and no per-frame work. Stage changes use `setIcon` on one marker, never a full `renderAll()`.
13. **Swap tile layers for dark mode.** Never apply a CSS `filter` to the tile pane.
14. **Touch:**
    - Leaflet keeps `touch-action:none` on the map.
    - Lists use `pan-y`, chips use `pan-x`, and the slider track uses `none`.
    - Sheets use `overscroll-behavior:contain`.
15. **Shell sizing:** `100dvh` plus `env(safe-area-inset-*)` with minimums. Two iOS 26 issues apply:
    - WebKit 301108, the `viewport-fit=cover` regression, is still NEW ([WebKit 301108](https://bugs.webkit.org/show_bug.cgi?id=301108)).
    - The bottom gap on viewport-sized fixed containers after the keyboard closes was fixed in Safari 26.1 ([Apple forums](https://developer.apple.com/forums/thread/799216)).
16. **Service worker.** `sw.js` is **network-first with no precache list**, so new files arrive automatically when online. Still:
    - bump the cache to `ej-v2`;
    - delete old caches on activate;
    - key cached same-origin responses by path, so the `?t=` cache-buster stops growing the cache without bound (APP_MASTER §5 "Browser-side state").

```js
// sw.js — network-first; installable; offline falls back to the last copy of each same-origin path.
const C = 'ej-v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url), same = u.origin === location.origin, key = same ? u.origin + u.pathname : e.request;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && same) { const copy = r.clone(); caches.open(C).then(c => c.put(key, copy)); }
    return r;
  }).catch(() => caches.match(key)));
});
```

---

## 7. Map tiles

- **Light theme (current):** Esri **Light Gray Canvas**, base plus the labels ("Reference") layer.
- **Dark theme:** Esri **Dark Gray Canvas**.
- The app's existing no-subdomain URLs are kept. Native max zoom is 16, upscaled to 19 ([BasemapLayer.js](https://github.com/Esri/esri-leaflet/blob/master/src/Layers/BasemapLayer.js)).
- **Checked 2026-09-25 [M]:** the light and dark base tiles for z14/5560/3771 returned HTTP 200 with `Access-Control-Allow-Origin: *`.
- **Canvas colours [M]:** the dominant pixel is `#EFEFEF` (light) and `#474749` (dark). They drive `--canvas`, the `html`/`body` background and `theme-color`.
- **Terms and risk:**
  - esri-leaflet marks these legacy tiled basemap services as no longer updated, and says they could be deactivated without notice ([L.esri.basemapLayer](https://developers.arcgis.com/esri-leaflet/api-reference/esri-leaflet/basemap-layer/)).
  - Esri's terms of use apply to all Leaflet apps and require attribution for Esri and its data providers ([Esri Leaflet terms](https://developers.arcgis.com/esri-leaflet/terms-of-use/)).
  - Esri's migration guidance says apps on the legacy services should move to the new basemap service to comply ([Esri blog](https://www.esri.com/arcgis-blog/products/developers/developers/open-source-developers-time-to-upgrade-to-the-new-arcgis-basemap-layer-service)).
  - **Contingency, Riley's decision:** ArcGIS **static basemap tiles**. These are still raster and work with plain Leaflet through `esri-leaflet-static-basemap-tile` (Apache-2.0), using style `arcgis/light-gray` and presumably `arcgis/dark-gray` (confirm in Esri's style list). They need an ArcGIS access token that Riley creates, restricts by referrer and enters himself ([plugin](https://github.com/Esri/esri-leaflet-static-basemap-tile)).
- **Attribution:** replace today's short `Tiles &copy; Esri` with the service's own `copyrightText`, as below.

```text
Base  : https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}
Labels: https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}
Dark  : https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}
Dark L: https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}
```

```js
map.createPane('labels');
map.getPane('labels').style.zIndex = 450;            // above route lines (overlayPane 400), below markers (600)
map.getPane('labels').style.pointerEvents = 'none';
var ESRI_ATTR = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community';
function esri(name, pane) {
  return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/' + name + '/MapServer/tile/{z}/{y}/{x}',
    { maxNativeZoom: 16, maxZoom: 19, pane: pane || 'tilePane', attribution: pane ? '' : ESRI_ATTR });
}
var BASEMAPS = {
  light: [esri('World_Light_Gray_Base'), esri('World_Light_Gray_Reference', 'labels')],
  dark:  [esri('World_Dark_Gray_Base'),  esri('World_Dark_Gray_Reference', 'labels')]
};
var currentTheme = null, gen = 0;
function setBasemap(theme) {
  if (theme === currentTheme) return;
  var next = BASEMAPS[theme], my = ++gen; currentTheme = theme;
  next.forEach(function (l) { if (!map.hasLayer(l)) l.addTo(map); l.bringToFront(); });
  function sweep() {                                   // remove the other theme only once the new base has loaded
    if (my !== gen) return;                            // a newer toggle won — do nothing
    Object.keys(BASEMAPS).forEach(function (t) { if (t !== theme) BASEMAPS[t].forEach(function (l) {
      if (map.hasLayer(l)) map.removeLayer(l); }); });
  }
  if (next[0].isLoading()) next[0].once('load', sweep); else sweep();
}
addEventListener('uiprefs', function (e) { setBasemap(e.detail.theme); });
setBasemap(document.documentElement.dataset.theme);
```

- **Why muted basemaps:** they suit an information-dense pin map [A] ([HIG Maps](https://developer.apple.com/design/human-interface-guidelines/maps)).
- **Pin ring:** stays white in both themes.

---

## 8. Stage storage and the Home Screen app

- **One adapter, many backends (APP_MASTER R-1):**
  - All stage reads and writes go through `StageStore`: `load(): Promise<{jobNumber: {stage, at, by}}>`, `set(jobNumber, key): Promise`, and a `writable` flag.
  - **v1 (safe to build before Riley answers) is device-only localStorage**, using APP_MASTER's store shape exactly:
    `{"version":1,"stages":{"<jobNumber>":{"stage":"<key>","at":"<ISO UTC>","by":"<device label>"}}}`
  - Only non-`ready` entries are stored.
  - The frontend merges at load: `x.stage = STAGES[stageIndex((map[x.jobNumber]||{}).stage)].key`.
  - The sync bot never writes stages.

```js
var DEVICE_LABEL = (function () { try { return localStorage.getItem('ej_device') || (navigator.standalone ? 'iPhone app' : 'browser'); }
                                  catch (e) { return 'unknown'; } })();
var StageStore = {                                    // v1: this device only. For (b)/(c) replace ONLY this object.
  writable: true,
  read: function () { try { return JSON.parse(localStorage.getItem('ej_stages')) || { version: 1, stages: {} }; }
                      catch (e) { return { version: 1, stages: {} }; } },
  load: function () { return Promise.resolve(this.read().stages); },
  set: function (jobNumber, key) {
    var s = this.read();
    if (key === 'ready') delete s.stages[jobNumber];
    else s.stages[jobNumber] = { stage: key, at: new Date().toISOString(), by: DEVICE_LABEL };
    try { localStorage.setItem('ej_stages', JSON.stringify(s)); return Promise.resolve(); }
    catch (e) { return Promise.reject(e); }
  }
};
```

- **With v1, stages do not sync between devices.** Settings → Stages says "Saved on this device only", so Riley isn't surprised when the desktop doesn't match the phone.
- **The shared backend is Riley's call [Q1, Q2, Q10].** The options, from APP_MASTER R-1:
  - (b) `data/stages.json` written through the GitHub contents API with a **per-device fine-grained PAT**. Its rules are already in APP_MASTER: sha retry, a 5 s debounce, reads from the API rather than Pages, and a token scoped to this repo with contents read/write and an expiry.
  - (c) a Cloudflare Worker plus KV behind Cloudflare Access.
  **Do not choose one, create a token or account, or change repo visibility until the answer is recorded in APP_MASTER.**
- **The installed app does not share storage with Safari.** A Home Screen web app does not share localStorage, cookies, IndexedDB or the service worker with Safari; WebKit calls this intended behaviour ([WebKit 181849](https://bugs.webkit.org/show_bug.cgi?id=181849)). The consequences:
  - If option (b) is chosen, Riley creates the token and types or pastes it **himself** inside the installed app, under Settings → Stages → "Paste token". It is stored in that app's `localStorage['ej_gh_token']`.
  - Desktop Chrome needs its own paste.
  - **No "setup link" and no token in any URL, fragment or message.** Claude never sees, stores or enters the value (APP_MASTER rule 1).
  - Keep the token in a password manager so it can be re-pasted after reinstalling the icon.
- **Persistence:**
  - On first successful unlock in standalone, call `navigator.storage.persist()`. WebKit grants it by heuristics that include being a Home Screen web app, and Home Screen apps get the same quotas as the browser ([storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)).
  - Home Screen apps keep their own "days of use" counter for the 7-day script-storage cap, and actually using the app resets it ([WebKit ITP post](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)).
  - Deleting the icon probably deletes its data (not verified). With v1 that would lose the stages, which is another reason for [Q1].
- **Offline queue (b/c only):**
  - Unsent changes wait in `localStorage['ej_stage_queue']`.
  - They retry on `online` and `visibilitychange`.
  - The UI stays optimistic, and rolls back with an error toast after the final failure.

---

## 9. Build order, acceptance, and APP_MASTER entries

**Build order.** Follow APP_MASTER Rule 13 (feature branch; commit, then pull, then push). The work ships as two separate merges to `main`, each with its CHANGELOG entry.

**Merge A: reskin.**
- Styles and chrome:
  - tokens, glass and components CSS;
  - the shell (`#jmap` full-bleed, controls, accessory, tab bar, sheet, Settings view, toast);
  - the Client-mode filter with "solo, then add";
  - dark tiles and theme-color;
  - hyalite behind its gate.
- Install surface:
  - status bar and manifest changes;
  - the 180 px icon;
  - `sw.js` v2.
- Planner:
  - the single-map planner (`routeLayer`; `#pmap` retired);
  - the planner prerequisites.
- APP_MASTER's "Cheap fixes":
  - try/catch around storage;
  - `escapeHtml`;
  - the geocoder regex and extent;
  - the other listed items.
- The Stage segment in `#mode` is hidden in Merge A.

**Merge B: stages.**
- `STAGES` and `StageStore` v1.
- Stage mode (chips, pins with digits, list groups).
- The detail sheet and slider.
- The hover card.
- Toast and undo.
- The one-click route for the current selection.

**On Riley's iPhone (iOS 26.1+):**
1. **Setup:** delete and re-add the Home Screen icon after Merge A.
2. **Performance:** pan and zoom with the accessory showing, then with the sheet at medium. Scrolling must stay smooth, with no blur "pop" (Safari Web Inspector → Timelines).
3. **Status bar:** legible in Light and in Dark. If not, switch to `black` and re-add the icon.
4. **Stage slider** (Merge B):
   - Drag across all 6 stops: the lens magnifies and snaps with a slight bounce.
   - Tap the labels; Undo restores the previous stage.
   - Reload with ↻: the stage persists on this device. It also persists across devices once [Q1] is decided and implemented.
5. **Filters and routing:**
   - Stage mode → Base only → **Route** builds `S`, 1..n from the shop, with `~` estimates, "no live traffic", and Google Maps parts of at most 10 points.
   - At 25+ stops the app asks first, and the UI does not freeze.
   - Client mode: "solo, then add" works, and the choice is remembered after reload.
6. **Views:** Jobs, Routes (published maps open) and Plan (manual stops, picker, save, saved list) all work in the sheet.
7. **Theme:** Light, Dark and Auto swap tiles, `theme-color` and glass together. A quick double toggle never leaves the wrong basemap on screen.
8. **Glass modes:** Liquid, Tinted and Solid all render. Increase Contrast turns glass opaque, and Reduce Motion removes the springs.
9. **Keyboard:** search focus takes the sheet to large, and the keyboard never covers the focused field.
10. **Attribution:** visible above the accessory, and above the sheet at medium.

**On desktop Chrome/Edge:**
- The panel and the control capsule show edge refraction, with no stair-stepping at the rim.
- Hovering a pin opens the card, and the compact slider works.
- On a touch laptop, a tap does not open hover cards.
- Forcing `prefers-contrast: more` or `prefers-reduced-transparency: reduce` in DevTools disables refraction.

**APP_MASTER updates (in the same commit as the change):**
- **§2 and §4.3:**
  - new files: `css/tokens.css`, `css/glass.css`, `css/components.css`, `js/ui.js`, `js/app.js`, `vendor/hyalite.js`, `vendor/hyalite.LICENSE`, `icons/icon-180.png`;
  - the new DOM ids (`ctl`, `accessory`, `filterbar`, `mode`, `count`, `routeSel`, `sheet`, `detail`, `scrim`, `map-card`, `toast`, `v-settings`);
  - `pmap` retired;
  - the new localStorage keys.
- **§5:** stage colours (once [Q5] is answered) and the StageStore implementation in use.
- **§9 ADRs:**
  - ADR-14 amended (multi-file, still no build step).
  - "Glass on the navigation layer only; literal backdrop-filter values; no backdrop-root properties".
  - "Single map for jobs and planner".
- **Third-party code:**
  - sohumsuthar/liquid-glass @ `fb0e2dd` (MIT, adapted);
  - hyalite v0.5.0 @ `b9f2719` (MIT, unmodified, sha256 as in §1.2);
  - rdev (ideas only);
  - Leaflet 1.9.4 (BSD-2, SRI);
  - Esri tiles (terms and attribution; deprecation risk).
- **§12 CHANGELOG:** the status-bar change plus dynamic `theme-color`, with **"re-add the icon"** in bold.

---

## 10. Open questions that change this brief (record answers in APP_MASTER §11)

- **[Q1 / Q2 / Q10]** Stage storage backend, who can edit, and privacy. This picks the `StageStore` implementation (§8).
- **[Q3]** What happens to Poured jobs: stay visible, hidden by default, or dropped when Jobber closes them. It changes the chip defaults in Stage mode.
- **[Q4]** Route rules: return to the shop, pending 9000+ jobs, rural legs, and whether the route combines the client and stage filters. Today it is one mode at a time.
- **[Q5]** Stage colours (§2.5), and client/stage hue overlaps.
- **[Q6]** Desktop hover versus click only.
- **[Q8]** Which repo Riley meant (probably rdev/liquid-glass-react, React-only), automatic dark mode, icon redesign, and keeping the Esri light-gray tiles.
- **New:**
  - OK to change the chips from "tap hides" to "solo, then add"?
  - OK to move the list panel to the left on desktop?
  - OK to shorten the tab label to "Plan" and move Settings into the control capsule?

---

## Sources

(✓ = re-checked by the critic on 2026-09-25)

- **Glass repos:**
  - sohumsuthar/liquid-glass ✓: https://github.com/sohumsuthar/liquid-glass · core CSS ✓: https://raw.githubusercontent.com/sohumsuthar/liquid-glass/main/css/liquid-glass-core.css · LICENSE ✓: https://github.com/sohumsuthar/liquid-glass/blob/main/LICENSE
  - VII-Cae/hyalite ✓ (README, LICENSE and source read): https://github.com/VII-Cae/hyalite--liquid-glass
  - rdev/liquid-glass-react ✓: https://github.com/rdev/liquid-glass-react
  - liquidGL ✓: https://github.com/naughtyduk/liquidGL
  - Not re-checked: shuding https://github.com/shuding/liquid-glass · deepika https://github.com/deepika-builds/liquid-glass · samasante https://github.com/samasante/liquid-glass and https://github.com/samasante/liquid-glass/blob/main/BROWSERS.md · dashersw https://github.com/dashersw/liquid-glass-js · liquid-dom https://github.com/AndrewPrifer/liquid-dom · studio https://github.com/iyinchao/liquid-glass-studio · lucasromerodb https://github.com/lucasromerodb/liquid-glass-effect-macos · archisvaze https://github.com/archisvaze/liquid-glass
- **WebKit refraction status:** 245510 ✓ https://bugs.webkit.org/show_bug.cgi?id=245510 · PR 68614 ✓ https://github.com/WebKit/WebKit/pull/68614 · kube.io ✓ https://kube.io/blog/liquid-glass-css-svg/ · alastair.is ✓ https://alastair.is/apple-has-a-private-css-property-to-add-liquid-glass-effects-to-web-content/
- **Apple (HIG and WWDC):** HIG Materials ✓ https://developer.apple.com/design/human-interface-guidelines/materials · HIG Color ✓ https://developer.apple.com/design/human-interface-guidelines/color · HIG Sheets ✓ https://developer.apple.com/design/human-interface-guidelines/sheets · HIG Sliders ✓ https://developer.apple.com/design/human-interface-guidelines/sliders · HIG Segmented controls ✓ https://developer.apple.com/design/human-interface-guidelines/segmented-controls · HIG Tab bars ✓ https://developer.apple.com/design/human-interface-guidelines/tab-bars · HIG Toolbars ✓ https://developer.apple.com/design/human-interface-guidelines/toolbars · WWDC25-219 ✓ https://developer.apple.com/videos/play/wwdc2025/219/ · WWDC25-323 ✓ https://developer.apple.com/videos/play/wwdc2025/323/ · WWDC25-356 ✓ https://developer.apple.com/videos/play/wwdc2025/356/ · HIG Buttons https://developer.apple.com/design/human-interface-guidelines/buttons · HIG Maps https://developer.apple.com/design/human-interface-guidelines/maps · HIG Typography https://developer.apple.com/design/human-interface-guidelines/typography · HIG Accessibility https://developer.apple.com/design/human-interface-guidelines/accessibility · spring https://developer.apple.com/documentation/swiftui/animation/spring(response:dampingfraction:blendduration:) · WWDC23-10158 https://developer.apple.com/videos/play/wwdc2023/10158/ · meta tags https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html
- **Press and community:** MacRumors iOS 27 ✓ https://www.macrumors.com/2026/06/10/how-liquid-glass-is-changing-in-ios-27/ · Engadget 26.1 ✓ https://www.engadget.com/mobile/smartphones/how-to-adjust-the-liquid-glass-effect-in-ios-261-203634681.html · LearnUI ✓ https://www.learnui.design/blog/ios-design-guidelines-templates.html · Apple forums 796299 ✓ https://developer.apple.com/forums/thread/796299 · Apple forums 799216 ✓ https://developer.apple.com/forums/thread/799216
- **WebKit and Safari:** Safari 18.0 ✓ https://webkit.org/blog/15865/webkit-features-in-safari-18-0/ · 26.0 ✓ https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ · 26.1 https://webkit.org/blog/17541/webkit-features-for-safari-26-1/ · 27.0 ✓ https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ · storage policy ✓ https://webkit.org/blog/14403/updates-to-storage-policy/ · ITP ✓ https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ · WebKit 181849 ✓ https://bugs.webkit.org/show_bug.cgi?id=181849 · 264218 ✓ https://bugs.webkit.org/show_bug.cgi?id=264218 · 289800 ✓ https://bugs.webkit.org/show_bug.cgi?id=289800 · 301108 ✓ https://bugs.webkit.org/show_bug.cgi?id=301108 · BCD #25914 ✓ https://github.com/mdn/browser-compat-data/issues/25914
- **Support tables:** caniuse prefers-reduced-transparency ✓ https://caniuse.com/wf-prefers-reduced-transparency · vibrate ✓ https://caniuse.com/mdn-api_navigator_vibrate · linear() ✓ https://caniuse.com/mdn-css_types_easing-function_linear-function · interactive-widget ✓ https://caniuse.com/mdn-html_elements_meta_name_viewport_interactive-widget · prefers-contrast https://caniuse.com/mdn-css_at-rules_media_prefers-contrast · corner-shape ✓ https://squircle.js.org/blog/squircles-in-css
- **MDN:** containing block ✓ https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_display/Containing_block · userAgentData https://developer.mozilla.org/en-US/docs/Web/API/Navigator/userAgentData · backdrop-filter https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter
- **PWA and iOS field reports:** vcsudoku ✓ https://github.com/tmshv/vcsudoku/pull/38 · airtag-sentry ✓ https://github.com/mariusgassen/airtag-sentry/pull/23 · Coffee-SNOB ✓ https://github.com/ethan8damax/Coffee-SNOB/pull/7 · sokosumi ✓ https://github.com/masumi-network/sokosumi/pull/4666 · 1ar.io ✓ https://1ar.io/updates/safari-26-liquid-glass-web/ · ios-vibrator-pro-max ✓ https://github.com/samdenty/ios-vibrator-pro-max · MDN BCD #29166 ✓ https://github.com/mdn/browser-compat-data/issues/29166
- **Performance:** openreplay ✓ https://blog.openreplay.com/creating-blurred-backgrounds-css-backdrop-filter/ · flowrust ✓ https://blog.flowrust.com/2026/07/15/backdrop-filter-stack-glassmorphism-survives-safari/ · ambience-mixer ✓ https://github.com/steverowley/ambience-mixer/issues/2 · guitarbeat ✓ https://github.com/guitarbeat/personal-website/pull/1072 · codefronts ✓ https://codefronts.com/motion/css-transition-designs/glassmorphism-hover-transition/ · thisdevtool https://thisdevtool.com/blog/backdrop-filter-not-working-safari-fix
- **Motion:** Comeau https://www.joshwcomeau.com/animation/linear-timing-function/ · CSSWG https://lists.w3.org/Archives/Public/public-css-archive/2023Sep/0888.html
- **Leaflet and Esri:** leaflet.css ✓ https://unpkg.com/leaflet@1.9.4/dist/leaflet.css · leaflet-src.js ✓ https://unpkg.com/leaflet@1.9.4/dist/leaflet-src.js · panes https://leafletjs.com/reference.html#map-pane · BasemapLayer.js ✓ https://github.com/Esri/esri-leaflet/blob/master/src/Layers/BasemapLayer.js · basemapLayer (deprecated) ✓ https://developers.arcgis.com/esri-leaflet/api-reference/esri-leaflet/basemap-layer/ · terms ✓ https://developers.arcgis.com/esri-leaflet/terms-of-use/ · static tiles plugin ✓ https://github.com/Esri/esri-leaflet-static-basemap-tile · Esri upgrade blog (403 to fetch; seen via search) https://www.esri.com/arcgis-blog/products/developers/developers/open-source-developers-time-to-upgrade-to-the-new-arcgis-basemap-layer-service
- **Project (local):** `C:/Users/Riley/eckstein-jobs/APP_MASTER.md` (§4.3, §5 "Stage data", §11 R-1) · `C:/Users/Riley/eckstein-jobs/index.html` · `C:/Users/Riley/eckstein-jobs/sw.js` · `C:/Users/Riley/eckstein-jobs/manifest.json`

---

## Critic changes

**Alignment with the real app (APP_MASTER and index.html were not reflected in v1):**
1. **Tabs:** v1 dropped the existing **Routes** view (the published route maps). Restored: the tabs are Jobs · Routes · Plan, and Settings moved to the control capsule and the panel header.
2. **DOM ids:** kept stable (`#jmap`, `#tabs[data-v]`, `#chips`, `#q`, `#jlist`, `#upd`, `#rf`, `#v-*`, planner ids). `#map` was renamed to `#jmap`. `#pmap` is retired, and the planner draws on the single map through `routeLayer`.
3. **Stage keys:** v1 used numeric stages 1–6. The code now uses APP_MASTER's canonical keys (`ready`…`poured`) and store shape, and the slider was rewritten around keys.
4. **Storage:** v1 assumed a backend and an "edit key" delivered by a setup link (`#key=`). Storage is now the `StageStore` adapter with device-only v1. The backend is left to Riley [Q1], and the token-in-URL link was removed.
5. **Old CSS:** v1 didn't say to delete the old `<style>` block, whose class names collide. The block is deleted, and pins are renamed `.jpin`/`.rpin`.
6. **Service worker:** v1's precache advice was wrong; `sw.js` is network-first with no precache. Replaced with `ej-v2`, old-cache cleanup and path-keyed caching.
7. **Header controls:** the header's `#upd`, `#rf` and GitHub "Sync" link now have homes.
8. **Status cues:** the unscheduled and pending pin styles are kept, and unmapped jobs are handled.
9. **Planner rules:** APP_MASTER's planner prerequisites and route rules were added (≤10-point links, confirm above 25 stops, rural legs, `S`/1..n).
10. **Merges:** reskin and stages ship as two merges, and the ADR-14 multi-file amendment is logged.
11. **Chip behaviour:** v1 changed chips to single-select, which broke "like how we have it". They are now "solo, then add", flagged for Riley.

**Wrong or outdated claims:**
12. **Purple (dark):** the HIG value is 219,52,242, not "same".
13. **Canvas colours:** re-measured at #EFEFEF and #474749 (v1 had #ECECEC and #464648).
14. **Tab bar height:** 62px is our decision; the forum thread is a developer's custom constraint, not an Apple figure.
15. **`var()` in `-webkit-backdrop-filter`:** the evidence is mixed (a BCD report on Safari 18.3, and WebKit 289800 filed against WebKitGTK). The rule is kept as defensive.
16. **Safari 26.0:** it made `filter` establish a containing block. v1 claimed a change to backdrop-filter.
17. **Leaflet popups:** the fade uses inline opacity, so v1's CSS override did nothing. The override was removed, and so were all popups.
18. **hyalite wording:** `dispersion:0` is a single pass (v1 said it "halves" the work), and `smooth` is the anti-staircase. Added: never pass `edge:0`; call `refresh` after un-hiding a panel; consume the variables on the attached element only.
19. **theme-color source:** installed-app behaviour now cites vcsudoku. 1ar.io covers in-browser Safari, which ignores theme-color.
20. **Unverified or superseded citations:** dropped (thathtml, devyatov, Expo, atlaspuplabs, LogRocket). So were the "unmaintained since 2025-06" claim about rdev and the deepika UA-regex claim.
21. **Quotes:** paraphrased instead of quoted (copyright). The HIG slider exception is now worded as HIG states it.
22. **Refraction status:** WebKit refraction now has current dates (PR 68614 open as of 2026-09-20, plus PRs 68613 and 69566). Safari 26.1's bottom-gap fix is now cited.

**License and terms:**
23. **Pinned upstreams:** both repos are pinned by commit, with the hyalite sha256 recorded. `vendor/hyalite.LICENSE` is now a verbatim copy of upstream's LICENSE file (it exists), not retyped.
24. **rdev copyright:** corrected to "Copyright 2025 MAX ROVENSKY".
25. **Esri tiles:** the legacy tiles are deprecated, "could be deactivated without notice", and fall under Esri's terms. A contingency was added, and the attribution now uses the service's `copyrightText`.
26. **Leaflet:** SRI hashes added, verified against leafletjs.com.

**iOS and CSS/JS fixes:**
27. **Corner shape:** `corner-shape` is disabled on refracting elements, because hyalite's map assumes circular corners. The note clarifies that Safari has no `corner-shape`.
28. **Backdrop-root list:** rule 3 now includes `transform` and `will-change` on ancestors, per upstream's list.
29. **Selected chips:** they use a neutral fill, so only the Route button has a coloured background (HIG Color).
30. **Route markers:** route stops are rounded squares, and job pins are hidden while a route is shown, so stop "#3" can't be confused with stage digit 3.
31. **Sheet padding:** the sheet body padding now includes `safe-area-inset-bottom`.
32. **Attribution:** it follows the sheet at medium through `--attr-b`, and the accessory height is measured.
33. **Stale listeners:** fixed the leftover `{once:true}` pointer listeners in the sheet and slider.
34. **Stuck sheet:** fixed the sheet sticking when a snap causes no movement (no `transitionend` fires).
35. **Stage-name placeholder:** v1's placeholder line for the stage name was replaced with real code.
36. **Disabled slider:** the disabled state now blocks label and keyboard input as well as drag.
37. **Slider listener leak:** v1 remounted the slider on every hover. It is now mounted once and rebound with `set(job)`.
38. **Basemap race:** fixed the case where a quick theme toggle could leave the wrong basemap on screen.
39. **Hover gating:** hover is gated on `(hover:hover) and (pointer:fine)`, not on width.
40. **Missing JS added:** a `layout()` that un-hides the desktop panel; generic detail-sheet parameterisation; accessory swipe and tap; view switching; toast/undo; resize re-snap.
41. **Haptics:** `navigator.vibrate` is confirmed unsupported. An optional, fragile iOS 18 switch-haptic path is noted.
42. **Device checks added:** status-bar legibility in Dark theme (fallback `black`), and possible jank from the scroll-edge mask.