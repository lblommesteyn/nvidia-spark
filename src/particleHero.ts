import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { scenes, type SceneDefinition } from "./silhouettes";

gsap.registerPlugin(ScrollTrigger);

interface SceneCloud {
  positions: Float32Array;
  colors: Float32Array;
}

interface ParticleHeroOptions {
  canvas: HTMLCanvasElement;
  reducedMotion: boolean;
  onProgress?: (progress: number) => void;
}

const rasterWidth = 1000;
const rasterHeight = 600;

const vertexShader = `
attribute vec3 positionA;
attribute vec3 positionB;
attribute vec3 randomDir;
attribute float seed;
attribute vec3 colorA;
attribute vec3 colorB;

uniform float uMorph;
uniform float uTime;
uniform float uBillow;
uniform float uAmbient;
uniform float uShock;
uniform float uScrollProgress;
uniform float uScrollVelocity;
uniform float uPixelRatio;
uniform float uPointSize;
uniform float uCursorX;
uniform float uCursorY;

varying vec3 vColor;
varying float vAlpha;

// The geometry is persistent. ScrollTrigger only swaps the A/B target
// attributes at scene boundaries and scrubs uMorph between them.
void main() {
  float easedMorph = smoothstep(0.0, 1.0, uMorph);
  vec3 p = mix(positionA, positionB, easedMorph);

  // At the midpoint of each transition, push particles outward along a
  // stable per-particle direction so the cloud billows before reassembly.
  float transitionPulse = sin(uMorph * 3.14159265);
  float breathing = 0.72 + 0.28 * sin(uTime * 1.4 + seed * 6.2831853);
  float velocitySurge = clamp(abs(uScrollVelocity) / 3600.0, 0.0, 1.0);
  float drama = uShock * (1.0 + velocitySurge * 1.25);
  p += randomDir * transitionPulse * uBillow * breathing;

  vec2 radial = normalize(p.xy + vec2(0.001));
  p.xy += radial * drama * uBillow * (0.28 + seed * 0.24);

  float twist = drama * (0.22 + seed * 0.48);
  float s = sin(twist);
  float c = cos(twist);
  p.xy = mat2(c, -s, s, c) * p.xy;
  p.z += sin(length(p.xy) * 1.2 - uTime * 1.6 + seed * 6.2831853) * drama * uBillow * 0.24;

  float idleWave = sin(uTime * 0.48 + seed * 6.2831853);
  float idleDrift = cos(uTime * 0.33 + seed * 9.217);
  p += randomDir * uAmbient * (idleWave * 0.62 + idleDrift * 0.38);

  p.x += p.y * uCursorX * 0.22;
  p.y += p.x * uCursorY * 0.08;
  p.z += (p.x * uCursorX + p.y * uCursorY) * 0.1;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  float depthScale = 8.0 / max(2.0, -mvPosition.z);
  gl_PointSize = uPointSize * uPixelRatio * depthScale * (1.0 + drama * 0.32);
  vColor = mix(colorA, colorB, easedMorph);
  vAlpha = 0.64 + 0.24 * transitionPulse + velocitySurge * 0.12;
}
`;

const fragmentShader = `
precision highp float;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float radius = length(uv);
  if (radius > 0.5) {
    discard;
  }

  // Crisp round sprite with a narrow soft edge so silhouettes remain legible.
  float alpha = smoothstep(0.48, 0.32, radius) * vAlpha;
  gl_FragColor = vec4(vColor, alpha);
}
`;

const mulberry32 = (seed: number) => {
  let value = seed;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result;
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
};

const loadSvgImage = async (svg: string) => {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Failed to load silhouette"));
  });
  image.src = url;

  try {
    await image.decode().catch(() => loaded);
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
};

const pickColor = (scene: SceneDefinition, rng: () => number) => {
  const palette = scene.palette ?? [scene.color];
  const base = palette[Math.floor(rng() * palette.length)] ?? scene.color;
  const jitter = 0.88 + rng() * 0.2;
  return [
    Math.min(1, base[0] * jitter),
    Math.min(1, base[1] * jitter),
    Math.min(1, base[2] * jitter),
  ] as [number, number, number];
};

async function sampleScene(scene: SceneDefinition, count: number, seed: number): Promise<SceneCloud> {
  const image = await loadSvgImage(scene.svg);
  const canvas = document.createElement("canvas");
  canvas.width = rasterWidth;
  canvas.height = rasterHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("Canvas 2D context unavailable");
  }

  context.clearRect(0, 0, rasterWidth, rasterHeight);
  context.drawImage(image, 0, 0, rasterWidth, rasterHeight);

  const pixels = context.getImageData(0, 0, rasterWidth, rasterHeight).data;
  const opaque: Array<[number, number]> = [];
  let minX = rasterWidth;
  let minY = rasterHeight;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < rasterHeight; y += 2) {
    for (let x = 0; x < rasterWidth; x += 2) {
      const alpha = pixels[(y * rasterWidth + x) * 4 + 3];
      if (alpha > 24) {
        opaque.push([x, y]);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (!opaque.length) {
    throw new Error(`No pixels found for scene ${scene.id}`);
  }

  const rng = mulberry32(seed);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const maxSide = Math.max(maxX - minX, maxY - minY);
  const scale = 8.2;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    const [x, y] = opaque[Math.floor(rng() * opaque.length)];
    const jitterX = (rng() - 0.5) * 0.9;
    const jitterY = (rng() - 0.5) * 0.9;
    positions[i * 3] = ((x + jitterX - centerX) / maxSide) * scale;
    positions[i * 3 + 1] = -((y + jitterY - centerY) / maxSide) * scale;
    positions[i * 3 + 2] = (rng() - 0.5) * scene.depth;

    const color = pickColor(scene, rng);
    colors[i * 3] = color[0];
    colors[i * 3 + 1] = color[1];
    colors[i * 3 + 2] = color[2];
  }

  return { positions, colors };
}

function makeRandomAttributes(count: number) {
  const rng = mulberry32(92821);
  const dirs = new Float32Array(count * 3);
  const seeds = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    let x = rng() * 2 - 1;
    let y = rng() * 2 - 1;
    let z = rng() * 2 - 1;
    const length = Math.hypot(x, y, z) || 1;
    x /= length;
    y /= length;
    z /= length;
    dirs[i * 3] = x;
    dirs[i * 3 + 1] = y;
    dirs[i * 3 + 2] = z;
    seeds[i] = rng();
  }

  return { dirs, seeds };
}

export async function mountParticleHero({ canvas, reducedMotion, onProgress }: ParticleHeroOptions) {
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  const count = mobile ? 15000 : 42000;
  const clouds = await Promise.all(scenes.map((scene, index) => sampleScene(scene, count, 1000 + index * 7919)));
  const randomAttributes = makeRandomAttributes(count);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x020504, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(mobile ? 58 : 48, 1, 0.1, 100);
  const baseCameraZ = mobile ? 9.7 : 8.4;
  camera.position.set(0, 0, baseCameraZ);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(clouds[0].positions, 3));
  geometry.setAttribute("positionA", new THREE.BufferAttribute(clouds[0].positions, 3));
  geometry.setAttribute("positionB", new THREE.BufferAttribute(clouds[1].positions, 3));
  geometry.setAttribute("colorA", new THREE.BufferAttribute(clouds[0].colors, 3));
  geometry.setAttribute("colorB", new THREE.BufferAttribute(clouds[1].colors, 3));
  geometry.setAttribute("randomDir", new THREE.BufferAttribute(randomAttributes.dirs, 3));
  geometry.setAttribute("seed", new THREE.BufferAttribute(randomAttributes.seeds, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 24);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uMorph: { value: 0 },
      uTime: { value: 0 },
      uBillow: { value: reducedMotion ? 0 : mobile ? 0.82 : 1.34 },
      uAmbient: { value: reducedMotion ? 0 : mobile ? 0.035 : 0.06 },
      uShock: { value: 0 },
      uScrollProgress: { value: 0 },
      uScrollVelocity: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uPointSize: { value: mobile ? 2.75 : 3.1 },
      uCursorX: { value: 0 },
      uCursorY: { value: 0 },
    },
  });

  const points = new THREE.Points(geometry, material);
  scene.add(points);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), mobile ? 0.22 : 0.28, 0.28, 0.72);
  composer.addPass(bloom);

  let width = 0;
  let height = 0;
  let rafId = 0;
  let visible = !document.hidden;
  let sceneIndex = 0;
  let targetMouseX = 0;
  let targetMouseY = 0;
  let mouseX = 0;
  let mouseY = 0;
  let cursorSkew = 0;
  let targetShock = 0;
  let currentShock = 1.8;
  let targetScrollVelocity = 0;
  let currentScrollVelocity = 0;
  let currentProgress = 0;
  const rootStyle = document.documentElement.style;

  const setPair = (a: number, b: number) => {
    if (sceneIndex === a && (geometry.getAttribute("positionB") as THREE.BufferAttribute).array === clouds[b].positions) {
      return;
    }

    sceneIndex = a;
    geometry.setAttribute("position", new THREE.BufferAttribute(clouds[a].positions, 3));
    geometry.setAttribute("positionA", new THREE.BufferAttribute(clouds[a].positions, 3));
    geometry.setAttribute("positionB", new THREE.BufferAttribute(clouds[b].positions, 3));
    geometry.setAttribute("colorA", new THREE.BufferAttribute(clouds[a].colors, 3));
    geometry.setAttribute("colorB", new THREE.BufferAttribute(clouds[b].colors, 3));
  };

  const setActiveCopy = (active: number) => {
    document.querySelectorAll<HTMLElement>("[data-scene-copy]").forEach((element) => {
      element.classList.toggle("is-active", Number(element.dataset.sceneCopy) === active);
    });
    document.querySelectorAll<HTMLElement>("[data-scene-dot]").forEach((element) => {
      element.classList.toggle("is-active", Number(element.dataset.sceneDot) === active);
    });
    document.querySelectorAll<HTMLElement>("[data-story-line]").forEach((element) => {
      element.classList.toggle("is-active", Number(element.dataset.storyLine) === active);
    });
  };

  const updateProgress = (progress: number, velocity = 0) => {
    const scenePosition = progress * (scenes.length - 1);
    const activeCopy = Math.min(scenes.length - 1, Math.max(0, Math.round(scenePosition)));
    setActiveCopy(activeCopy);
    currentProgress = progress;

    if (reducedMotion) {
      setPair(activeCopy, activeCopy);
      material.uniforms.uMorph.value = 0;
      material.uniforms.uShock.value = 0;
      return;
    }

    const index = Math.min(scenes.length - 2, Math.floor(scenePosition));
    const nextIndex = Math.min(scenes.length - 1, index + 1);
    const rawMorph = scenePosition - index;
    const easedMorph = rawMorph < 0.38 ? 0 : Math.min(1, (rawMorph - 0.38) / 0.62);
    setPair(index, nextIndex);
    material.uniforms.uMorph.value = progress >= 0.999 ? 1 : easedMorph;
    targetShock = Math.sin(Math.min(1, Math.max(0, rawMorph)) * Math.PI);
    targetScrollVelocity = velocity;
    material.uniforms.uScrollProgress.value = progress;
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    material.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2);
  };

  const pointerMove = (event: PointerEvent) => {
    targetMouseX = (event.clientX / window.innerWidth - 0.5) * 0.42;
    targetMouseY = (event.clientY / window.innerHeight - 0.5) * 0.28;
  };

  const render = (time = 0) => {
    if (!visible) {
      return;
    }

    mouseX += (targetMouseX - mouseX) * 0.045;
    mouseY += (targetMouseY - mouseY) * 0.045;
    currentShock += (targetShock - currentShock) * 0.08;
    currentScrollVelocity += (targetScrollVelocity - currentScrollVelocity) * 0.08;
    cursorSkew += (targetMouseX * -9 - cursorSkew) * 0.055;
    camera.position.x = mouseX;
    camera.position.y = -mouseY;
    camera.position.z =
      baseCameraZ -
      (reducedMotion ? 0 : currentShock * (mobile ? 0.45 : 1.05)) -
      currentProgress * (mobile ? 0.18 : 0.42);
    camera.lookAt(0, 0, 0);
    points.rotation.y = mouseX * 0.08;
    points.rotation.x = mouseY * 0.06;
    material.uniforms.uTime.value = time * 0.001;
    material.uniforms.uShock.value = reducedMotion ? 0 : currentShock;
    material.uniforms.uScrollVelocity.value = reducedMotion ? 0 : currentScrollVelocity;
    material.uniforms.uCursorX.value = reducedMotion ? 0 : mouseX;
    material.uniforms.uCursorY.value = reducedMotion ? 0 : mouseY;
    rootStyle.setProperty("--cursor-skew", reducedMotion ? "0deg" : `${cursorSkew.toFixed(3)}deg`);
    composer.render();
    rafId = window.requestAnimationFrame(render);
  };

  const visibilityChange = () => {
    visible = !document.hidden;
    if (visible) {
      rafId = window.requestAnimationFrame(render);
    } else {
      window.cancelAnimationFrame(rafId);
    }
  };

  const trigger = ScrollTrigger.create({
    trigger: "#hero",
    start: "top top",
    end: "bottom bottom",
    pin: "#hero-pin",
    scrub: true,
    anticipatePin: 1,
    onUpdate: (self) => { updateProgress(self.progress, self.getVelocity()); onProgress?.(self.progress); },
  });

  resize();
  updateProgress(0);
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", pointerMove);
  document.addEventListener("visibilitychange", visibilityChange);
  rafId = window.requestAnimationFrame(render);

  return () => {
    trigger.kill();
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointermove", pointerMove);
    document.removeEventListener("visibilitychange", visibilityChange);
    window.cancelAnimationFrame(rafId);
    rootStyle.setProperty("--cursor-skew", "0deg");
    geometry.dispose();
    material.dispose();
    composer.dispose();
    renderer.dispose();
  };
}
