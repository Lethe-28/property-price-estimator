"""P0 baseline: golden outputs from the CURRENT app logic, for the JavaScript parity test.

Run from the project root:

    python -B scripts/make_golden.py [--n-sample 5000] [--sample-out PATH]

Writes (deterministic; rerunning must reproduce both files byte for byte):

    tests/web/golden.json         the paper demo, the corrected-region demo, and ~200 edge rows.
                                  Expected values come from app/predict.py::predict_price, i.e.
                                  exactly what the Streamlit app would return.
    tests/web/parity_sample.json  random rows of the paper's 45,288-row test set with the
                                  expected value from `pipeline.predict` called directly.

Nothing under app/, artifacts/, results/ or data/ is modified (bytecode writing is off so even
importing app/predict.py leaves app/ untouched).

Blank fields. predict_price() cannot take a blank city/province/region/sqm/bedrooms/bathrooms/
lat/lng (it does float(None) / str(None)), but the fitted pipeline can: its imputers fill
NaN. Rows with blanks therefore use `reference_predict` below, the same steps as predict_price
with blank -> NaN. On every row predict_price accepts, the two are asserted to agree exactly,
so the blank-field rows are anchored to the real app logic rather than to a new rule.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import random
import sys
from pathlib import Path

sys.dont_write_bytecode = True

import joblib
import numpy as np
import pandas as pd
import sklearn

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT / "app"))
sys.path.insert(0, str(PROJECT / "scripts"))

import predict as app_predict  # noqa: E402  (app/predict.py, read only)
import make_results_analysis as mra  # noqa: E402  (load() and the seed-42 split, reused as is)

FEATURES = list(app_predict.REQUIRED_FEATURES)
NUMERIC = ["sqm", "lot_area_m2", "bedrooms", "bathrooms", "lat", "lng"]
TEXT = ["city", "province", "region", "property_type"]
OUT = PROJECT / "tests" / "web"
SEED = 20261007

PAPER_DEMO = {"sqm": 60.0, "lot_area_m2": None, "bedrooms": 3.0, "bathrooms": 2.0,
              "lat": 7.07, "lng": 125.61, "city": "Davao City",
              "province": "Davao del Sur", "region": "Davao Region",
              "property_type": "condo"}
CORRECTED_DEMO = {**PAPER_DEMO, "region": "Region XI (Davao Region)"}


def blank(v) -> bool:
    return v is None or (isinstance(v, float) and math.isnan(v)) or (isinstance(v, str) and not v.strip())


def reference_predict(pipe, inp: dict) -> float:
    """predict_price with blank -> NaN so the pipeline's own imputers handle it."""
    row = {}
    for k in NUMERIC:
        row[k] = np.nan if blank(inp[k]) else float(inp[k])
    for k in TEXT:
        row[k] = np.nan if blank(inp[k]) else str(inp[k]).strip()
    if np.isnan(row["lot_area_m2"]) and row["property_type"] == "condo" and not np.isnan(row["sqm"]):
        row["lot_area_m2"] = row["sqm"]
    return float(pipe.predict(pd.DataFrame([row], columns=FEATURES))[0])


def expected_for(pipe, inp: dict) -> tuple[float, str]:
    """(value, source). predict_price whenever it can take the row, else reference_predict."""
    ref = reference_predict(pipe, inp)
    needs_blank = any(blank(inp[k]) for k in FEATURES if k != "lot_area_m2")
    if needs_blank:
        return ref, "reference_predict"
    lot = None if blank(inp["lot_area_m2"]) else inp["lot_area_m2"]
    app = app_predict.predict_price(pipe, **{**inp, "lot_area_m2": lot})
    assert app == ref, f"predict_price and reference_predict disagree: {app!r} vs {ref!r} for {inp}"
    return app, "predict_price"


def clean(v):
    """JSON-safe: NaN -> null, numpy scalars -> Python."""
    if isinstance(v, (np.floating, float)):
        return None if math.isnan(v) else float(v)
    if isinstance(v, np.integer):
        return int(v)
    return v


def edge_rows(pipe) -> list[tuple[str, dict]]:
    rng = random.Random(SEED)
    model = pipe.named_steps["model"]
    pre = pipe.named_steps["preprocess"]
    cities, provinces, regions = (list(c) for c in pre.named_transformers_["te"].named_steps["encode"].categories_)
    rows: list[tuple[str, dict]] = []

    def add(tag, **over):
        rows.append((tag, {**CORRECTED_DEMO, **over}))

    # Condo back-fill: blank lot filled from sqm; non-condos are NOT filled.
    for sqm in (0.0, 20.0, 35.0, 60.0, 120.0, 250.0, 1000.0, None):
        add("condo_blank_lot", sqm=sqm, lot_area_m2=None)
    for lot in (30.0, 500.0, 5000.0):
        add("condo_given_lot", lot_area_m2=lot)
    for t in ("house", "lot", "commercial"):
        for sqm in (80.0, 400.0, None):
            add(f"{t}_blank_lot", property_type=t, sqm=sqm, lot_area_m2=None)

    # Unseen locations, every property type; and the old free-text default.
    for t in ("house", "condo", "lot", "commercial"):
        add("unseen_city", property_type=t, city="Atlantis")
        add("unseen_province", property_type=t, province="Narnia")
        add("unseen_region", property_type=t, region="Mordor")
        add("unseen_all_three", property_type=t, city="Atlantis", province="Narnia", region="Mordor")
        add("old_default_region_spelling", property_type=t, region="Davao Region")
    add("unseen_city_prototype_name", city="constructor")
    add("unseen_city_case", city="davao city")

    # Unknown / padded property type and padded strings (predict_price strips).
    for t in ("villa", "HOUSE", "townhouse"):
        add("unseen_property_type", property_type=t)
    add("padded_property_type", property_type=" house ")
    add("padded_city", city="  Davao City  ")

    # Blank fields: each alone, then combinations.
    for k in FEATURES:
        add(f"blank_{k}", **{k: None})
    add("blank_all", **{k: None for k in FEATURES})
    add("blank_location", city=None, province=None, region=None)
    add("blank_size", sqm=None, lot_area_m2=None, bedrooms=None, bathrooms=None)
    add("blank_geo_and_type", lat=None, lng=None, property_type=None)

    # Extreme values: app bounds, and raw data-error scale (sqm up to 45,000,000 in the source).
    for t in ("condo", "house", "lot", "commercial"):
        for sqm in (0.0, 0.001, 10_000.0, 45_000_000.0):
            add("extreme_sqm", property_type=t, sqm=sqm)
    for lot in (0.0, 500_000.0, 1e9):
        add("extreme_lot", property_type="lot", lot_area_m2=lot)
    for b in (0.0, 20.0, 301.0):
        add("extreme_bedrooms", bedrooms=b, bathrooms=b)
    for lat, lng in ((4.0, 116.0), (21.5, 127.0), (0.0, 0.0), (-90.0, 180.0)):
        add("extreme_latlng", lat=lat, lng=lng)

    # Inputs sitting exactly on forest thresholds: the float32 rounding trap (constraint 3).
    # Thresholds are taken from nodes the base row actually visits, so moving x across one really
    # flips that split (a random node would sit in a subtree the row never reaches). For each
    # numeric feature use x = t, x = the largest float32 <= t, and the next float32 above it.
    hug_base = {**CORRECTED_DEMO, "property_type": "house", "sqm": 120.0, "lot_area_m2": 150.0}
    x32 = np.ascontiguousarray(
        pre.transform(pd.DataFrame([hug_base], columns=FEATURES)), dtype=np.float32)
    thresholds: dict[int, list[float]] = {f: [] for f in range(6)}
    trees = model.estimators_
    order = list(range(len(trees)))
    rng.shuffle(order)
    for tree_idx in order:
        tr = trees[tree_idx].tree_
        for node in tr.decision_path(x32).indices:
            f = int(tr.feature[node])
            if 0 <= f < 6 and len(thresholds[f]) < 6:
                thresholds[f].append(float(tr.threshold[node]))
    assert all(len(ts) == 6 for ts in thresholds.values()), thresholds
    for f, ts in thresholds.items():
        name = NUMERIC[f]
        for t in ts:
            lo = np.float32(t)
            if float(lo) > t:
                lo = np.nextafter(lo, np.float32(-np.inf))
            hi = np.nextafter(lo, np.float32(np.inf))
            for tag, x in (("at_threshold_f64", t), ("at_threshold_floor32", float(lo)),
                           ("at_threshold_next32", float(hi))):
                add(f"{tag}:{name}", **{**hug_base, name: x})

    # Random combinations over the fitted categories (cities/provinces/regions need not agree).
    for _ in range(50):
        add("random_combo", property_type=rng.choice(("house", "condo", "lot", "commercial")),
            city=rng.choice(cities), province=rng.choice(provinces), region=rng.choice(regions),
            sqm=round(rng.lognormvariate(4.8, 1.0), 2),
            lot_area_m2=rng.choice((None, round(rng.lognormvariate(5.2, 1.2), 1))),
            bedrooms=float(rng.randint(0, 8)), bathrooms=float(rng.randint(0, 6)),
            lat=round(rng.uniform(5.0, 19.0), 4), lng=round(rng.uniform(119.0, 126.5), 4))
    # The listing behind the paper's Section 4.7 back-fill replay (manifest application.parity_check): the first
    # condo in the raw file with a missing lot area and a known floor area. One row with the back-fill, one with
    # the lot area set to the training median, which is what skipping the back-fill amounts to.
    raw = pd.read_csv(PROJECT / "data" / "listings.csv", usecols=FEATURES + ["property_type"], low_memory=False)
    first = raw[(raw["property_type"] == "condo") & raw["lot_area_m2"].isna() & raw["sqm"].notna()].iloc[0]
    replay = {k: (None if pd.isna(first[k]) else (float(first[k]) if k in NUMERIC else str(first[k]))) for k in FEATURES}
    add("paper_backfill_replay", **replay)
    add("paper_backfill_replay_skipped", **{**replay, "lot_area_m2": float(pre.named_transformers_["num"].statistics_[1])})
    return rows


def build_golden(pipe) -> dict:
    cases = []
    for cid, tag, inp in (("paper_demo", "paper_demo", PAPER_DEMO),
                          ("corrected_region_demo", "corrected_region_demo", CORRECTED_DEMO)):
        value, source = expected_for(pipe, inp)
        cases.append({"id": cid, "tag": tag, "source": source, "inputs": inp, "expected": value})
    for i, (tag, inp) in enumerate(edge_rows(pipe)):
        value, source = expected_for(pipe, inp)
        cases.append({"id": f"edge_{i:03d}", "tag": tag, "source": source,
                      "inputs": {k: clean(inp[k]) for k in FEATURES}, "expected": value})
    paper = next(c for c in cases if c["id"] == "paper_demo")["expected"]
    fixed = next(c for c in cases if c["id"] == "corrected_region_demo")["expected"]
    assert round(paper) == 7_185_884, paper
    assert round(fixed) == 7_367_845, fixed
    return {
        "note": ("Expected values: app/predict.py::predict_price where it accepts the row, else "
                 "reference_predict (same steps, blank -> NaN); the two are asserted equal wherever "
                 "both apply. Regenerate with scripts/make_golden.py."),
        "environment": {"python": platform.python_version(), "scikit_learn": sklearn.__version__,
                        "numpy": np.__version__, "pandas": pd.__version__},
        "cases": cases,
    }


def build_sample(pipe, n: int) -> dict:
    X, y, data = mra.load()
    from sklearn.model_selection import train_test_split
    idx = np.arange(len(data))
    _, te = train_test_split(idx, test_size=0.2, random_state=mra.SEED, stratify=data["property_type"])
    assert len(te) == 45_288
    rng = np.random.default_rng(SEED)
    pick = np.sort(rng.choice(te, size=min(n, len(te)), replace=False))
    frame = X.iloc[pick]
    pred = np.asarray(pipe.predict(frame), dtype="float64")
    rows = [{k: clean(v) for k, v in zip(FEATURES, vals)}
            for vals in frame[FEATURES].itertuples(index=False, name=None)]
    # Spot-check the claim in app.predict_price: bare pipeline.predict on this back-filled frame
    # is the reference. (load() already applied the condo back-fill, as the notebook did.)
    return {"note": "Random rows of the paper's test set (seed 42 stratified 80/20), condo back-fill "
                    "already applied; expected = pipeline.predict on the DataFrame.",
            "n": len(rows), "rows": rows, "expected": [float(p) for p in pred]}


def write_json(path: Path, obj) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, indent=1, allow_nan=False, ensure_ascii=False) + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-sample", type=int, default=5000)
    ap.add_argument("--sample-out", type=Path, default=OUT / "parity_sample.json")
    ap.add_argument("--skip-golden", action="store_true")
    args = ap.parse_args()

    pipe = app_predict.load_pipeline()
    # The saved forest has n_jobs=-1, so sklearn sums the 300 trees in thread-dependent order and
    # repeated predict() calls differ by ~1e-16 relative. One thread fixes the order, which makes
    # these files reproducible byte for byte. In memory only; the artifact is untouched.
    pipe.named_steps["model"].n_jobs = 1
    if not args.skip_golden:
        golden = build_golden(pipe)
        digest = write_json(OUT / "golden.json", golden)
        by_src = pd.Series([c["source"] for c in golden["cases"]]).value_counts().to_dict()
        print(f"golden.json: {len(golden['cases'])} cases {by_src} sha256[:16]={digest}")
        for c in golden["cases"][:2]:
            print(f"  {c['id']}: {c['expected']:,.4f}")
    sample = build_sample(pipe, args.n_sample)
    digest = write_json(args.sample_out, sample)
    print(f"{args.sample_out.name}: {sample['n']} rows sha256[:16]={digest}")


if __name__ == "__main__":
    main()
