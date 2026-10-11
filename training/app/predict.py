"""Prediction logic for the property price application.

Kept free of any Streamlit import on purpose. `app.py` is the user interface;
this module is the part that actually touches the model, so it can be imported
and asserted on headlessly, independent of whether Streamlit itself is
installed or importable on the running interpreter.

The ten inputs are the locked feature set, taken from `feature_names_in_` on the
fitted artifact rather than hard-coded, so a retrained model with a different
schema fails loudly in `check_feature_contract` instead of silently mispredicting.
"""

from __future__ import annotations

import json
import pathlib

import joblib
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / "artifacts" / "price_pipeline.joblib"

# The locked feature set, in the order the pipeline was fitted on.
REQUIRED_FEATURES = (
    "sqm",
    "lot_area_m2",
    "bedrooms",
    "bathrooms",
    "lat",
    "lng",
    "city",
    "province",
    "region",
    "property_type",
)

# Bounded numeric inputs: (min, max, default). The ceilings are deliberately
# below the raw maxima, because `sqm` runs to 45,000,000 and `bedrooms` to 301 in
# the source data. Those are data errors, and the app should not offer them as
# valid input. Floors allow 0 for bedrooms and bathrooms, which is legitimate
# for listings of vacant land.
#
# `lot_area_m2` has a default of None: the field is optional, because "not
# supplied" is a real and common case in this data (82% of rows) and is
# materially different from a lot area of 0. Do not give it a numeric default --
# a pre-filled number would be silently used for condos instead of the floor
# area, and would be a fabricated value for anything else.
NUMERIC_BOUNDS = {
    "sqm": (0.0, 10_000.0, 60.0),
    "lot_area_m2": (0.0, 500_000.0, None),
    "bedrooms": (0.0, 20.0, 3.0),
    "bathrooms": (0.0, 20.0, 2.0),
    "lat": (4.0, 21.5, 12.0),
    "lng": (116.0, 127.0, 122.0),
}

PROPERTY_TYPES = ("house", "condo", "lot", "commercial")

# Free-text defaults for the three location fields.
LOCATION_DEFAULTS = {
    "city": "Davao City",
    "province": "Davao del Sur",
    "region": "Davao Region",
}

# Display labels for the ten locked features, in the order charts should show
# them by default. Presentation only -- REQUIRED_FEATURES stays the contract.
FEATURE_LABELS = {
    "sqm": "Floor area",
    "lot_area_m2": "Lot area",
    "bedrooms": "Bedrooms",
    "bathrooms": "Bathrooms",
    "lat": "Latitude",
    "lng": "Longitude",
    "city": "City",
    "province": "Province",
    "region": "Region",
    "property_type": "Property type",
}

METRICS = ROOT / "results" / "metrics.json"


def load_pipeline(path: pathlib.Path = ARTIFACT):
    """Load the fitted pipeline and assert it matches the locked feature set."""
    pipeline = joblib.load(path)
    check_feature_contract(pipeline)
    return pipeline


def check_feature_contract(pipeline) -> None:
    """Fail loudly if the artifact was fitted on a different schema."""
    fitted = list(pipeline.feature_names_in_)
    if tuple(fitted) != REQUIRED_FEATURES:
        raise ValueError(
            "artifact feature schema does not match the locked feature set.\n"
            f"  artifact: {fitted}\n"
            f"  expected: {list(REQUIRED_FEATURES)}"
        )


def predict_price(pipeline, *, sqm, lot_area_m2, bedrooms, bathrooms, lat, lng,
                  city, province, region, property_type) -> float:
    """Return the predicted price in pesos for one listing.

    Pure: no UI calls, no global state, no caching. Everything the application
    does to turn form values into a peso figure happens here.

    The condo lot-area back-fill is replicated deliberately. It was applied as a
    dataframe step in the training notebook rather than inside the saved
    pipeline, so a bare `pipeline.predict` on a condo with no lot area would
    median-impute it and quietly disagree with how the model was trained. A
    condo's lot area is its floor area, so `sqm` is the correct substitute.
    """
    row = {
        "sqm": float(sqm),
        "lot_area_m2": lot_area_m2,
        "bedrooms": float(bedrooms),
        "bathrooms": float(bathrooms),
        "lat": float(lat),
        "lng": float(lng),
        "city": str(city).strip(),
        "province": str(province).strip(),
        "region": str(region).strip(),
        "property_type": str(property_type).strip(),
    }

    # A missing lot area means "not supplied", not zero. None is passed through
    # so the pipeline's own median imputer handles it, as in training.
    if row["lot_area_m2"] is None or pd.isna(row["lot_area_m2"]):
        if row["property_type"] == "condo" and pd.notna(row["sqm"]):
            row["lot_area_m2"] = row["sqm"]
        else:
            row["lot_area_m2"] = None

    frame = pd.DataFrame([row], columns=list(REQUIRED_FEATURES))
    return float(pipeline.predict(frame)[0])


def feature_importance(pipeline) -> list[tuple[str, float]]:
    """The model's per-input importances, grouped back to the ten locked fields.

    The fitted preprocessor expands `property_type` into four one-hot columns,
    so their importances are summed back under "property_type" -- the chart
    should match the form's ten fields, not the pipeline's thirteen internal
    ones. Returned sorted highest first; values sum to ~1.0 for a fitted
    RandomForestRegressor.
    """
    names = pipeline.named_steps["preprocess"].get_feature_names_out()
    values = pipeline.named_steps["model"].feature_importances_
    grouped = {feature: 0.0 for feature in REQUIRED_FEATURES}
    for name, value in zip(names, values):
        _, _, rest = name.partition("__")
        feature = "property_type" if rest.startswith("property_type_") else rest
        grouped[feature] += float(value)
    return sorted(grouped.items(), key=lambda item: item[1], reverse=True)


def load_metrics(path: pathlib.Path = METRICS) -> dict:
    """The evaluated model metrics, for display alongside a live estimate.

    Read straight from the file the notebook wrote -- nothing here is
    recomputed or re-derived, so the app cannot drift from the graded numbers.
    """
    return json.loads(path.read_text(encoding="utf-8"))
