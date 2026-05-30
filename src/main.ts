import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { mountTorontoMap } from "./mapTiles";
import { mountParticleHero } from "./particleHero";
import "./styles.css";

gsap.registerPlugin(ScrollTrigger);

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const cleanups: Array<() => void> = [];

document.querySelectorAll<HTMLElement>("[data-toronto-map]").forEach((container) => {
  const zoom = container.dataset.torontoMap === "terminal" || container.dataset.torontoMap === "app-terminal" ? 14 : 12;
  cleanups.push(mountTorontoMap(container, zoom));
});

if (!reducedMotion) {
  const lenis = new Lenis({
    lerp: 0.08,
    wheelMultiplier: 0.9,
    touchMultiplier: 1.1,
  });

  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
  cleanups.push(() => lenis.destroy());
}

const revealElements = gsap.utils.toArray<HTMLElement>(".reveal");
revealElements.forEach((element) => {
  gsap.set(element, { autoAlpha: 0, y: 48, filter: "blur(12px)" });
  ScrollTrigger.create({
    trigger: element,
    start: "top 82%",
    once: true,
    onEnter: () => {
      gsap.to(element, {
        autoAlpha: 1,
        y: 0,
        filter: "blur(0px)",
        duration: reducedMotion ? 0.2 : 0.8,
        ease: "power3.out",
      });
    },
  });
});

const heroLp = document.querySelector<HTMLElement>("#hero-lp");
const terminalApp = document.querySelector<HTMLElement>("#terminal-app");
const openTerminalButtons = document.querySelectorAll<HTMLButtonElement>("[data-open-terminal]");
const closeTerminalButtons = document.querySelectorAll<HTMLButtonElement>("[data-close-terminal]");
const beginStoryLinks = document.querySelectorAll<HTMLElement>("[data-begin-story]");

const openTerminal = () => {
  if (!terminalApp) {
    return;
  }

  terminalApp.setAttribute("aria-hidden", "false");
  document.body.classList.add("terminal-open");
  terminalApp.querySelector<HTMLButtonElement>("[data-close-terminal]")?.focus();
};

const closeTerminal = () => {
  if (!terminalApp) {
    return;
  }

  terminalApp.setAttribute("aria-hidden", "true");
  document.body.classList.remove("terminal-open");
  openTerminalButtons[0]?.focus();
};

openTerminalButtons.forEach((button) => button.addEventListener("click", openTerminal));
closeTerminalButtons.forEach((button) => button.addEventListener("click", closeTerminal));
beginStoryLinks.forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    const hero = document.querySelector<HTMLElement>("#hero");
    if (!hero) return;
    const targetY = hero.getBoundingClientRect().top + window.scrollY + window.innerHeight * 0.5;
    window.scrollTo({ top: targetY, behavior: reducedMotion ? "auto" : "smooth" });
  });
});
terminalApp?.addEventListener("click", (event) => {
  if (event.target === terminalApp) {
    closeTerminal();
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("terminal-open")) {
    closeTerminal();
  }
});

const agentForm = document.querySelector<HTMLFormElement>("[data-agent-form]");
const agentInput = agentForm?.querySelector<HTMLInputElement>("input[name='command']");
const agentOutput = document.querySelector<HTMLOutputElement>("[data-agent-output]");
let activeAgent = "Ops Agent";

const setAgentOutput = (message: string) => {
  if (!agentOutput) {
    return;
  }

  const timestamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  agentOutput.value = `[${timestamp}] ${activeAgent}: ${message}`;
  agentOutput.textContent = agentOutput.value;
};

document.querySelectorAll<HTMLButtonElement>("[data-agent-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    const prompt = button.dataset.agentPrompt ?? "";
    if (agentInput) {
      agentInput.value = prompt;
      agentInput.focus();
    }
    setAgentOutput(`Queued question: "${prompt}". Placeholder hook ready for local model execution.`);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-agent-route]").forEach((button) => {
  button.addEventListener("click", () => {
    activeAgent = button.dataset.agentRoute ?? "Ops Agent";
    document.querySelectorAll<HTMLButtonElement>("[data-agent-route]").forEach((route) => {
      route.classList.toggle("is-active", route === button);
    });
    setAgentOutput(`Route selected. Future questions will target ${activeAgent}.`);
  });
});

agentForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = agentInput?.value.trim();
  if (!command) {
    setAgentOutput("Waiting for a question about the current Toronto scenario.");
    return;
  }
  setAgentOutput(`Queued "${command}" for retrieval, source attribution, and manager-ready answer synthesis.`);
});

async function boot() {
  const canvas = document.querySelector<HTMLCanvasElement>("#particle-canvas");
  if (!canvas) {
    throw new Error("Particle canvas missing");
  }

  try {
    document.body.classList.add("lp-visible");
    cleanups.push(await mountParticleHero({ canvas, reducedMotion, onProgress: (p) => {
      const gone = p > 0.025;
      if (heroLp) heroLp.classList.toggle("is-gone", gone);
      document.body.classList.toggle("lp-visible", !gone);
    }}));
  } finally {
    document.body.classList.add("is-ready");
    window.setTimeout(() => document.querySelector("#boot")?.remove(), 650);
  }
}

void boot();

window.addEventListener("beforeunload", () => {
  cleanups.forEach((cleanup) => cleanup());
});
