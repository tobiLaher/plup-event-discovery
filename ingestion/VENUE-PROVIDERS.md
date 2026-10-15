# Venue lookup providers (researched 2026-10-14)

Facts below come from each provider's own pages or search summaries of them; terms change, so **re-read the live terms before relying on any row**. Nothing here has been signed up for or paid for.

| Option | Cost | Storing results | Attribution | Fit for unattended production |
|---|---|---|---|---|
| [Nominatim public API](https://operations.osmfoundation.org/policies/nominatim/) | Free | Cache required; repeated identical queries get blocked | OpenStreetMap (ODbL) | **No.** Max 1 req/s per app; scheduled/background use is "bulk" (4 req/min, discouraged); access can be withdrawn. Fine for a few development lookups only. |
| Geoapify (hosted, OSM/OpenAddresses/GeoNames based) | Free plan 3,000 credits/day, ~5 req/s; paid above | Its FAQ says storing is allowed if attribution is kept | "Powered by Geoapify" link + data-source credits | **Best fit** as the primary place search. Confirm terms and Philippines coverage before committing. |
| LocationIQ (OSM based) | Free 5,000/day, 2 req/s | Free tier: cache request/response only ~48 h | Link back | Poor for a permanent registry on the free tier. |
| [Google Places](https://cloud.google.com/maps-platform/terms/maps-service-terms) | Paid (per request) | `place_id` may be cached; lat/lng only 30 days | Google attribution | Accurate, but its terms conflict with a permanent canonical registry. Needs approval. |
| [Mapbox geocoding](https://www.mapbox.com/geocoding) | Temporary: 100k/month free; Permanent: paid only | Temporary results cannot be stored | Mapbox attribution | Storing results needs the paid Permanent tier. |
| [Foursquare Places API](https://foursquare.com/resources/blog/news/heads-up-developers-with-fsq-places-api-you-can-now-pay-as-you-go/) | Small free allowance, then paid | Official caching terms not confirmed | Foursquare | Unclear; skip for now. |
| [Overture Maps Places](https://docs.overturemaps.org/) (open dataset, downloadable) | Free | Dataset is licensed for reuse (CDLA Permissive 2.0; Foursquare-sourced rows Apache-2.0) | Per-source credit | Good **second, independent dataset** with no rate limits (bulk file, query locally). Philippines coverage not yet checked. |

## Recommendation

- **Primary lookup:** Geoapify, behind the `VenueSearchProvider` interface (OSM-derived dataset).
- **Independent second source:** a locally queried Overture Maps Places extract for Metro Manila (a different dataset from OSM). Two datasets from different origins is what the verifier requires.
- **Never** make the public Nominatim endpoint a production dependency. It ships here only as a development adapter, marked `productionSafe: false` and skipped when the resolver runs in `production`.
- Cache everything verified in our own registry so each venue is looked up once.

## Why two OSM-based providers are not "independent"

Nominatim, Geoapify and LocationIQ all derive largely from OpenStreetMap. Evidence carries a `dataset` label and the verifier counts distinct datasets, so two OSM-derived answers count as one.
