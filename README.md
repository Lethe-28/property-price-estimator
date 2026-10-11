# Property Price Estimator

A web application for Philippine property listings. It imports a CSV or Excel file, stores the rows in a SQLite database, estimates each listing's price with a Random Forest, and produces charts and written insights. It also prices a single property from a form.

Final project for IT20L, University of Mindanao. Authors: Mar Lourenz Peligrino and Nemuel Cabatu.

**Live app: https://lethe-28.github.io/property-price-estimator/**

Everything runs in the browser. There is no server and no account, and nothing you import leaves your computer.

## What it does

| Tab | What you can do |
|---|---|
| **Estimate** | Describe one property (location, type, size) and get an estimated asking price, a likely range, and four interactive charts that update as you type. |
| **Explore the model** | See how the model performed on 45,288 listings it never saw: accuracy by property type, what drives price, Random Forest versus XGBoost, and how it fails on unseen cities. |
| **My data** | **Import a CSV or Excel file**, which is stored in a **SQLite database**. The tab then shows **visualizations and insights** built from the database with SQL. |
| **About and limits** | Plain-language description of the data, the model and its limits. |

### The My data tab (import, database, insights)

1. **Import.** Choose a `.csv`, `.xlsx` or `.xls` file, or drop it on the card. Try `sample/sample_listings.csv` (1,600 real listings) or `sample/sample_listings.xlsx` (250). Required columns are `property_type` (house, condo, lot or commercial) and `price_php`. Optional: `sqm`, `lot_area_m2`, `bedrooms`, `bathrooms`, `city`, `province`, `region`, `lat`, `lng`. Common alternative headers (`price`, `floor_area`, `beds`, `latitude`, ...) and text such as `₱5,500,000` or `45 sqm` are understood. Rows without a usable price or type are rejected, and the reason is shown.
2. **Store.** Valid rows go into SQLite (via [sql.js](https://github.com/sql-js/sql.js), SQLite compiled to WebAssembly). The database file is kept in the browser's IndexedDB, so it is still there on the next visit. "Download database" exports a normal `.sqlite` file, and "Clear stored data" empties it. Each row also gets the Random Forest's estimate, stored beside the asking price.
3. **Insights.** Queries over the database produce headline numbers, six written insights (priciest and cheapest region, how asking prices compare with the model, where they disagree most, listings priced far from the estimate, data-quality warnings), four charts, and two "worth a second look" tables.

## Database

The setup file is [`database/schema.sql`](database/schema.sql). It defines:

- `imports`: one row per imported file (name, time, rows read, stored, rejected).
- `listings`: one row per accepted listing (type, price, size, location, coordinates, a flag for whether the city is in the model's training data, and the model's estimate), with `CHECK` constraints and indexes.
- `listing_gap`: a view giving each listing's asking price against the model's estimate.

The app runs this file whenever it opens the database, so no manual setup is needed. To use it elsewhere: `sqlite3 listings.db < database/schema.sql`.

## Run it locally

No installation, no build step. The app is static files.

```
git clone https://github.com/Lethe-28/property-price-estimator.git
cd property-price-estimator
python -m http.server 8000
```

Then open <http://localhost:8000>. Any static file server works. The **My data** tab needs the page served over `http(s)` because SQLite's WebAssembly file is fetched; the Estimate and Explore tabs also work by double-clicking `index.html`.

The first load downloads about 77 MB of model data (the 300 trees), so allow a few seconds on a slow connection.

## Dependencies

The web app has none to install. Third-party libraries are vendored in `vendor/` with their licences:

| Library | Version | Used for |
|---|---|---|
| [Plotly.js (cartesian bundle)](https://plotly.com/javascript/) | 2.35.2 | charts |
| [sql.js](https://github.com/sql-js/sql.js) | 1.12.0 | SQLite in the browser |
| [SheetJS (mini build)](https://sheetjs.com/) | 0.18.5 | reading CSV and Excel |

The training code in `training/` needs Python and the packages in `training/requirements.txt`. Browser tests need Node.js 18 or later and Chrome or Edge.

## The model

A scikit-learn Random Forest (300 trees, depth 20) trained on 241,496 Philippine asking prices. `training/scripts/export_web_app.py` exports the fitted trees to `data/forest.js`, and `assets/model.js` walks them in JavaScript. It reproduces scikit-learn's predictions to within 1.3e-8 (relative) on 5,000 test rows.

| Measure (held-out test set) | Value |
|---|---|
| R² | 0.64 |
| Typical error (median) | about 27% of the asking price |
| Estimates within 50% of the price | about 67% |

See the **About and limits** tab for the limits that matter: asking prices are not sale prices, accuracy drops sharply in cities absent from the training data, and lots and commercial properties are much harder to price than houses and condos.

## Repository layout

```
index.html, assets/        the application (HTML, CSS, JavaScript)
data/                      exported model (forest.js), lookup tables, results used by the charts
vendor/                    Plotly, sql.js, SheetJS (with licences)
database/schema.sql        database setup
sample/                    sample CSV and Excel files
training/                  how the model was built and exported
  notebook/                training and evaluation notebook
  scripts/                 export_web_app.py and analysis scripts
  results/                 metrics.json, analysis.json (the numbers the app displays)
  tests/web/               model-parity and browser tests
  requirements.txt
```

## Rebuilding the model (optional)

The trained model is already exported to `data/`. To retrain, download `listings.csv` from the [dataset](https://huggingface.co/datasets/covaga/Philippines-Real-Estate-Asking-Prices) into `training/data/`, then:

```
cd training
pip install -r requirements.txt
jupyter nbconvert --to notebook --execute notebook/price_prediction_pipeline.ipynb   # rewrites results/metrics.json, writes artifacts/price_pipeline.joblib
python -B scripts/export_web_app.py --out ..                                         # rewrites ../data/*.js
```

## Tests

From `training/`:

```
node tests/web/parity_test.mjs --app ..    # JavaScript model vs. scikit-learn on 5,000 rows
node tests/web/app_gate.mjs --app ..       # Estimate tab in headless Chrome
```

## Data and licence

Listing data: Christian (covaga.xyz), *Philippines Real Estate Asking Prices*, Hugging Face, snapshot 2026-08-30, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The sample files are random excerpts of it. Vendored libraries keep their own licences (see `vendor/`).
