# LWH Fleet View — v1.0

Live map and "who's headed my way" list of trucks, drivers and trailers for LWH managers.
GitHub Pages PWA + one Supabase Edge Function (`fleet-live`) in the **LWH Companion** project.

```
Phone / PC (PWA on GitHub Pages)
   │  POST + team PIN
   ▼
Supabase Edge Function: fleet-live  ── holds SAMSARA_API_TOKEN (secret)
   │  pulls every 20s at most, shared by all users
   ├─ Samsara: vehicle locations, driver assignments, trailer GPS, address geofences
   └─ Supabase tables: fleet_sites, fleet_hidden, fleet_trailer_load(+_log)
```

The Samsara token is **never** in this repo or the browser.

---

## Setup (one time, ~15 min)

### 1. Database tables
Supabase Dashboard → LWH Companion → SQL Editor → paste and run
`supabase/migrations/20261011_fleet_view.sql`.

It creates the tables and seeds:
- Sites: Fresno St, 5th St (both addresses), 6th St, and Pernod Ricard (both sides)
- Hidden: the 3 trailers from the Dwell Tracker + the Fleet Command vehicle exclusions

### 2. Secrets
Dashboard → Edge Functions → Secrets → add:

| Name | Value |
|---|---|
| `SAMSARA_API_TOKEN` | the new Samsara key |
| `FLEET_PIN` | team PIN — use **6+ digits** |

The Samsara key needs read access to vehicles, trailers, drivers/assignments, and addresses.

### 3. Deploy the function
Either CLI:
```
supabase functions deploy fleet-live --no-verify-jwt --project-ref tjivcqxnkftujceumdtx
```
or Dashboard → Edge Functions → Deploy a new function → name it `fleet-live` → paste
`supabase/functions/fleet-live/index.ts` → **turn OFF "Verify JWT"** → Deploy.

### 4. Google Maps key
Google Cloud Console → APIs & Services → Credentials → your key → **Edit**:
- **Application restrictions:** Websites → add `https://nbr1hawgfan.github.io/*`
- **API restrictions:** Restrict key → **Maps JavaScript API** only
- Make sure **Maps JavaScript API** is enabled (APIs & Services → Library) and the project has a billing account.
- Recommended: Maps JavaScript API → Quotas → cap **map loads per day** around 300, and add a $5 budget alert under Billing.

Then paste the key into `config.js` → `GOOGLE_MAPS_KEY`.

Cost: Google bills per map *load* (each time the app is opened), with 10,000 free per month.
4 managers × 10 opens/day ≈ 1,200/month → **$0**. The 30-second refresh moves markers; it is not a new load.

### 5. GitHub Pages
Create repo `LWH-Fleet-View`, upload everything **except** the `supabase/` folder
(it's fine to include, nothing secret in it). Settings → Pages → Deploy from branch → `main` / root.
App URL: `https://nbr1hawgfan.github.io/LWH-Fleet-View/`

On phones: open the URL → Share → **Add to Home Screen**.

---

## Day-to-day

- **Hide a trailer/truck:** `insert into fleet_hidden (asset_type, match_type, value, note) values ('trailer','id','<samsara id>','why');`
- **Add a site:** `insert into fleet_sites (name, samsara_address_ids, is_home, sort_order) values ('New Dock', array['<address id>'], true, 40);`
- Changes show within 10 minutes (config cache). Redeploying the function applies them immediately.
- **Change the PIN:** update the `FLEET_PIN` secret. Everyone gets sent back to sign-in.
- **Who set a trailer empty/loaded:** `select * from fleet_trailer_load_log order by updated_at desc;`

## Using it
- **Phone:** the map fills the screen. Drag the panel at the bottom up for the list, or tap its handle. Tap any row to fly to it.
- **PC:** the list sits in a panel on the left of the map.
- **Tap a truck** to see its last 8 hours as a blue route, with each stop of 5+ minutes labeled with how long it sat. Tap the map to clear it.
- Moving trucks glide between updates and show their speed on the badge: amber at 60+, red at 70+.
- A trailer that's being pulled rides inside its truck's badge instead of getting its own marker.
- Round buttons on the right: satellite view, back to my site, show everything.

## How the "smart" parts work

- **At a site:** GPS point inside the Samsara geofence (polygon or circle), same math as the Dwell Tracker.
- **Headed your way / ETA:** moving, and heading within 50° of the bearing to your site.
  ETA = straight-line miles × 1.25 ÷ speed (25 mph inside 3 mi, 35–60 mph otherwise). Rough by design.
- **Likely pulling:** trailer and truck both moving, within 0.3 mi (plus slack for an older trailer
  ping) with headings within 60°; or both parked within ~175 yards *off-site*. Never guessed inside
  a yard. Always labeled "likely."
- **Empty / Loaded:** set by tapping in the app. Tap the lit button again to clear. Shows who and when.

## Files
| File | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | the PWA |
| `config.js` | function URL, Google Maps key, refresh rate (30s), stale-GPS cutoffs (trucks 2 hr, trailers 24 hr), dead-GPS days (30) |
| `sw.js` | offline app shell; bump `VERSION` on each release |
| `supabase/functions/fleet-live/index.ts` | the Samsara proxy |
| `supabase/migrations/…sql` | tables + seed data |

## Phase 2 ideas
Routed ETAs (OpenRouteService), per-person PINs, share Load Status with the Pernod Dwell Tracker,
trailer dwell timers ("at Pernod 3 days"), grouping crowded yards into one count bubble when zoomed out.
