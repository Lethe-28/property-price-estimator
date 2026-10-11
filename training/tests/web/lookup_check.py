"""P2 gate: the exported lookups and perf data match a direct pandas calculation.

    python -B tests/web/lookup_check.py [--app PropertyPriceEstimator]

Parses the shipped data/lookup.js and data/perf.js (the files the app loads) and recomputes the
facts from data/listings.csv with its own pandas code, not by calling the exporter. Exit code 1
on any mismatch.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

sys.dont_write_bytecode = True

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

PROJECT = Path(__file__).resolve().parents[2]
TYPES = ["house", "condo", "lot", "commercial"]
failures: list[str] = []


def check(ok: bool, msg: str) -> None:
    if not ok:
        failures.append(msg)
        print("  FAIL:", msg)


def load_js(path: Path, name: str) -> dict:
    text = path.read_text(encoding="ascii")
    prefix = f"globalThis.{name}="
    assert text.startswith(prefix), path
    return json.loads(text[len(prefix):].rstrip().rstrip(";"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default="PropertyPriceEstimator")
    args = ap.parse_args()
    lookup = load_js(PROJECT / args.app / "data" / "lookup.js", "LOOKUP")
    perf = load_js(PROJECT / args.app / "data" / "perf.js", "PERF")

    # Independent dedup (same definition as the notebook: latest sighting per canonical_id).
    raw = pd.read_csv(PROJECT / "data" / "listings.csv", low_memory=False)
    raw["_ls"] = pd.to_datetime(raw["last_seen"], format="%Y-%m-%d")
    data = (raw.sort_values(["_ls", "canonical_id"], kind="mergesort")
               .drop_duplicates("canonical_id", keep="last").reset_index(drop=True))
    assert len(data) == 226_438
    tr, te = train_test_split(np.arange(len(data)), test_size=0.2, random_state=42,
                              stratify=data["property_type"])
    train = data.iloc[tr]

    H = lookup["hierarchy"]
    cities, provinces, regions = H["cities"], H["provinces"], H["regions"]
    name_to_i = {c: i for i, c in enumerate(cities["name"])}
    M = lookup["market"]["levels"]
    cols = lookup["market"]["columns"]

    def place(city: str):
        i = name_to_i[city]
        p = cities["province"][i]
        return (None, None) if p < 0 else (provinces["name"][p], regions[provinces["region"][p]])

    print("== Davao City ==")
    prov, reg = place("Davao City")
    print(f"  resolves to province={prov!r} region={reg!r}")
    check((prov, reg) == ("Davao del Sur", "Region XI (Davao Region)"), "Davao City province/region")

    print("== structure ==")
    check(len(regions) == 17 and len(provinces["name"]) == 84 and len(cities["name"]) == 1455, "hierarchy sizes")
    check(all(-1 <= p < 84 for p in cities["province"]), "city province index range")
    check(all(0 <= r < 17 for r in provinces["region"]), "province region index range")
    check(cities["name"] == sorted(cities["name"]), "cities sorted")
    unplaced = sum(p < 0 for p in cities["province"])
    print(f"  {len(cities['name'])} cities, {unplaced} without a recorded province")
    check(unplaced == 630, "630 cities without a recorded province")
    check(lookup["property_types"] == TYPES, "property type order")
    from_py = {"sqm": [0.0, 10000.0, 60.0], "lot_area_m2": [0.0, 500000.0, None],
               "bedrooms": [0.0, 20.0, 3.0], "bathrooms": [0.0, 20.0, 2.0],
               "lat": [4.0, 21.5, 12.0], "lng": [116.0, 127.0, 122.0]}
    check(lookup["bounds"] == from_py, "NUMERIC_BOUNDS match app/predict.py")

    def pandas_entry(frame: pd.DataFrame, t: str):
        s = frame.loc[frame["property_type"] == t, "price_php"]
        if len(s) < 30:
            return None
        return [len(s)] + [int(round(s.quantile(q))) for q in (.05, .25, .5, .75, .95)]

    print("== five sampled cities + Davao City (hierarchy and market, vs pandas) ==")
    eligible = [c for c, n in zip(cities["name"], cities["n"]) if n >= 30]
    sampled = ["Davao City"] + random.Random(11).sample(eligible, 5)
    for city in sampled:
        i = name_to_i[city]
        g = train[train["city"] == city]
        med = g[["lat", "lng"]].median()
        n_ok = cities["n"][i] == len(g)
        ll_ok = all((cities[k][i] is None and pd.isna(med[k])) or
                    (cities[k][i] is not None and abs(cities[k][i] - med[k]) <= 5e-7) for k in ("lat", "lng"))
        known = g.dropna(subset=["province", "region"])
        exp_pair = (None, None) if known.empty else known.groupby(["province", "region"]).size().sort_values(ascending=False).index[0]
        pair_ok = place(city) == tuple(exp_pair)
        allc = data[data["city"] == city]
        mk_ok = True
        for t in TYPES:
            exp = pandas_entry(allc, t)
            got = M["city"].get(city, {}).get(t)
            mk_ok &= (exp == got)
        types_with = [t for t in TYPES if M["city"].get(city, {}).get(t)]
        print(f"  {city:26s} train n={len(g):5d} province={place(city)[0]!s:24s} market types={types_with}"
              f"  [n {'ok' if n_ok else 'BAD'}, latlng {'ok' if ll_ok else 'BAD'}, pair {'ok' if pair_ok else 'BAD'}, market {'ok' if mk_ok else 'BAD'}]")
        check(n_ok, f"{city}: city n"); check(ll_ok, f"{city}: median lat/lng")
        check(pair_ok, f"{city}: province/region"); check(mk_ok, f"{city}: market quantiles")

    print("== province, region, national market (vs pandas) ==")
    for level, name in (("province", "Davao del Sur"), ("region", "Region XI (Davao Region)")):
        frame = data[data[level] == name]
        ok = all(pandas_entry(frame, t) == M[level][name].get(t) for t in TYPES)
        print(f"  {level:9s} {name:26s} {'ok' if ok else 'BAD'}  {M[level][name].get('condo')}")
        check(ok, f"{level} {name}")
    ok = all(pandas_entry(data, t) == M["national"].get(t) for t in TYPES)
    print(f"  national  {'ok' if ok else 'BAD'}  house={M['national']['house']}")
    check(ok, "national")

    print("== typical listing per property type (vs pandas, own condo back-fill) ==")
    tf = train.copy()
    fill = (tf["property_type"] == "condo") & tf["lot_area_m2"].isna() & tf["sqm"].notna()
    tf.loc[fill, "lot_area_m2"] = tf.loc[fill, "sqm"]
    for t in TYPES:
        g = tf[tf["property_type"] == t]
        want = {"n": len(g), "sqm": [round(float(v), 1) for v in np.percentile(g["sqm"].dropna(), [5, 50, 95])]}
        for col, key in (("lot_area_m2", "lot_area_m2"), ("bedrooms", "bedrooms"), ("bathrooms", "bathrooms")):
            want[key] = None if g[col].isna().mean() > 0.5 else float(g[col].median())
        got = lookup["typical"][t]
        print(f"  {t:10s} sqm p5/p50/p95={got['sqm']} lot={got['lot_area_m2']} bed={got['bedrooms']} bath={got['bathrooms']}")
        check(got == want, f"typical values for {t}")

    print("== perf.js ==")
    for key, fname in (("metrics", "metrics.json"), ("analysis", "analysis.json")):
        src = json.loads((PROJECT / "results" / fname).read_text(encoding="utf-8"))
        check(perf[key] == src, f"{key} embedded verbatim from results/{fname}")
    S = perf["sample"]
    counts = pd.Series([S["types"][t] for t in S["type"]]).value_counts()
    test_share = data.iloc[te]["property_type"].value_counts(normalize=True)
    print(f"  sample n={S['n']} by type {counts.to_dict()} (test share {(test_share*100).round(1).to_dict()})")
    check(S["n"] == 3000 and all(abs(counts[t] / 3000 - test_share[t]) < 0.002 for t in TYPES), "sample is stratified")
    rq = perf["ratio_quantiles"]
    check(sum(rq[t]["n"] for t in TYPES) == 45_288 == rq["all"]["n"], "ratio quantiles cover the whole test set")
    for t in TYPES:
        sel = [i for i, k in enumerate(S["type"]) if S["types"][k] == t]
        r = np.array([S["actual"][i] / S["predicted"][i] for i in sel])
        cov = float(((r >= rq[t]["q10"]) & (r <= rq[t]["q90"])).mean())
        print(f"  {t:10s} ratio q10/q50/q90 = {rq[t]['q10']:.3f}/{rq[t]['q50']:.3f}/{rq[t]['q90']:.3f}"
              f"   sample coverage of the 10-90 band = {cov:.1%} (n={len(sel)})")
        check(abs(cov - 0.8) < 0.06, f"{t}: 10-90 band covers about 80% of the sample")
    H2 = perf["price_hist"]
    for t in TYPES:
        check(sum(H2["counts"][t]) + H2["outside"][t] == int((data["property_type"] == t).sum()), f"hist covers all {t}")
    check(all(H2["outside"][t] == 0 for t in TYPES), "no listing outside the histogram range")

    print("RESULT:", "PASS" if not failures else f"FAIL ({len(failures)})")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
