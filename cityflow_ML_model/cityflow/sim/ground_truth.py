"""
CityFlow — demand simulator GROUND TRUTH.

Every number here is an effect we INJECT into the synthetic world. The whole
validation story rests on this file: after training a demand model on the
generated data, we check whether the model RECOVERED these values. "We injected
a -30% rain effect; the model learned -28%" is the demo line.

Keep this file readable and quotable — it is the answer to "where did your
numbers come from?" (Answer: we defined them, transparently, and then proved
the model could recover them through noise and interactions.)

Two business archetypes are provided because demand rhythm differs sharply:
a cafe peaks at breakfast/lunch; a sit-down restaurant peaks at dinner.
"""

from __future__ import annotations

# ----------------------------------------------------------------------------
# BASE DEMAND: expected customers per hour on an ordinary day, no modifiers.
# Index 0..23 = hour of day. These define the daily rhythm.
# ----------------------------------------------------------------------------

CAFE_BASE_HOURLY = [
    0, 0, 0, 0, 0, 2,        # 0-5  closed / pre-open
    18, 35, 55, 48, 40, 52,  # 6-11 morning rush + mid-morning
    60, 45, 30, 25, 28, 22,  # 12-17 lunch peak then taper
    12, 6, 2, 0, 0, 0,       # 18-23 evening wind-down / closed
]

RESTAURANT_BASE_HOURLY = [
    0, 0, 0, 0, 0, 0,        # 0-5  closed
    0, 0, 0, 0, 0, 20,       # 6-11 closed until late morning
    45, 38, 22, 15, 18, 35,  # 12-17 lunch then afternoon lull
    65, 80, 70, 45, 20, 5,   # 18-23 dinner peak
]

# Day-of-week multipliers (Mon=0 .. Sun=6). Captures weekly rhythm.
CAFE_DOW_MULT =       [1.05, 1.05, 1.05, 1.10, 1.15, 0.85, 0.70]
RESTAURANT_DOW_MULT = [0.80, 0.82, 0.88, 0.95, 1.20, 1.35, 1.10]

# ----------------------------------------------------------------------------
# SINGLE-FACTOR EFFECTS (multiplicative). 1.0 = no effect.
# ----------------------------------------------------------------------------

WEATHER_EFFECT = {
    "clear":  1.00,
    "cloudy": 0.97,
    "rain":   0.70,   # -30% baseline
    "snow":   0.55,   # -45%
    "heat":   0.90,   # extreme heat, -10%
}

# A nearby event (concert, game, festival) within the catchment.
EVENT_EFFECT_NEARBY = 1.40   # +40% when an event is on nearby

# A transit disruption that cuts a major approach to the business.
TRANSIT_DISRUPTION_EFFECT = 0.85   # -15%

# ----------------------------------------------------------------------------
# INTERACTIONS — the part that makes recovery a real task, not a lookup.
# These ADJUST the single-factor effects under specific joint conditions.
# ----------------------------------------------------------------------------

# Rain hurts MORE on weekends: weekend trips are discretionary, so bad weather
# suppresses them harder than a fixed weekday routine.
RAIN_WEEKEND_EXTRA = 0.85    # extra multiplier on top of rain, weekends only

# An event only helps if the business is still REACHABLE. If a transit
# disruption co-occurs with a nearby event, the event boost is dampened —
# customers can't easily get there.
EVENT_WHEN_DISRUPTED = 0.65  # event boost is dampened when transit is disrupted

# Dinner-hour events help restaurants disproportionately (people make a night
# of it); morning events do little for a dinner venue.
EVENT_DINNER_BONUS = 1.15    # extra on event effect during hours 18-21

# ----------------------------------------------------------------------------
# NOISE — identical conditions must NOT give identical outcomes.
# We use multiplicative lognormal-ish noise so demand stays positive.
# ----------------------------------------------------------------------------

NOISE_SIGMA = 0.18   # ~18% relative noise per hour

# Probabilities for sampling exogenous conditions when generating history.
P_RAIN = 0.18
P_SNOW = 0.06
P_HEAT = 0.05
P_EVENT_NEARBY = 0.12
P_TRANSIT_DISRUPTION = 0.10
