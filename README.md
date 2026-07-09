# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

## Road snapping (OpenRouteService)

Routes can snap to real roads instead of drawing straight lines, anywhere with OSM coverage — not limited to any one city. This runs against the [OpenRouteService](https://openrouteservice.org/) directions API (foot-walking profile).

**Setup:**

1. Sign up for a free API key at [openrouteservice.org/dev](https://openrouteservice.org/dev/#/signup) → Dashboard → request a token for the "Directions" service.
2. Create `.env.local` in the project root (see `.env.example`):
   ```
   VITE_ORS_API_KEY=your-key-here
   ```
3. `npm run dev` as normal.

If no key is set, the API call fails, or a request times out, the app falls back to the geometric (straight-line) preview with a status message — nothing else breaks.
