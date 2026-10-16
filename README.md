# LWH Fleet View — v1.11

Live map and list of trucks, drivers and trailers for LWH managers.
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
- Sites: Fresno St, 5th St (both addresses), 6th St, Pernod Ricard (both sides); v2 adds Truck Yard, Zero St, Van Buren, Ball Rd
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
- **Add a site from Samsara:** `insert into fleet_sites (name, samsara_address_ids, is_home, sort_order) values ('New Dock', array['<address id>'], true, 40);`
- **Add a site as a circle** (no Samsara address needed): `insert into fleet_sites (name, is_home, sort_order, center_lat, center_lng, radius_m) values ('Henryetta', false, 60, 35.449, -95.972, 300);`
- **Find a Samsara address ID:** `select id, name, formatted_address from fleet_address_book where formatted_address ilike '%zero%';`
- **Rename a site:** `update fleet_sites set name = 'Main Yard' where name = 'Truck Yard';`
- Changes show within 10 minutes (config cache). Redeploying the function applies them immediately.
- **Change the PIN:** update the `FLEET_PIN` secret. Everyone gets sent back to sign-in.
- **Who set a trailer empty/loaded:** `select * from fleet_trailer_load_log order by updated_at desc;`

## Using it
- **Phone:** the map fills the screen. At rest the bottom panel is one line ("2 trucks, 4 trailers at Truck Yard · 3 driving · 1 low fuel").
  Tap it or drag it up for the list, the "I'm at" picker and the Filters button.
- **Search** like Google Maps: type a truck number, trailer number or driver name and pick a match.
  The app then focuses on it: flies there, fades everything else, follows it as it moves, draws its route,
  and shows its details (status, distance, fuel, MPG, engine, trailer, last GPS). Tapping a row in the list does the same.
  Clear the search or tap the X on the card to go back to everything. Drag the map and it stops following; tap **Follow** to resume.
- **PC:** the map gets the whole screen. The list panel is closed until you tap the list button in the search bar
  (or the one-line summary under it); each computer remembers open or closed. Searching or tapping a truck still opens its card.
- **List:** one line per truck or trailer (name, driver or Empty/Loaded, Driving + mph / Parked / distance). Fuel only shows when low.
  Tap a row for the full card (fuel, MPG, engine, route, Empty/Loaded buttons). "At <site>" starts collapsed; tap a section header to open or close it.
- **Both / Trucks / Trailers** switch sits on the map (next to the search bar on PC, under it on phones) and is remembered per device.
  Searching something it hides switches to Both until you close that card.
- **Filters** button holds Low fuel / Empty only / Inactive / No-GPS trailers; it shows a count when anything is changed.
- **Tap a truck** to see its last 8 hours as a blue route, with each stop of 5+ minutes labeled with how long it sat. Tap the map to clear it.
- **Fuel:** every truck shows its fuel level from Samsara, with a 7-day MPG figure when it has driven 25+ miles that week.
  Amber under 25%, red under 15%. Low trucks get a fuel tag on their map badge, and the **Low fuel** button lists just those trucks.
  MPG comes from Samsara's fuel & energy report (engine-computer fuel burned), refreshed every 6 hours.
- **Inactive** button: trucks with no GPS or engine off for 60+ days, and trailers with no GPS for 30+ days, are hidden until you tap it.
  Parked trucks show how long they've sat ("Parked since Fri 5:42 PM").
- Moving trucks glide between updates and show their speed on the badge: amber at 60+, red at 70+.
- A trailer that's being pulled rides inside its truck's badge instead of getting its own marker.
- Round buttons on the right: satellite view, back to my site, show everything.
- **Hover (PC):** point at a truck to see its driver, speed and fuel without clicking.
- **Street View:** button in every truck/trailer popup. Opens Google's nearest street photo, facing the truck or trailer.
  Photos can be months or years old and only cover public roads. Billing: 5,000 free views a month, then $14 per 1,000.
- **Crowded spots group up** when zoomed out: one bubble per yard or lot, like "Truck Yard: 9 trucks, 7 trailers"
  (or the street name for unlisted lots, like "8201 Chad Colley Boulevard"). Tap to zoom in. For a single packed lot,
  tapping lists everything there; tap a name to fly to it. Moving trucks are never grouped.

## Yard checks (v1.9)
Same data as the Driver Toolkit's Yard Check and Dispatch Board — table `yard_checks`, bucket `yard-photos`,
and the `yard-check-history`, `yard-check-submit`, `yard-photo-upload`, `yard-photo-urls` functions (all already
deployed in LWH Companion; see the Driver Toolkit repo's `supabase/README.md`). Nothing new to deploy.

- Open it from the clipboard button on the map or the menu (Yard checks).
- **Yards:** each yard's latest check, newest first: who checked it and when (Driver Toolkit or Fleet View),
  Loaded / Empty / Damaged counts, days on yard, damage photos, and a GPS column for every trailer:
  green when Samsara can see it now, red **Not in Samsara** (no gateway, new trailer) or **GPS 3 days old**
  (gateway quiet since before the check). Tap a green trailer number to jump to it on the map.
  **Check this yard again** copies the trailer list into a new check with statuses cleared.
- **Find a trailer:** every yard check that listed it (including older ones from the server), plus where Samsara last saw it.
- **New check:** managers on site log trailers the same way drivers do: yard, optional GPS pin, Loaded / Empty,
  note, Damaged (needs a photo). Saved with `how = "Fleet View"` and the signed-in name, so it shows on the
  toolkit's Dispatch Board too. Photos stay in memory until saved, so keep the screen open if a save fails.
- **On the map:** trailers from the last 14 days of yard checks that Samsara can't place show at the yard as a
  dashed "no GPS" tag (needs the check's GPS pin, or a yard name that matches a site). Toggle with the
  **No-GPS trailers** filter. Searching a number Samsara doesn't know offers the yard check result.
- Trailer focus cards show the latest yard check sighting and an **Add to yard check** button.
- Yard check Loaded/Empty is separate from the map's Empty/Loaded buttons; both show on the trailer card.
- Matching yard check numbers to Samsara: exact name, or the same trailing number when only one Samsara trailer has it.
- Settings in `config.js`: `YARD_RECENT_DAYS`, `YARD_LIST_DAYS`, `YARD_REFRESH_SECONDS`.

## How the "smart" parts work

- **At a site:** GPS point inside the Samsara geofence (polygon or circle), same math as the Dwell Tracker.
- **Likely pulling:** trailer and truck both moving, within 0.3 mi (plus slack for an older trailer
  ping) with headings within 60°; or both parked within ~175 yards *off-site*. Never guessed inside
  a yard. Always labeled "likely."
- **Empty / Loaded:** set by tapping in the app. Tap the lit button again to clear. Shows who and when.

## Files
| File | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | the PWA |
| `yard.js` | yard checks panel, no-GPS map tags, trailer card lines |
| `config.js` | function URL, Google Maps key, refresh rate (30s), stale-GPS cutoffs (trucks 2 hr, trailers 24 hr), inactive cutoffs (trailers 30 days, trucks 60 days) |
| `sw.js` | offline app shell; bump `VERSION` on each release |
| `supabase/functions/fleet-live/index.ts` | the Samsara proxy |
| `supabase/migrations/…sql` | tables + seed data (v1 and v2, both already applied) |

## Phase 2 ideas
Per-person PINs, share Load Status with the Pernod Dwell Tracker,
trailer dwell timers ("at Pernod 3 days").
