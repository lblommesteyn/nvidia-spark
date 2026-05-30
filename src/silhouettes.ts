export interface SceneDefinition {
  id: string;
  label: string;
  color: [number, number, number  {
    id: "wordmark",
    label: "CityFlow",
    color: [0.49, 1, 0.75],
    palette: [
      [0.49, 1, 0.75],
      [0.35, 0.73, 1],
      [1, 0.72, 0.25],
    ],
    depth: 0.42,
    svg: svgFrame(`
      <text x="500" y="330" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="154" letter-spacing="2" stroke="none">CityFlow</text>
      <path d="M230 392 C350 430 650 430 770 392" fill="none" stroke-width="22"/>
      <circle cx="230" cy="392" r="22"/>
      <circle cx="500" cy="415" r="18"/>
      <circle cx="770" cy="392" r="22"/>
    `),
  },
];
  palette?: Array<[number, number, number]>;
  depth: number;
  svg: string;
}

const svgFrame = (content: string) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600" width="1000" height="600">
  <rect width="1000" height="600" fill="black" fill-opacity="0"/>
  <g fill="white" stroke="white" stroke-linecap="round" stroke-linejoin="round">
    ${content}
  </g>
</svg>`;

export const scenes: SceneDefinition[] = [
  {
    id: "toronto-sign",
    label: "Nathan Phillips Square TORONTO sign",
    color: [0.48, 0.9, 1],
    palette: [[0.48, 0.9, 1], [0.95, 0.98, 1], [1, 0.24, 0.28]],
    depth: 0.42,
    svg: svgFrame(`
      <text x="500" y="355" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="168" letter-spacing="4" stroke="none">TORONTO</text>
      <path d="M138 404 L862 404" fill="none" stroke-width="28"/>
      <path d="M185 424 L815 424" fill="none" stroke-width="12"/>
      <rect x="146" y="392" width="66" height="52" rx="8"/>
      <rect x="790" y="392" width="66" height="52" rx="8"/>
    `),
  },
  {
    id: "skyline",
    label: "CN Tower and skyline",
    color: [0.55, 0.95, 1],
    palette: [[0.48, 0.86, 1], [0.74, 1, 0.9], [1, 0.74, 0.32]],
    depth: 0.58,
    svg: svgFrame(`
      <rect x="62" y="420" width="78" height="82" rx="4"/>
      <rect x="150" y="352" width="88" height="150" rx="4"/>
      <rect x="252" y="386" width="82" height="116" rx="4"/>
      <rect x="350" y="308" width="84" height="194" rx="4"/>
      <rect x="445" y="376" width="88" height="126" rx="4"/>
      <rect x="610" y="326" width="86" height="176" rx="4"/>
      <rect x="712" y="382" width="74" height="120" rx="4"/>
      <rect x="806" y="358" width="104" height="144" rx="4"/>
      <path d="M548 504 L548 244 L525 228 L571 228 L548 244 Z"/>
      <path d="M548 228 L548 66" fill="none" stroke-width="18"/>
      <path d="M510 298 C522 270 574 270 586 298 C574 320 522 320 510 298 Z"/>
      <path d="M502 330 C520 306 576 306 594 330" fill="none" stroke-width="16"/>
      <path d="M96 504 L920 504" fill="none" stroke-width="26"/>
      <path d="M232 336 L244 304 L256 336 Z"/>
      <path d="M700 320 L713 288 L726 320 Z"/>
    `),
  },
  {
    id: "streetcar",
    label: "TTC Flexity streetcar",
    color: [1, 0.24, 0.28],
    palette: [[1, 0.24, 0.28], [1, 0.7, 0.34], [0.82, 0.92, 1]],
    depth: 0.5,
    svg: svgFrame(`
      <rect x="130" y="210" width="740" height="228" rx="48"/>
      <path d="M154 246 C215 186 785 186 846 246" fill="none" stroke-width="34"/>
      <rect x="190" y="252" width="132" height="74" rx="14" fill="black" stroke="none"/>
      <rect x="356" y="252" width="122" height="74" rx="14" fill="black" stroke="none"/>
      <rect x="522" y="252" width="122" height="74" rx="14" fill="black" stroke="none"/>
      <rect x="680" y="252" width="132" height="74" rx="14" fill="black" stroke="none"/>
      <rect x="430" y="340" width="140" height="98" rx="12" fill="black" stroke="none"/>
      <path d="M260 210 L330 120 L670 120 L740 210" fill="none" stroke-width="30"/>
      <path d="M390 120 L500 66 L610 120" fill="none" stroke-width="18"/>
      <path d="M158 392 L842 392" fill="none" stroke-width="30"/>
      <circle cx="282" cy="444" r="48"/>
      <circle cx="718" cy="444" r="48"/>
      <rect x="214" y="352" width="92" height="28" rx="8" fill="black" stroke="none"/>
      <rect x="696" y="352" width="92" height="28" rx="8" fill="black" stroke="none"/>
    `),
  },
  {
    id: "demand-chart",
    label: "Demand curve and candlesticks",
    color: [1, 0.72, 0.25],
    palette: [[1, 0.72, 0.25], [0.49, 1, 0.75], [0.35, 0.73, 1]],
    depth: 0.68,
    svg: svgFrame(`
      <path d="M140 470 L865 470" fill="none" stroke-width="24"/>
      <path d="M140 470 L140 118" fill="none" stroke-width="24"/>
      <path d="M185 426 C270 392 332 410 415 340 C500 270 576 300 660 210 C724 142 792 126 860 96" fill="none" stroke-width="40"/>
      <path d="M796 101 L860 96 L832 154 Z"/>
      <circle cx="185" cy="426" r="24"/>
      <circle cx="415" cy="340" r="28"/>
      <circle cx="660" cy="210" r="28"/>
      <path d="M254 385 L254 458" fill="none" stroke-width="16"/>
      <rect x="232" y="404" width="44" height="34" rx="4"/>
      <path d="M574 238 L574 458" fill="none" stroke-width="16"/>
      <rect x="552" y="262" width="44" height="142" rx="4"/>
      <path d="M696 160 L696 458" fill="none" stroke-width="16"/>
      <rect x="674" y="190" width="44" height="196" rx="4"/>
    `),
  },
  {
    id: "coffee-cup",
    label: "Storefront coffee cup",
    color: [0.75, 1, 0.82],
    palette: [[0.75, 1, 0.82], [1, 0.72, 0.25], [0.55, 0.95, 1]],
    depth: 0.48,
    svg: svgFrame(`
      <path d="M330 210 L670 210 L628 500 L372 500 Z"/>
      <path d="M350 258 L650 258" fill="none" stroke-width="34"/>
      <path d="M386 500 L614 500" fill="none" stroke-width="26"/>
      <path d="M675 290 C775 282 802 355 748 412 C715 447 668 430 646 392" fill="none" stroke-width="42"/>
      <path d="M398 158 C358 126 414 94 380 62" fill="none" stroke-width="22"/>
      <path d="M500 158 C460 126 516 94 482 62" fill="none" stroke-width="22"/>
      <path d="M602 158 C562 126 618 94 584 62" fill="none" stroke-width="22"/>
      <rect x="410" y="316" width="180" height="82" rx="18" fill="black" stroke="none"/>
      <text x="500" y="374" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="54" stroke="none">CAFE</text>
      <path d="M302 498 L700 498" fill="none" stroke-width="18"/>
    `),
  },
  {
    id: "map-signals",
    label: "Toronto neighborhoods and live signal pins",
    color: [0.49, 1, 0.75],
    palette: [
      [0.95, 0.16, 0.2],
      [0.24, 0.67, 1],
      [1, 0.72, 0.25],
      [0.49, 1, 0.75],
    ],
    depth: 0.98,
    svg: svgFrame(`
      <g fill="none" stroke-width="16">
        <path d="M170 128 L800 116 L866 486 L202 512 Z"/>
        <path d="M246 136 L292 504"/>
        <path d="M354 132 L382 498"/>
        <path d="M468 128 L480 496"/>
        <path d="M585 124 L568 493"/>
        <path d="M710 120 L660 490"/>
        <path d="M188 220 L824 210"/>
        <path d="M196 312 L842 300"/>
        <path d="M204 408 L856 392"/>
        <path d="M238 500 C324 426 395 396 484 374 C594 346 700 286 848 170"/>
        <path d="M188 352 C290 310 390 312 486 268 C588 222 682 224 820 256"/>
      </g>
      <g stroke="none">
        <circle cx="300" cy="300" r="44"/>
        <circle cx="480" cy="372" r="52"/>
        <circle cx="650" cy="244" r="46"/>
        <circle cx="778" cy="402" r="40"/>
        <circle cx="560" cy="168" r="34"/>
        <circle cx="224" cy="438" r="34"/>
      </g>
      <path d="M480 372 L650 244 L778 402 L480 372 L300 300 L560 168 L650 244" fill="none" stroke-width="12"/>
    `),
  },
];
