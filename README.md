# CityFlow Landing Page

CityFlow is a cinematic static landing page for NVIDIA Spark Hack Toronto. It presents CityFlow as a local-first city intelligence operating system for Toronto small businesses: a "Bloomberg Terminal for physical businesses" that reads transit, weather, events, construction, and road activity before those signals hit revenue.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Scene Pipeline

The hero uses one persistent Three.js `Points` geometry. It does not create a new particle system per section.

1. Each narrative scene is defined as an inline SVG in `src/silhouettes.ts`.
2. On boot, each SVG is rasterized to an offscreen canvas.
3. Opaque pixels are collected, resampled to the exact particle count, normalized, centered, and mapped into 3D.
4. The resulting Float32Array for each scene becomes a target position buffer.
5. ScrollTrigger maps scroll progress across the scene list and updates the active `positionA`, `positionB`, and `uMorph` shader inputs.
6. The vertex shader mixes `positionA` and `positionB` and adds a midpoint billow using stable per-particle random directions.

Desktop uses roughly 42k particles; mobile uses roughly 15k. DPR is capped at 2, and the render loop pauses when the tab is hidden.

## Swapping Silhouettes

To add or replace a morph target:

1. Open `src/silhouettes.ts`.
2. Add or edit a `SceneDefinition`.
3. Keep the SVG viewBox at `0 0 1000 600`.
4. Use opaque white shapes for the silhouette. Transparent or black areas are ignored.
5. Set the scene color, optional palette, and depth.
6. Update the matching DOM copy in `index.html` if the narrative scene count changes.

The particle count stays fixed. If one silhouette has fewer source pixels than another, the sampler duplicates source pixels deterministically so every scene still produces exactly N particles.

## Real Toronto Map

The loading terminal and signal terminal load real OpenStreetMap tiles centered on downtown Toronto using `src/mapTiles.ts`. The tile grid is static frontend code and includes attribution in the page.
