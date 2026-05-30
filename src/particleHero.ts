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

  float twist = drama * (0.22 + seed * 0.48) + uScrollProgress * 0.34;
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


export async function mountParticleHero(_o: ParticleHeroOptions){return()=>{};}
