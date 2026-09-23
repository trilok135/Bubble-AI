# Bubble AI Note — Working Package

Everything built so far for the Bubble AI Note Chrome extension: the
architecture writeup and the two frontend prototypes. Open the `.html`
files directly in any browser to view/edit them — no build step, no
dependencies to install.

```
bubble-ai-note-package/
├── docs/
│   ├── architecture.md             Full system architecture (extension layer,
│   │                                local ML personalization layer, provider
│   │                                router with fallback chain, cost model)
│   └── model-selection-rubric.md   Scoring rubric for comparing candidate
│                                    LLM providers on reasoning depth + tone
├── backend/
│   └── personalization/            Real, runnable Python module for
│                                    understanding a user's grasp of each
│                                    topic — see its own README for details
└── frontend/
    ├── landing-page.html           Marketing landing page (single-viewport,
    │                                halftone/dot-pattern backdrop, glass demo
    │                                panel, mode triptych)
    └── signin-boot-animation.html  Sign-in screen + the 3-bubble ASCII
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

## backend/personalization/
A tested, runnable implementation of "figure out what the user understands"
— topic clustering, per-topic struggle scoring, auto mode-classification,
and memory retrieval, all running on TF-IDF + scikit-learn (no API calls,
no model download). Run `python3 backend/personalization/demo.py` to see
it process a simulated session end-to-end. Its own README documents a real
limitation (TF-IDF clusters on shared words, not meaning) and exactly
where to swap in a semantic embedder if that starts to matter.

## Suggested next steps
- Wire `signin-boot-animation.html`'s boot sequence into the actual
  extension's `popup.html` / content-script UI
- Swap the landing page's CTA links to the real Chrome Web Store listing
  once published
- Keep `docs/architecture.md` in sync as the provider router / personalization
  layer gets implemented
