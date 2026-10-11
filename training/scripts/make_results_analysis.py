"""Supplementary Results analyses, computed from the real data and the saved model.

Run from the project root:

    python scripts/make_results_analysis.py

Reads data/listings.csv and artifacts/price_pipeline.joblib, replays the notebook's
deduplication, feature construction and 80/20 split exactly, and writes:

    results/analysis.json                     every number the Results section quotes that
                                              metrics.json does not already hold
    figures/price_distribution.png            Figure: shape of the target
    figures/model_comparison.png              Figure: the two models side by side
    figures/actual_vs_predicted.png           Figure: calibration of the Random Forest
    figures/feature_importance.png            Figure: pricing drivers (Objective 3)
    figures/spatial_generalisation.png        Figure: Davao City versus the national market

It also refits both estimators once, on the preprocessed training matrix, to time them
(Objective 2 names efficiency). That refit is checked against the committed local-run
metrics, so a timing taken on a model that differs from the reported one cannot pass.

The saved artifact is the Random Forest, so every Random Forest analysis here is exact.
XGBoost is not saved; its numbers come only from metrics.json and the timing refit.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import joblib
import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.metrics import r2_score
from sklearn.model_selection import train_test_split
from xgboost import XGBRegressor

PROJECT = Path(__file__).resolve().parent.parent
DATA = PROJECT / "data" / "listings.csv"
ARTIFACT = PROJECT / "artifacts" / "price_pipeline.joblib"
LOCAL = PROJECT / "results" / "metrics_local_py314.json"
OUT_JSON = PROJECT / "results" / "analysis.json"
FIGURES = PROJECT / "figures"

SEED = 42
FEATURES = ["sqm", "lot_area_m2", "bedrooms", "bathrooms", "lat", "lng",
            "city", "province", "region", "property_type"]
# Objective 3 asks "location vs. size vs. type", so the groups follow that wording.
GROUPS = {
    "Location": ["city", "province", "region", "lat", "lng"],
    "Size": ["sqm", "lot_area_m2", "bedrooms", "bathrooms"],
    "Property type": ["property_type"],
}
N_REPEATS = 5

INK, MUTED, ACCENT, WARN, GRID = "#1f2933", "#7b8794", "#2f6f9f", "#c2703d", "#dde3e8"
GROUP_COLOUR = {"Location": ACCENT, "Size": WARN, "Property type": "#5b8f6b"}
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 10, "axes.edgecolor": MUTED,
    "axes.labelcolor": INK, "xtick.color": INK, "ytick.color": INK,
    "axes.spines.top": False, "axes.spines.right": False,
})


def load() -> tuple[pd.DataFrame, pd.Series, pd.DataFrame]:
    """The notebook's dedup + back-fill, verbatim in behaviour."""
    raw = pd.read_csv(DATA, low_memory=False)
    assert len(raw) == 241_496
    ordered = raw.assign(_ls=pd.to_datetime(raw["last_seen"], format="%Y-%m-%d"))
    ordered = ordered.sort_values(["_ls", "canonical_id"], kind="mergesort", ignore_index=True)
    data = ordered.drop_duplicates(subset="canonical_id", keep="last").reset_index(drop=True)
    data = data.drop(columns="_ls")
    assert len(data) == 226_438
    frame = data.copy()
    condo = frame["property_type"] == "condo"
    fill = condo & frame["lot_area_m2"].isna() & frame["sqm"].notna()
    frame.loc[fill, "lot_area_m2"] = frame.loc[fill, "sqm"]
    return frame[FEATURES].copy(), frame["price_php"].astype("float64"), data


def predict(pipeline, x: pd.DataFrame) -> np.ndarray:
    matrix = pipeline.named_steps["preprocess"].transform(x).astype("float32")
    return np.asarray(pipeline.named_steps["model"].predict(matrix), dtype="float64")


def log_r2(y, p) -> float:
    return float(r2_score(np.log1p(y), np.log1p(np.clip(p, 0, None))))


def main() -> None:
    local = json.loads(LOCAL.read_text(encoding="utf-8"))
    X, y, data = load()
    idx = np.arange(len(data))
    tr, te = train_test_split(idx, test_size=0.2, random_state=SEED,
                              stratify=data["property_type"])
    x_tr, x_te, y_tr, y_te = X.iloc[tr], X.iloc[te], y.iloc[tr], y.iloc[te]
    ptype_te = x_te["property_type"].to_numpy()

    pipe = joblib.load(ARTIFACT)
    pred = predict(pipe, x_te)
    rf_ref = local["holdout"]["RandomForestRegression"]
    assert abs(r2_score(y_te, pred) - rf_ref["r2"]) < 1e-9, "artifact does not reproduce RF R2"
    assert abs(log_r2(y_te, pred) - rf_ref["log_space_r2"]) < 1e-9
    print("artifact reproduces the reported Random Forest metrics")

    out: dict = {"n_train": len(tr), "n_test": len(te), "permutation_repeats": N_REPEATS}

    # ---- target distribution (deduplicated data) --------------------------------
    quant = y.quantile([0.05, 0.25, 0.5, 0.75, 0.95, 0.99])
    out["price_distribution"] = {
        "n": int(len(y)), "mean": float(y.mean()), "median": float(y.median()),
        "p05": float(quant[0.05]), "p25": float(quant[0.25]), "p75": float(quant[0.75]),
        "p95": float(quant[0.95]), "p99": float(quant[0.99]),
        "skewness": float(y.skew()), "log_skewness": float(np.log(y).skew()),
        "by_type_median": {t: float(v) for t, v in y.groupby(X["property_type"]).median().items()},
        "by_type_n": {t: int(v) for t, v in X["property_type"].value_counts().items()},
    }

    # ---- practical accuracy ------------------------------------------------------
    ape = np.abs(pred - y_te.to_numpy()) / y_te.to_numpy()
    out["practical_accuracy"] = {
        "median_ape_pct": float(np.median(ape) * 100),
        "within_25_pct": float((ape <= 0.25).mean() * 100),
        "within_50_pct": float((ape <= 0.50).mean() * 100),
        "within_100_pct": float((ape <= 1.00).mean() * 100),
    }
    signed_log = np.log(pred) - np.log(y_te.to_numpy())
    out["median_log_error_factor"] = float(np.exp(np.median(np.abs(signed_log))))

    # ---- by property type --------------------------------------------------------
    by_type = {}
    for t in ["house", "condo", "lot", "commercial"]:
        m = ptype_te == t
        yt, pt = y_te.to_numpy()[m], pred[m]
        a = np.abs(pt - yt) / yt
        by_type[t] = {
            "n": int(m.sum()), "median_price": float(np.median(yt)),
            "r2": float(r2_score(yt, pt)), "log_r2": log_r2(yt, pt),
            "mae": float(np.mean(np.abs(pt - yt))),
            "median_ape_pct": float(np.median(a) * 100),
            "within_50_pct": float((a <= 0.5).mean() * 100),
        }
    out["by_property_type"] = by_type

    # ---- by price tier (quintiles of the actual price) -----------------------------
    edges = np.quantile(y_te, [0, .2, .4, .6, .8, 1.0])
    tier = np.clip(np.searchsorted(edges, y_te.to_numpy(), side="right") - 1, 0, 4)
    tiers = []
    for k in range(5):
        m = tier == k
        yt, pt = y_te.to_numpy()[m], pred[m]
        tiers.append({
            "tier": k + 1, "n": int(m.sum()), "price_min": float(yt.min()),
            "price_max": float(yt.max()),
            "median_signed_error_pct": float(np.median((pt - yt) / yt) * 100),
            "median_ape_pct": float(np.median(np.abs(pt - yt) / yt) * 100),
        })
    out["by_price_tier"] = tiers

    # ---- feature importance (Objective 3) ----------------------------------------
    model = pipe.named_steps["model"]
    names = list(pipe.named_steps["preprocess"].get_feature_names_out())
    imp = dict(zip(names, model.feature_importances_))
    def group_of(col: str) -> str:
        for g, cols in GROUPS.items():
            if any(c in col for c in cols):
                return g
        raise KeyError(col)
    impurity_group = {g: 0.0 for g in GROUPS}
    for col, v in imp.items():
        impurity_group[group_of(col)] += float(v)
    out["impurity_importance_group"] = impurity_group
    out["impurity_importance_columns"] = {c: float(v) for c, v in imp.items()}

    def perm_all(pred_fn, base_pred):
        """Permutation importance, per feature and per group, on the held-out set.

        The generator is re-seeded per model so each model's shuffles do not depend on
        which model was scored first. Columns of one group move together, so their mutual
        dependence survives the shuffle.
        """
        base_r2 = float(r2_score(y_te, base_pred)); base_log = log_r2(y_te, base_pred)
        rng = np.random.default_rng(SEED)

        def permute(cols):
            d_r2, d_log = [], []
            for _ in range(N_REPEATS):
                shuffled = x_te.copy()
                order = rng.permutation(len(shuffled))
                shuffled[cols] = x_te[cols].iloc[order].to_numpy()
                p = pred_fn(shuffled)
                d_r2.append(base_r2 - r2_score(y_te, p))
                d_log.append(base_log - log_r2(y_te, p))
            return {"drop_r2": float(np.mean(d_r2)), "drop_log_r2": float(np.mean(d_log))}

        return {"feature": {c: permute([c]) for c in FEATURES},
                "group": {g: permute(cols) for g, cols in GROUPS.items()}}

    out["permutation_importance"] = {
        "RandomForestRegression": perm_all(lambda xf: predict(pipe, xf), pred)}
    print("permutation importance done")

    # ---- efficiency (Objective 2) --------------------------------------------------
    # One preprocessing fit, then time each estimator's own fit on the same matrix, so the
    # figure measures the algorithm and not the shared encoder.
    from sklearn.pipeline import Pipeline  # noqa: F401  (clarity: same structure as artifact)
    pre = clone(pipe.named_steps["preprocess"])
    # fit_transform, not fit then transform: the target encoder cross-fits on the training
    # rows, so the two differ, and Pipeline.fit uses fit_transform.
    t0 = time.perf_counter(); m_tr = pre.fit_transform(x_tr, y_tr).astype("float32")
    t_pre = time.perf_counter() - t0
    m_te = pre.transform(x_te).astype("float32")
    cfg = local["config"]
    rf = clone(model)
    xgb = XGBRegressor(**{k: v for k, v in cfg["XGBoostRegression"].items() if k != "estimator"})
    timing = {"preprocessing_fit_s": t_pre}
    xgb_pred = None
    for name, est in (("RandomForestRegression", rf), ("XGBoostRegression", xgb)):
        t0 = time.perf_counter(); est.fit(m_tr, y_tr); fit_s = time.perf_counter() - t0
        t0 = time.perf_counter(); p = est.predict(m_te); pred_s = time.perf_counter() - t0
        timing[name] = {"fit_s": fit_s, "predict_45288_s": pred_s,
                        "predict_ms_per_1000": pred_s / len(m_te) * 1e6}
        if name == "XGBoostRegression":
            xgb_pred = np.asarray(p, dtype="float64")
    # The refit must be the reported model, or the timing describes something else.
    xr = local["holdout"]["XGBoostRegression"]
    assert abs(r2_score(y_te, xgb_pred) - xr["r2"]) < 1e-6, "XGBoost refit != committed metrics"
    timing["xgboost_refit_matches_committed_r2"] = True
    timing["artifact_size_mb"] = ARTIFACT.stat().st_size / 1e6
    timing["cpu_count"] = __import__("os").cpu_count()
    out["efficiency"] = timing
    # XGBoost is not saved as an artifact, so its importance comes from this refit, which
    # was just asserted to reproduce the committed model.
    out["permutation_importance"]["XGBoostRegression"] = perm_all(
        lambda xf: np.asarray(xgb.predict(pre.transform(xf).astype("float32")), dtype="float64"),
        xgb_pred)
    xnames = list(pre.get_feature_names_out())
    xgb_group = {g: 0.0 for g in GROUPS}
    for col, v in zip(xnames, xgb.feature_importances_):
        xgb_group[group_of(col)] += float(v)
    out["impurity_importance_group_xgboost_gain"] = xgb_group
    print("timing done; XGBoost refit matches committed local metrics")

    # ---- bias, and how the price tiers are cut ----------------------------------
    # Grouping by ACTUAL price makes any noisy predictor look compressed toward the middle
    # (the cheapest cases can only be over-predicted on average and the dearest under-
    # predicted), so the same error is also reported grouped by PREDICTED price.
    signed = (pred - y_te.to_numpy()) / y_te.to_numpy()
    out["bias"] = {
        "median_signed_error_pct": float(np.median(signed) * 100),
        "share_over_predicted_pct": float((signed > 0).mean() * 100),
        "median_signed_log_error": float(np.median(np.log(pred) - np.log(y_te.to_numpy()))),
    }
    pedges = np.quantile(pred, [0, .2, .4, .6, .8, 1.0])
    ptier = np.clip(np.searchsorted(pedges, pred, side="right") - 1, 0, 4)
    out["by_predicted_tier"] = [
        {"tier": k + 1, "n": int((ptier == k).sum()),
         "median_signed_error_pct": float(np.median(signed[ptier == k]) * 100)}
        for k in range(5)]

    # ---- signed error on the spatial holdout (both models) -----------------------
    is_d = (data["city"] == "Davao City").to_numpy()
    xs_tr, xs_te = X.loc[~is_d], X.loc[is_d]
    ys_tr, ys_te = y.loc[~is_d], y.loc[is_d]
    pre_s = clone(pipe.named_steps["preprocess"])
    ms_tr = pre_s.fit_transform(xs_tr, ys_tr).astype("float32")
    ms_te = pre_s.transform(xs_te).astype("float32")
    spatial_bias = {}
    for name, est in (("RandomForestRegression", clone(model)),
                      ("XGBoostRegression", XGBRegressor(**{k: v for k, v in cfg["XGBoostRegression"].items() if k != "estimator"}))):
        ps = np.asarray(est.fit(ms_tr, ys_tr).predict(ms_te), dtype="float64")
        ref = local["spatial_holdout"]["metrics"][name]["r2"]
        assert abs(r2_score(ys_te, ps) - ref) < 1e-6, f"{name} spatial refit != committed metrics"
        sg = (ps - ys_te.to_numpy()) / ys_te.to_numpy()
        pos = ps > 0
        spatial_bias[name] = {
            "median_signed_error_pct": float(np.median(sg) * 100),
            "share_over_predicted_pct": float((sg > 0).mean() * 100),
            "median_signed_log_error_positive_only": float(np.median(np.log(ps[pos]) - np.log(ys_te.to_numpy()[pos]))),
        }
    out["spatial_bias"] = spatial_bias
    print("bias and spatial-bias done; spatial refits match committed metrics")

    OUT_JSON.write_text(json.dumps(out, indent=2), encoding="utf-8")

    # =============================== figures =======================================
    FIGURES.mkdir(exist_ok=True)

    # Figure: price distribution
    fig, (a, b) = plt.subplots(1, 2, figsize=(12, 4.8), gridspec_kw={"width_ratios": [1.15, 1]})
    lp = np.log10(y)
    a.hist(lp, bins=80, color=ACCENT, alpha=.85)
    for val, lab, col in ((y.median(), "median", INK), (y.mean(), "mean", WARN)):
        a.axvline(np.log10(val), color=col, ls="--", lw=1.6)
        a.text(np.log10(val), a.get_ylim()[1], f" {lab} ₱{val/1e6:,.1f}M ", color=col,
               va="bottom", ha="left" if lab == "mean" else "right", fontsize=9)
    a.set_xticks(range(5, 10)); a.set_xticklabels([f"₱{10**k:,.0f}" if k < 6 else f"₱{10**(k-6):,.0f}M" for k in range(5, 10)])
    a.set_xlabel("Asking price (logarithmic scale)"); a.set_ylabel("Number of listings")
    a.set_title(f"(a) Asking prices, n = {len(y):,}", loc="left", fontsize=11, color=INK, pad=20)
    types = ["house", "condo", "lot", "commercial"]
    bp = b.boxplot([np.log10(y[X["property_type"] == t]) for t in types], tick_labels=types,
                   patch_artist=True, showfliers=False, medianprops={"color": INK})
    for patch in bp["boxes"]:
        patch.set(facecolor=ACCENT, alpha=.55, edgecolor=MUTED)
    b.set_yticks(range(5, 10)); b.set_yticklabels([f"₱{10**k:,.0f}" if k < 6 else f"₱{10**(k-6):,.0f}M" for k in range(5, 10)])
    b.set_title("(b) By property type (outliers hidden)", loc="left", fontsize=11, color=INK)
    b.set_xlabel("Property type"); b.grid(axis="y", color=GRID)
    fig.tight_layout(); fig.savefig(FIGURES / "price_distribution.png", dpi=200, facecolor="white"); plt.close(fig)

    # Figure: model comparison (both models, primary holdout, from the committed local run)
    hx = local["holdout"]
    fig, axes = plt.subplots(1, 3, figsize=(12.5, 4.4))
    labels = ["Random Forest", "XGBoost"]
    cols = [ACCENT, WARN]
    v = [hx["RandomForestRegression"]["r2"], hx["XGBoostRegression"]["r2"]]
    axes[0].bar(labels, v, color=cols); axes[0].set_ylim(0, .8)
    axes[0].set_title("(a) R², peso scale", loc="left", fontsize=11)
    for i, s in enumerate(v): axes[0].text(i, s + .015, f"{s:.4f}", ha="center", fontweight="bold")
    w = .36; xs = np.arange(2)
    inc = [hx[k]["log_space_r2"] for k in ("RandomForestRegression", "XGBoostRegression")]
    exc = [hx[k]["log_space_r2_excl_non_positive"] for k in ("RandomForestRegression", "XGBoostRegression")]
    axes[1].bar(xs - w/2, inc, w, color=cols, label="all predictions")
    axes[1].bar(xs + w/2, exc, w, color=cols, alpha=.4, hatch="//", edgecolor="white", label="excluding non-positive")
    axes[1].set_xticks(xs); axes[1].set_xticklabels(labels); axes[1].set_ylim(0, .8)
    axes[1].set_title("(b) R², logarithmic scale", loc="left", fontsize=11)
    for i in range(2):
        axes[1].text(i - w/2, inc[i] + .015, f"{inc[i]:.3f}", ha="center", fontsize=9)
        axes[1].text(i + w/2, exc[i] + .015, f"{exc[i]:.3f}", ha="center", fontsize=9)
    axes[1].legend(frameon=False, fontsize=8, loc="upper right")
    npz = [hx[k]["n_non_positive_predictions"] for k in ("RandomForestRegression", "XGBoostRegression")]
    axes[2].bar(labels, npz, color=cols)
    axes[2].set_title("(c) Impossible (≤ ₱0) predictions", loc="left", fontsize=11)
    for i, s in enumerate(npz): axes[2].text(i, s + 3, f"{s}", ha="center", fontweight="bold")
    axes[2].set_ylim(0, max(npz) * 1.2)
    for ax in axes: ax.grid(axis="y", color=GRID); ax.set_axisbelow(True)
    fig.tight_layout(); fig.savefig(FIGURES / "model_comparison.png", dpi=200, facecolor="white"); plt.close(fig)

    # Figure: actual vs predicted
    fig, ax = plt.subplots(figsize=(6.6, 6.0))
    la, lp2 = np.log10(y_te.to_numpy()), np.log10(pred)
    hb = ax.hexbin(la, lp2, gridsize=70, bins="log", cmap="Blues", mincnt=1, extent=(5.3, 9.5, 5.3, 9.5))
    ax.plot([5.3, 9.5], [5.3, 9.5], color=WARN, lw=1.6, ls="--", label="perfect prediction")
    ax.set_xlim(5.3, 9.5); ax.set_ylim(5.3, 9.5)
    ticks = [6, 7, 8, 9]; lab = ["₱1M", "₱10M", "₱100M", "₱1B"]
    ax.set_xticks(ticks); ax.set_xticklabels(lab); ax.set_yticks(ticks); ax.set_yticklabels(lab)
    ax.set_xlabel("Actual asking price (log scale)"); ax.set_ylabel("Predicted price (log scale)")
    ax.set_title("Random Forest: predicted against actual, 45,288 test listings", fontsize=10.5, color=INK)
    fig.colorbar(hb, ax=ax, label="Listings per cell (log scale)", shrink=.85)
    ax.legend(frameon=False, loc="upper left"); ax.set_aspect("equal")
    fig.tight_layout(); fig.savefig(FIGURES / "actual_vs_predicted.png", dpi=200, facecolor="white"); plt.close(fig)

    # Figure: feature importance, both models
    PI = out["permutation_importance"]
    MODELS = [("RandomForestRegression", "Random Forest", ACCENT), ("XGBoostRegression", "XGBoost", WARN)]
    fig, (a, b) = plt.subplots(1, 2, figsize=(12.4, 5.0), gridspec_kw={"width_ratios": [1, 1.3]})
    gnames = list(GROUPS); yy = np.arange(len(gnames)); h = .36
    for k, (key, lab, col) in enumerate(MODELS):
        vals = [PI[key]["group"][g]["drop_r2"] for g in gnames]
        a.barh(yy + (k - .5) * h, vals, h, color=col, label=lab)
        for yv, s in zip(yy + (k - .5) * h, vals): a.text(s + .01, yv, f"{s:.2f}", va="center", fontsize=9)
    a.set_yticks(yy); a.set_yticklabels(gnames); a.invert_yaxis()
    a.set_xlabel("Drop in R² when the group is shuffled")
    a.set_xlim(0, max(PI[k]["group"][g]["drop_r2"] for k in PI for g in gnames) * 1.18)
    a.set_title("(a) By group", loc="left", fontsize=11); a.grid(axis="x", color=GRID); a.set_axisbelow(True)
    a.legend(frameon=False, loc="lower right", fontsize=9)
    order = sorted(FEATURES, key=lambda c: -PI["RandomForestRegression"]["feature"][c]["drop_r2"])
    yy = np.arange(len(order))
    for k, (key, lab, col) in enumerate(MODELS):
        vals = [PI[key]["feature"][c]["drop_r2"] for c in order]
        b.barh(yy + (k - .5) * h, vals, h, color=col, label=lab)
    b.set_yticks(yy); b.set_yticklabels(order); b.invert_yaxis()
    b.set_xlabel("Drop in R² when the feature is shuffled")
    b.set_title("(b) By feature", loc="left", fontsize=11); b.grid(axis="x", color=GRID); b.set_axisbelow(True)
    b.legend(frameon=False, loc="lower right", fontsize=9)
    fig.tight_layout(); fig.savefig(FIGURES / "feature_importance.png", dpi=200, facecolor="white"); plt.close(fig)

    # Figure: spatial generalisation
    is_d = data["city"] == "Davao City"
    fig, (a, b) = plt.subplots(1, 2, figsize=(12, 4.6), gridspec_kw={"width_ratios": [1.25, 1]})
    bins = np.linspace(5.3, 9.3, 70)
    a.hist(np.log10(data.loc[~is_d, "price_php"]), bins=bins, density=True, alpha=.55, color=ACCENT, label="All other cities")
    a.hist(np.log10(data.loc[is_d, "price_php"]), bins=bins, density=True, alpha=.65, color=WARN, label="Davao City (held out)")
    a.axvline(np.log10(data.loc[~is_d, "price_php"].median()), color=ACCENT, ls="--")
    a.axvline(np.log10(data.loc[is_d, "price_php"].median()), color=WARN, ls="--")
    a.set_xticks([6, 7, 8, 9]); a.set_xticklabels(["₱1M", "₱10M", "₱100M", "₱1B"])
    a.set_xlabel("Asking price (log scale)"); a.set_ylabel("Density")
    a.set_title("(a) Davao City prices sit lower than the rest of the country", loc="left", fontsize=10.5)
    a.legend(frameon=False)
    sp = local["spatial_holdout"]["metrics"]
    xs = np.arange(2)
    prim = [hx["RandomForestRegression"]["r2"], hx["XGBoostRegression"]["r2"]]
    spat = [sp["RandomForestRegression"]["r2"], sp["XGBoostRegression"]["r2"]]
    b.bar(xs - .19, prim, .38, color=ACCENT, label="Random split (primary)")
    b.bar(xs + .19, spat, .38, color=WARN, label="Davao City held out")
    b.axhline(0, color=INK, lw=1)
    b.set_xticks(xs); b.set_xticklabels(["Random Forest", "XGBoost"]); b.set_ylabel("R²")
    for i in range(2):
        b.text(i - .19, prim[i] + .02, f"{prim[i]:.3f}", ha="center", fontsize=9)
        b.text(i + .19, spat[i] - .07, f"{spat[i]:.3f}", ha="center", fontsize=9)
    b.set_ylim(-1.05, 1.1); b.legend(frameon=False, fontsize=8.5, loc="upper right", ncol=2)
    b.set_title("(b) R² collapses on an unseen city", loc="left", fontsize=10.5); b.grid(axis="y", color=GRID); b.set_axisbelow(True)
    fig.tight_layout(); fig.savefig(FIGURES / "spatial_generalisation.png", dpi=200, facecolor="white"); plt.close(fig)
    print("figures written")


if __name__ == "__main__":
    main()
