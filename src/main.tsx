import { render } from "preact";
import { App } from "./App";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

render(<App />, document.getElementById("react-root")!);
