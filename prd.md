# CityFlow PRD

## 1. Summary

CityFlow is an autonomous AI operating system for small physical businesses in Toronto. It monitors live city signals such as transit disruptions, road closures, weather, events, construction, and neighborhood activity to predict local demand shifts and recommend operational actions before they affect revenue.

The product is designed for cafes, restaurants, retailers, and service businesses that do not have the data science teams or forecasting infrastructure available to large operators. CityFlow acts as a local-first "Bloomberg Terminal for physical businesses": it continuously reasons over urban data, simulates likely business impact, and turns those insights into specific recommendations for staffing, inventory, promotions, delivery routing, and operating hours.

For the NVIDIA Spark Hack Toronto build, CityFlow should demonstrate an agentic, open-data-first system running on local NVIDIA DGX Spark / GB10-class hardware using open models where possible.

## 2. Problem

Small businesses are highly sensitive to changes in neighborhood demand, but they usually discover those changes too late.

Examples:

- A TTC disruption shifts foot traffic away from a cafe's usual morning rush.
- A nearby event creates a temporary spike in demand, but the restaurant is understaffed.
- Road closures slow delivery times and increase order cancellation risk.
- Bad weather suppresses patio traffic and changes purchasing behavior.
- Construction blocks access to a storefront, reducing walk-in traffic for days or weeks.

Large companies can absorb these problems with forecasting teams, proprietary mobility data, and automated operations systems. Independent businesses usually rely on instinct, social media, weather apps, and manual checks. The result is lost sales, waste, poor staffing decisions, and slower reactions to city-level changes.

## 3. Target Users

Primary users:

- Independent cafe, restaurant, and retail owners in Toronto.
- Store managers responsible for daily staffing, inventory, and promotions.
- Multi-location operators with limited analytics support.

Secondary users:

- Business improvement areas and local economic development teams.
- Delivery-heavy local businesses that need route and disruption awareness.
- City operations or public-service partners interested in local economic resilience.

## 4. Goals

CityFlow should:

- Predict short-term neighborhood demand changes using public city signals.
- Explain the likely operational impact in plain language.
- Recommend concrete actions a manager can take today.
- Run agentic workflows locally on NVIDIA hardware using open models where practical.
- Use City of Toronto open data as a core input.
- Produce an impressive, credible hackathon demo with real Toronto scenarios.

## 5. Non-Goals

The MVP should not:

- Replace a full POS, workforce management, or inventory management system.
- Require proprietary mobility, payment, or customer data to be useful.
- Make fully automated business changes without manager approval.
- Attempt citywide forecasting at enterprise precision.
- Support every business category on day one.

## 6. MVP Scope

The hackathon MVP should focus on a single operating mode:

> Given a Toronto neighborhood and business profile, CityFlow continuously ingests relevant city signals, detects demand-impacting events, and generates ranked recommendations for the next 24-72 hours.

### Required MVP Inputs

- Business type, such as cafe, quick-service restaurant, retailer, or bar.
- Business location or neighborhood.
- Typical operating hours.
- Basic operating constraints, such as staffing capacity, inventory sensitivity, or delivery radius.
- Public city signals from Toronto open data and related public sources.

### Required MVP Outputs

- A neighborhood demand forecast: up, down, or volatile, with confidence.
- A ranked list of detected city signals affecting the business.
- Recommended actions with timing, rationale, and expected impact.
- A short explanation of which data sources and agents contributed to the recommendation.
- A manager-facing dashboard or terminal-style interface.

## 7. Example User Stories

- As a cafe owner, I want to know whether tomorrow morning's commute disruption will reduce my usual rush so I can adjust staffing and prep.
- As a restaurant manager, I want to know if a nearby event will increase evening demand so I can schedule more staff and prepare extra inventory.
- As a retailer, I want to understand whether construction or road closures near my storefront are likely to reduce walk-ins.
- As a delivery operator, I want recommended route or delivery-zone adjustments when road closures and weather increase delay risk.
- As a multi-location owner, I want to compare which locations are most likely to experience demand spikes in the next 48 hours.

## 8. Core Product Experience

### Dashboard

The dashboard should show:

- Current neighborhood status.
- Demand forecast for the next 24, 48, and 72 hours.
- Top city signals driving the forecast.
- Recommended actions, ranked by urgency and expected value.
- Agent reasoning trace summarized for non-technical users.

### Recommendation Card

Each recommendation should include:

- Action: what to do.
- Timing: when to do it.
- Reason: why CityFlow recommends it.
- Confidence: high, medium, or low.
- Business impact: revenue, cost, staffing, waste, or service quality.
- Source signals: event, road, transit, weather, construction, or historical pattern.

Example:

> Increase afternoon prep by 15-20% on Saturday. A nearby event is expected to increase pedestrian activity between 2 PM and 6 PM, while weather conditions are favorable for walk-ins. Confidence: medium.

## 9. Data Requirements

CityFlow should prioritize public and hackathon-appropriate data sources.

Potential inputs:

- City of Toronto open datasets for construction, road restrictions, permits, events, neighborhoods, business areas, and public infrastructure.
- TTC service alerts or public transit disruption feeds where available.
- Public weather APIs.
- Public event listings.
- Static neighborhood metadata, such as business improvement areas and points of interest.
- Optional synthetic business data for demo purposes, such as typical sales curves or staffing levels.

Data handling requirements:

- Clearly label live, cached, and synthetic data.
- Store source timestamps.
- Normalize all geospatial data to a common coordinate system.
- Support neighborhood-level and radius-based filtering.
- Avoid relying on private personal data.

## 10. Agent Architecture

CityFlow should use a multi-agent workflow rather than a single prompt.

Suggested agents:

- Signal Ingestion Agent: fetches and normalizes city, transit, weather, and event data.
- Geo Context Agent: maps signals to neighborhoods, business locations, and radii.
- Demand Forecast Agent: estimates expected demand direction and confidence.
- Operations Agent: converts forecasts into staffing, inventory, routing, promotion, or hours recommendations.
- Explanation Agent: turns reasoning into concise manager-facing language.
- Monitor Agent: watches for major changes and triggers updated recommendations.

The system should expose a clear orchestration flow:

1. Collect signals.
2. Filter by business location and time window.
3. Score expected demand impact.
4. Generate operational recommendations.
5. Explain sources, assumptions, and confidence.
6. Update when new signals arrive.

## 11. Model and Infrastructure Requirements

For the NVIDIA Spark Hack build:

- Run open local models on NVIDIA DGX Spark / GB10-class hardware where feasible.
- Use local inference for summarization, classification, agent planning, and recommendation generation.
- Use GPU acceleration for embedding, reranking, or geospatial batch processing if implemented.
- Keep the system usable offline with cached city data for demo reliability.
- Include a visible indicator showing local model execution or local-first architecture.

## 12. Functional Requirements

### Data Ingestion

- Ingest at least three real Toronto signal types for the demo.
- Refresh or simulate refresh on a predictable interval.
- Preserve source URLs, timestamps, and update times.

### Forecasting

- Generate a demand-impact score for each relevant signal.
- Combine multiple signals into a neighborhood-level forecast.
- Provide confidence based on signal quality, recency, and agreement.

### Recommendations

- Generate at least four action categories:
  - Staffing.
  - Inventory or prep.
  - Promotions.
  - Delivery or routing.
- Rank actions by urgency and expected impact.
- Include concise rationale and source attribution.

### User Interface

- Let the user select or enter a business profile and Toronto location.
- Show a live or simulated live operations feed.
- Highlight the top risks and opportunities.
- Provide a manager-ready recommendation summary.

### Explainability

- Show the source signals behind each recommendation.
- Distinguish observed data from model inference.
- Surface uncertainty clearly.

## 13. Success Metrics

Hackathon demo success:

- Uses real City of Toronto open data as a core foundation.
- Demonstrates a working agentic loop rather than a static dashboard.
- Runs a meaningful part of the AI workflow locally on NVIDIA hardware.
- Produces recommendations that are specific enough for a business owner to act on.
- Shows at least two realistic Toronto scenarios, such as a transit disruption and a nearby event.

Product success:

- Reduces time spent manually checking city conditions.
- Helps businesses avoid overstaffing, understaffing, stockouts, or waste.
- Increases confidence in daily operating decisions.
- Produces recommendations users accept or act on.

## 14. Demo Scenarios

### Scenario A: Transit Disruption Near Morning Rush

Business: downtown cafe.

Signals:

- TTC disruption near the business.
- Road congestion or closure nearby.
- Normal weekday weather.

Expected output:

- Lower walk-in forecast for the morning commute window.
- Recommendation to reduce front-of-house staffing slightly, adjust prep timing, and push a nearby delivery or pickup promotion.

### Scenario B: Event-Driven Demand Spike

Business: quick-service restaurant near an event venue.

Signals:

- Public event listing.
- Favorable weather.
- Increased neighborhood activity window.

Expected output:

- Higher evening demand forecast.
- Recommendation to increase prep, schedule an extra staff member, and run a timed promotion before and after the event.

### Scenario C: Construction Access Risk

Business: neighborhood retailer.

Signals:

- Construction permit or road restriction near storefront.
- Multi-day expected duration.
- Reduced accessibility around operating hours.

Expected output:

- Lower walk-in confidence for affected period.
- Recommendation to update customer messaging, adjust staffing, and shift promotions to pickup or delivery.

## 15. Risks and Mitigations

- Data freshness risk: public feeds may be delayed or incomplete.
  - Mitigation: show timestamps, cache data, and support simulated updates for demo.

- Forecast accuracy risk: the MVP may not have enough historical business data.
  - Mitigation: present directional forecasts with confidence, not precise sales predictions.

- Over-automation risk: recommendations could be interpreted as commands.
  - Mitigation: keep a human approval model and show rationale.

- Demo reliability risk: live APIs may fail during judging.
  - Mitigation: include cached Toronto scenarios with known expected outputs.

- Scope risk: the concept can become too broad.
  - Mitigation: focus the MVP on one city, a few business types, and a 24-72 hour planning window.

## 16. Hackathon Build Plan

### Day 1

- Select target business profiles and neighborhoods.
- Identify and ingest three to five public signal sources.
- Build data normalization and geospatial filtering.
- Create basic business profile input.

### Day 2

- Implement agent orchestration.
- Build demand-impact scoring and recommendation generation.
- Create dashboard or terminal interface.
- Add cached demo scenarios.

### Day 3

- Polish demo flow.
- Add source attribution and confidence explanations.
- Validate local model execution on NVIDIA hardware.
- Prepare pitch narrative and live scenario walkthrough.

## 17. Judging Alignment

CityFlow aligns with the hackathon brief by:

- Using City of Toronto open data as the foundation.
- Building an agentic application that thinks, acts, and updates over time.
- Targeting real-world utility for Toronto's economic and urban operations systems.
- Demonstrating local-first AI workflows on NVIDIA DGX Spark / GB10-class hardware.
- Making predictive city intelligence accessible to small businesses rather than only large enterprises.

