# Bubble AI Note — Working Package

Everything built so far for the Bubble AI Note Chrome extension: the
architecture writeup and the two frontend prototypes. Open the `.html`
files directly in any browser to view/edit them — no build step, no
dependencies to install.

```
bubble-ai-note-package/
├── docs/
│   └── architecture.md            Full system architecture (extension layer,
│                                   local ML personalization layer, provider
│                                   router with fallback chain, cost model)
└── frontend/
    ├── landing-page.html          Marketing landing page (single-viewport,
    │                               halftone/dot-pattern backdrop, glass demo
    │                               panel, mode triptych)
    └── signin-boot-animation.html Sign-in screen + the 3-bubble ASCII
                                    pop → name reveal → chat-load boot sequence
```

## docs/architecture.md
The current system design: Chrome MV3 extension layer, the fully-local
personalization stack (embeddings + clustering + retrieval — zero API cost),
the LLM provider router (Groq primary → Gemini fallback → OpenRouter
tertiary, plus an optional offline Ollama mode), and the SQLite/FastAPI
backend. Treat this as the living spec — update it as decisions change.

## frontend/landing-page.html
Self-contained HTML/CSS/JS, no external dependencies besides Google Fonts
(Fraunces + IBM Plex Sans). Everything — copy, layout tokens, colors — is
editable directly in the `<style>` block and markup. Key sections to know:
- `.stage` — the browser-mockup + mode-triptych composition on the right
- `.halftone` — the dot-field backdrop layer
- `--accent` CSS variable — the single accent color used throughout

## frontend/signin-boot-animation.html
Uses the Tailwind CDN (`cdn.tailwindcss.com`) for utility classes, plus two
`<canvas>`/`<pre>` procedural renderers (no video/image assets):
- Dither canvas — the right-panel background art on the sign-in card
- ASCII sphere — inside the floating "BUDGET" dock
- `runSequence()` in the boot script — the 3-bubble expand → pop → name →
  chat animation. Timing constants (`growEnd`, `popDur`, `nameAt`, `chatAt`)
  are all named and adjustable at the top of that function.

Click **Sign In** on the card to trigger the boot sequence; click the
finished chat panel to replay it.

## Suggested next steps
- Wire `signin-boot-animation.html`'s boot sequence into the actual
  extension's `popup.html` / content-script UI
- Swap the landing page's CTA links to the real Chrome Web Store listing
  once published
- Keep `docs/architecture.md` in sync as the provider router / personalization
  layer gets implemented
