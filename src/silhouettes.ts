export interface SceneDefinition {
  id: string;
  label: string;
  color: [number, number, number];
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

export const scenes: SceneDefinition[] = [];
