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
- Sites: Fresno St, 5th St (both addresses), 6th St, and Pernod Ricard
- Hidden: the 3 trailers from the Dwell Tracker + the Fleet Command vehicle exclusions

**Pernod Ricard IDs:** open the Dwell Tracker's Apps Script → Project Settings → Script
Properties → copy `PERNOD_GEOFENCE_IDS`, then run:
```sql
update fleet_sites set samsara_address_ids = array['ID1','ID2'] where name = 'Pernod Ricard';
```

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

### 4. GitHub Pages
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
| `config.js` | function URL, refresh rate (30s), stale-GPS cutoff (2 hr) |
| `sw.js` | offline app shell; bump `VERSION` on each release |
| `supabase/functions/fleet-live/index.ts` | the Samsara proxy |
| `supabase/migrations/…sql` | tables + seed data |

## Phase 2 ideas
Routed ETAs (OpenRouteService), per-person PINs, share Load Status with the Pernod Dwell Tracker,
trailer dwell timers ("at Pernod 3 days").
