/** Legend matching the live map layers (flow choropleth + point feeds). */
export function MapLegend() {
  return (
    <div class="map-legend">
      <span class="map-legend-item map-legend-home">
        <i class="legend-home" />
        Your business
      </span>
      <span class="map-legend-sep">closures:</span>
      <span class="map-legend-item"><i style={{ background: "#ff4444" }} />Major</span>
      <span class="map-legend-item"><i style={{ background: "#ff7b00" }} />Moderate</span>
      <span class="map-legend-item"><i style={{ background: "#ffaa00" }} />Minor</span>
      <span class="map-legend-sep">bikes:</span>
      <span class="map-legend-item"><i style={{ background: "#ff4444" }} />Empty</span>
      <span class="map-legend-item"><i style={{ background: "#2dd4bf" }} />OK</span>
      <span class="map-legend-item"><i style={{ background: "#4cc9f0" }} />Full</span>
      <span class="map-legend-item"><i style={{ background: "#9b5de5" }} />Transit</span>
      <span class="map-legend-sep">lines:</span>
      <span class="map-legend-item"><i style={{ background: "#F8C300" }} />L1</span>
      <span class="map-legend-item"><i style={{ background: "#00923F" }} />L2</span>
      <span class="map-legend-item"><i style={{ background: "#A21A68" }} />L4</span>
      <span class="map-legend-item"><i style={{ background: "#DA251D" }} />Streetcar</span>
      <span class="map-legend-item"><i style={{ background: "#98002e" }} />GO (by line)</span>
      <span class="map-legend-sep">flow:</span>
      <span class="map-legend-item"><i class="legend-grad" />low → intense</span>
    </div>
  );
}
