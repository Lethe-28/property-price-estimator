"""Export the fitted Random Forest and its preprocessing to plain data files for the browser app.

Run from the project root:

    python -B scripts/export_web_app.py [--trees 300] [--out PropertyPriceEstimator]

Reads artifacts/price_pipeline.joblib (read only) and writes into <out>/data/:

    forest.js    window.FOREST: every tree's nodes as base64 typed arrays (spec section 6)
    lookup.js    window.LOOKUP: preprocessing constants taken from the fitted objects, input
                 bounds, the location hierarchy and per-place market quantiles.
    perf.js      window.PERF: results/metrics.json and results/analysis.json verbatim, a stratified
                 3,000-row test sample, held-out error-ratio quantiles, price-distribution bins.

Deterministic: the same artifact gives byte-identical files. `--trees N` keeps the first N trees
(a valid forest of its own); the default 300 is the exact paper model.

Node layout, one set of arrays over all nodes of all trees in sklearn depth-first preorder, so
the left child of node i is i+1 and only the right child is stored:

    feat   int8     feature index 0..12, -1 for a leaf
    val    float32  split threshold, or the prediction for a leaf
    right  uint16   right child, index local to its tree (0 for a leaf)
    offset uint32   start node of each tree; offset[n_trees] = total nodes

On disk the same data is stored smaller (lossless; model.js rebuilds the arrays above at load):
`feat` for every node, then `thr` and `right` for internal nodes only and `leaf` for leaves only
(a leaf needs no threshold or child), each wider-than-one-byte array byte-plane shuffled (all first
bytes, then all second bytes, ...) so deflate sees long runs of similar bytes. Measured on this
forest, zipped: unified 52.0 MB, split 47.9 MB, split + shuffle 41.1 MB.

Thresholds: sklearn casts inputs to float32 and tests `x <= threshold` against a float64
threshold. A float32 copy is exactly equivalent for every float32 input only if each threshold is
rounded toward negative infinity (the largest float32 <= the float64 value). Nearest rounding
can flip a split.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True

import joblib
import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

PROJECT = Path(__file__).resolve().parent.parent
ARTIFACT = PROJECT / "artifacts" / "price_pipeline.joblib"
RESULTS = PROJECT / "results"
sys.path.insert(0, str(PROJECT / "scripts"))
sys.path.insert(0, str(PROJECT / "app"))
import make_results_analysis as mra  # noqa: E402  load() and the seed-42 split, reused as is
import predict as app_predict  # noqa: E402  NUMERIC_BOUNDS, read only

MIN_MARKET_N = 30          # a (place, property type) needs this many listings to get quantiles
SAMPLE_N = 3000
HIST_EDGES = np.round(np.arange(5.5, 9.0501, 0.05), 2)   # log10 pesos; data runs 3.5e5 to 1e9
TYPES = list(app_predict.PROPERTY_TYPES)
CHUNK_BYTES = 786_432  # 3 * 2**18: a multiple of 3 so base64 chunks carry no padding mid-array


def floor_float32(t: np.ndarray) -> np.ndarray:
    """Largest float32 <= each float64 value (round toward -inf)."""
    f = t.astype(np.float32)
    over = f.astype(np.float64) > t
    f[over] = np.nextafter(f[over], np.float32(-np.inf))
    assert (f.astype(np.float64) <= t).all()
    return f


def pack_forest(model, n_trees: int) -> dict:
    trees = [e.tree_ for e in model.estimators_[:n_trees]]
    counts = np.array([t.node_count for t in trees], dtype=np.int64)
    offset = np.concatenate([[0], np.cumsum(counts)]).astype(np.uint32)
    total = int(offset[-1])
    feat = np.empty(total, dtype=np.int8)
    val = np.empty(total, dtype=np.float32)
    right = np.empty(total, dtype=np.uint16)
    for k, tr in enumerate(trees):
        a, b = int(offset[k]), int(offset[k + 1])
        left = tr.children_left
        internal = left >= 0
        idx = np.nonzero(internal)[0]
        assert (left[idx] == idx + 1).all(), "tree is not in depth-first preorder"
        assert int(tr.node_count) <= 65_535, "uint16 child index would overflow"
        feat[a:b] = np.where(internal, tr.feature, -1)
        val[a:b] = np.where(internal, 0.0, tr.value[:, 0, 0]).astype(np.float32)
        val[a:b][internal] = floor_float32(tr.threshold[internal])
        right[a:b] = np.where(internal, tr.children_right, 0)
    assert feat.max() <= 12 and feat.min() >= -1
    return {"n_trees": len(trees), "n_nodes": total, "offset": offset,
            "feat": feat, "val": val, "right": right}


def b64_chunks(arr: np.ndarray) -> list[str]:
    raw = arr.astype(arr.dtype.newbyteorder("<"), copy=False).tobytes()
    return [base64.b64encode(raw[i:i + CHUNK_BYTES]).decode("ascii")
            for i in range(0, len(raw), CHUNK_BYTES)]


def byte_planes(arr: np.ndarray) -> np.ndarray:
    """Little-endian byte-plane shuffle: all byte 0s, then all byte 1s, ..."""
    le = np.ascontiguousarray(arr.astype(arr.dtype.newbyteorder("<"), copy=False))
    return le.view(np.uint8).reshape(-1, le.dtype.itemsize).T.copy().reshape(-1)


def write_forest_js(packed: dict, path: Path) -> None:
    internal = packed["feat"] >= 0
    n_internal = int(internal.sum())
    obj = {
        "n_trees": packed["n_trees"],
        "n_nodes": packed["n_nodes"],
        "n_internal": n_internal,
        "offset": packed["offset"].tolist(),
        "feat": b64_chunks(packed["feat"]),
        "thr": b64_chunks(byte_planes(packed["val"][internal])),
        "right": b64_chunks(byte_planes(packed["right"][internal])),
        "leaf": b64_chunks(byte_planes(packed["val"][~internal])),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    # JSON is a subset of JavaScript, so this is a valid classic script that works from file://.
    path.write_text("globalThis.FOREST=" + json.dumps(obj, separators=(",", ":")) + ";\n",
                    encoding="ascii", newline="\n")


def preproc_from_pipeline(pipe) -> dict:
    """Constants read straight from the fitted objects; nothing is assumed."""
    pre = pipe.named_steps["preprocess"]
    names = [str(n) for n in pre.get_feature_names_out()]
    assert [t[0] for t in pre.transformers_] == ["num", "te", "onehot"] and pre.remainder == "drop"
    num_cols, te_cols, oh_cols = (list(t[2]) for t in pre.transformers_)

    num = pre.named_transformers_["num"]
    te_pipe = pre.named_transformers_["te"]
    te_imp = te_pipe.named_steps["impute"]
    te_enc = te_pipe.named_steps["encode"]
    oh_pipe = pre.named_transformers_["onehot"]
    oh_imp = oh_pipe.named_steps["impute"]
    oh_enc = oh_pipe.named_steps["encode"]

    assert te_enc.target_type_ == "continuous"
    te = {}
    for col, cats, enc in zip(te_cols, te_enc.categories_, te_enc.encodings_):
        te[col] = {"names": [str(c) for c in cats], "values": [float(v) for v in enc]}
    categories = [str(c) for c in oh_enc.categories_[0]]
    # Cross-check the assumed feature order against what the fitted pipeline reports.
    expected_names = ([f"num__{c}" for c in num_cols] + [f"te__{c}" for c in te_cols]
                      + [f"onehot__property_type_{c}" for c in categories])
    assert names == expected_names, f"feature order differs:\n{names}\n{expected_names}"
    assert num_cols == ["sqm", "lot_area_m2", "bedrooms", "bathrooms", "lat", "lng"]
    assert te_cols == ["city", "province", "region"] and oh_cols == ["property_type"]

    return {
        "feature_names": names,
        "num": {"columns": num_cols, "medians": [float(v) for v in num.statistics_]},
        "te": {"columns": te_cols,
               "most_frequent": [str(v) for v in te_imp.statistics_],
               "target_mean": float(te_enc.target_mean_),
               "encodings": te},
        "onehot": {"column": "property_type", "categories": categories,
                   "most_frequent": str(oh_imp.statistics_[0])},
    }


def load_split():
    """Deduplicated data plus the paper's stratified 80/20 split, exactly as the notebook made it."""
    X, y, data = mra.load()
    idx = np.arange(len(data))
    tr, te = train_test_split(idx, test_size=0.2, random_state=mra.SEED, stratify=data["property_type"])
    assert len(tr) == 181_150 and len(te) == 45_288
    return X, y, data, tr, te


def forest_predict(pipe, frame: pd.DataFrame, n_trees: int) -> np.ndarray:
    """Mean of the first n_trees trees, summed in a fixed order so output is reproducible."""
    m = np.ascontiguousarray(pipe.named_steps["preprocess"].transform(frame), dtype=np.float32)
    trees = pipe.named_steps["model"].estimators_[:n_trees]
    total = np.zeros(len(frame))
    for e in trees:
        total += e.predict(m, check_input=False)
    return total / len(trees)


def mode_pair(group: pd.DataFrame):
    counts = group.groupby(["province", "region"]).size().reset_index(name="n")
    top = counts.sort_values(["n", "province", "region"], ascending=[False, True, True]).iloc[0]
    return top["province"], top["region"]


def build_hierarchy(data: pd.DataFrame, train: np.ndarray, city_names: list[str]) -> dict:
    """Region > province > city from the TRAINING split (the categories the model has seen).

    A city's province is its most frequent recorded (province, region) pair. 630 of the 1,455
    cities have no recorded province at all (2.2% of training rows); they get province -1, and the
    app leaves province and region blank for them, which is how training treated those rows.
    """
    t = data.iloc[train]
    assert (t["province"].isna() == t["region"].isna()).all()
    cities = sorted(city_names)
    known = t.dropna(subset=["province", "region"])
    assert (known.groupby("province")["region"].nunique() == 1).all(), "a province spans regions"
    pair = {c: mode_pair(g) for c, g in known.groupby("city")}
    prov_region = known.groupby("province")["region"].first()
    regions = sorted(known["region"].unique())
    provinces = sorted(prov_region.index)
    pidx = {p: i for i, p in enumerate(provinces)}
    n = t.groupby("city").size()
    med = t.groupby("city")[["lat", "lng"]].median()
    return {
        "regions": regions,
        "provinces": {"name": provinces, "region": [regions.index(prov_region[p]) for p in provinces]},
        "cities": {
            "name": cities,
            "province": [pidx[pair[c][0]] if c in pair else -1 for c in cities],
            "n": [int(n[c]) for c in cities],
            "lat": [None if pd.isna(med.loc[c, "lat"]) else round(float(med.loc[c, "lat"]), 6) for c in cities],
            "lng": [None if pd.isna(med.loc[c, "lng"]) else round(float(med.loc[c, "lng"]), 6) for c in cities],
        },
    }


def build_market(data: pd.DataFrame) -> dict:
    """Asking-price quantiles per (place, property type) from ALL deduplicated listings.

    Entry = [n, p05, p25, p50, p75, p95] in whole pesos, kept only where n >= MIN_MARKET_N.
    Level keys are the place names, matching how the model keys its encoders.
    """
    def entry(prices: pd.Series):
        if len(prices) < MIN_MARKET_N:
            return None
        q = np.percentile(prices.to_numpy(), [5, 25, 50, 75, 95])
        return [int(len(prices))] + [int(round(v)) for v in q]

    def by_type(frame: pd.DataFrame) -> dict:
        out = {}
        for t in TYPES:
            e = entry(frame.loc[frame["property_type"] == t, "price_php"])
            if e:
                out[t] = e
        return out

    levels = {"national": by_type(data)}
    for level in ("region", "province", "city"):
        levels[level] = {}
        for name, g in data.dropna(subset=[level]).groupby(level):
            e = by_type(g)
            if e:
                levels[level][str(name)] = e
    return {"min_n": MIN_MARKET_N, "columns": ["n", "p05", "p25", "p50", "p75", "p95"],
            "price_unit": "PHP", "levels": levels}


def build_typical(X: pd.DataFrame, train: np.ndarray) -> dict:
    """What a typical listing of each property type looks like, from the training split.

    The pipeline's own medians pool all four types (130 m2 floor area), which is not typical of a
    condo (about 48 m2). The app uses these per-type values for "if this input were typical" and to
    choose a sensible floor-area range. A median of None means the type almost never records that
    field; the app then leaves it blank, which is what training did for those rows.
    """
    t = X.iloc[train]          # X already carries the condo lot-area back-fill

    def med(s: pd.Series):
        """Median, or None when more than half the listings of this type leave the field blank."""
        return None if s.isna().mean() > 0.5 else float(s.dropna().median())

    out = {}
    for ty in TYPES:
        g = t[t["property_type"] == ty]
        sq = g["sqm"].dropna().to_numpy()
        out[ty] = {"n": int(len(g)), "sqm": [round(float(v), 1) for v in np.percentile(sq, [5, 50, 95])],
                   "lot_area_m2": med(g["lot_area_m2"]), "bedrooms": med(g["bedrooms"]),
                   "bathrooms": med(g["bathrooms"])}
    return out


def build_perf(pipe, X, y, data, te, n_trees: int) -> dict:
    x_te, y_te = X.iloc[te], y.iloc[te].to_numpy()
    pred = forest_predict(pipe, x_te, n_trees)
    assert (pred > 0).all()
    if n_trees == len(pipe.named_steps["model"].estimators_):
        # The sample is only trustworthy if these predictions are the paper's.
        from sklearn.metrics import r2_score
        local = json.loads((RESULTS / "metrics_local_py314.json").read_text(encoding="utf-8"))
        ref = local["holdout"]["RandomForestRegression"]["r2"]
        assert abs(r2_score(y_te, pred) - ref) < 1e-9, "test predictions do not reproduce the reported R2"
    ptype = x_te["property_type"].to_numpy()
    ratio = y_te / pred

    def q(r):
        return {"n": int(len(r)),
                **dict(zip(("q10", "q50", "q90"), (float(v) for v in np.percentile(r, [10, 50, 90]))))}

    ratio_q = {t: q(ratio[ptype == t]) for t in TYPES}
    ratio_q["all"] = q(ratio)

    pick, _ = train_test_split(np.arange(len(te)), train_size=SAMPLE_N, random_state=mra.SEED, stratify=ptype)
    pick = np.sort(pick)
    sample_cities = data.iloc[te[pick]]["city"].tolist()
    cities = sorted(set(sample_cities))
    cidx = {c: i for i, c in enumerate(cities)}
    sample = {
        "n": int(len(pick)), "types": TYPES, "cities": cities,
        "type": [TYPES.index(t) for t in ptype[pick]],
        "city": [cidx[c] for c in sample_cities],
        "actual": [int(round(v)) for v in y_te[pick]],
        "predicted": [int(round(v)) for v in pred[pick]],
    }
    logp = np.log10(data["price_php"].to_numpy())
    hist = {"edges_log10": [float(e) for e in HIST_EDGES], "counts": {}, "outside": {}}
    for t in TYPES:
        v = logp[(data["property_type"] == t).to_numpy()]
        counts, _ = np.histogram(v, bins=HIST_EDGES)
        hist["counts"][t] = [int(c) for c in counts]
        hist["outside"][t] = int(len(v) - counts.sum())
    manifest = json.loads((PROJECT / "dataset_manifest.json").read_text(encoding="utf-8"))
    dataset = {k: manifest["dataset"][k] for k in ("source_repo", "declared_snapshot_date", "rows_raw", "rows_deduplicated")}
    dataset["out_of_domain"] = manifest["data_quality"]["out_of_domain"]
    dataset["missing_pct_deduplicated"] = manifest["data_quality"]["missing_pct_deduplicated"]
    return {
        "metrics": json.loads((RESULTS / "metrics.json").read_text(encoding="utf-8")),
        "analysis": json.loads((RESULTS / "analysis.json").read_text(encoding="utf-8")),
        "dataset": dataset,
        "sample": sample, "ratio_quantiles": ratio_q, "price_hist": hist,
        "meta": {"n_trees": n_trees, "test_rows": int(len(te)), "sample_seed": mra.SEED,
                 "sample_note": "stratified on property_type from the paper's 45,288-row test set; "
                                "predicted = the exported forest; ratio = actual / predicted"},
    }


def write_global_js(name: str, obj: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = f"globalThis.{name}=" + json.dumps(obj, separators=(",", ":"), ensure_ascii=True,
                                              allow_nan=False) + ";\n"
    path.write_text(text, encoding="ascii", newline="\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trees", type=int, default=300)
    ap.add_argument("--out", type=Path, default=PROJECT / "PropertyPriceEstimator")
    args = ap.parse_args()

    pipe = joblib.load(ARTIFACT)
    model = pipe.named_steps["model"]
    assert 1 <= args.trees <= len(model.estimators_)

    packed = pack_forest(model, args.trees)
    data_dir = args.out / "data"
    write_forest_js(packed, data_dir / "forest.js")

    model.n_jobs = 1   # fixed summation order for the sample predictions; the artifact is untouched
    X, y, data, tr, te = load_split()
    preproc = preproc_from_pipeline(pipe)
    hierarchy = build_hierarchy(data, tr, preproc["te"]["encodings"]["city"]["names"])
    lookup = {"preproc": preproc, "n_trees": packed["n_trees"],
              # (min, max, default) per numeric input, read from app/predict.py, not retyped
              "bounds": {k: list(v) for k, v in app_predict.NUMERIC_BOUNDS.items()},
              "property_types": TYPES, "hierarchy": hierarchy, "market": build_market(data),
              "typical": build_typical(X, tr)}
    write_global_js("LOOKUP", lookup, data_dir / "lookup.js")
    write_global_js("PERF", build_perf(pipe, X, y, data, te, args.trees), data_dir / "perf.js")

    raw = sum(packed[k].nbytes for k in ("feat", "val", "right", "offset"))
    f = data_dir / "forest.js"
    print(f"trees={packed['n_trees']} nodes={packed['n_nodes']:,}")
    print(f"typed arrays raw        : {raw / 1e6:7.1f} MB")
    print(f"forest.js on disk       : {f.stat().st_size / 1e6:7.1f} MB (base64)")
    # Measure the real compressed size the way the zip will store it (deflate, level 9).
    probe = args.out / "_size_probe.zip"
    with zipfile.ZipFile(probe, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(f, "data/forest.js")
    print(f"forest.js zipped        : {probe.stat().st_size / 1e6:7.1f} MB (deflate level 9)")
    probe.unlink()
    for name in ("lookup.js", "perf.js"):
        print(f"{name:24s}: {(data_dir / name).stat().st_size / 1e3:7.1f} KB")
    h = hierarchy["cities"]
    print(f"hierarchy: {len(hierarchy['regions'])} regions, {len(hierarchy['provinces']['name'])} provinces, "
          f"{len(h['name'])} cities ({sum(p < 0 for p in h['province'])} without a recorded province)")


if __name__ == "__main__":
    main()
