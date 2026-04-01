# Magic Wand Motion Studio

A Vue + Vite PWA for recording smartphone motion as "wand spells". It listens to:

- Accelerometer data
- Gyroscope rotation data
- Device orientation / compass heading when available

You can record a spell, let the app synthesize step-by-step movement instructions, save it locally, and then try to copy the motion to get a similarity score.

## Run

```bash
npm install
npm run dev
```

For LAN testing on a real phone:

```bash
npm run host
```

## Build

```bash
npm run build
npm run preview
```

## Deploy To Vercel

This repo is ready for a standard Vercel static deployment:

- Framework preset: `Vite`
- Build command: `npm run build`
- Output directory: `dist`
- Node version: `^20.19.0 || >=22.12.0`

The repo includes [vercel.json](/home/davidhofer/Desktop/github_repos_hofda/MagicWand/vercel.json), which also adds an SPA rewrite so direct links keep working.

### Fastest deploy paths

Import the repo in the Vercel dashboard and deploy with defaults, or from the project root run:

```bash
npx vercel
```

For a production deploy:

```bash
npx vercel --prod
```

## Notes

- iPhone / iPad browsers usually require a tap-triggered permission request before motion and orientation data become available.
- Compass heading quality varies by browser and hardware. The app will still work when heading is unavailable.
- Recordings are stored in `localStorage`, so they stay on the device but are not synced.
- If you deploy under a sub-path instead of the domain root, update the Vite `base` option in [vite.config.js](/home/davidhofer/Desktop/github_repos_hofda/MagicWand/vite.config.js).
