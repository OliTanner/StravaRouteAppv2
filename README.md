# RouteArt

A lightweight route planner. Pick a start, a target distance, and either **Loop** (a real, street-snapped loop near your start — no shape required) or **Shape** (draw a route in the outline of a heart, star, or anything you describe). Export as GPX, or save it locally to revisit later.

## Running locally

Two dev servers are involved because the app has one small serverless function:

- `npm run dev` — plain Vite dev server. Works for everything except the AI shape generator (`/api/generate-shape` isn't served).
- `vercel dev` — wraps the Vite dev server **and** serves the `api/` folder, so the AI generator works too. This is what you want for full local testing.

```bash
npm install
npx vercel dev
```

(`vercel dev` reads the same `.env.local` as Vite — `VITE_`-prefixed vars are exposed to the browser bundle as usual; unprefixed vars like `ANTHROPIC_API_KEY` stay server-side, readable only by functions under `api/`.)

## Environment variables

Copy `.env.example` to `.env.local` and fill in:

- **`VITE_ORS_API_KEY`** — free key from [openrouteservice.org/dev](https://openrouteservice.org/dev/#/signup) (Dashboard → request a token for "Directions"). Powers both Loop mode's round-trip routing and Shape mode's road-snapping. If missing, expired, or a request fails, the app falls back to a geometric preview with a status message — nothing else breaks.
- **`ANTHROPIC_API_KEY`** — server-only key from the [Anthropic Console](https://console.anthropic.com/settings/keys), used by `api/generate-shape.js` for "…or describe anything" in Shape mode. In production, set this in your hosting provider's environment variable settings (not in a file that gets deployed). If missing or the call fails, that feature falls back to a procedural abstract-shape generator with a status message.

## Deploying

Built for [Vercel](https://vercel.com/) — it auto-detects the Vite static build and deploys `api/generate-shape.js` as a serverless function alongside it. Set both env vars above in the Vercel project's Environment Variables settings before deploying.
