// LWH Fleet View — client config. Nothing secret lives here: the Samsara
// token and the PIN check are both inside the Supabase edge function.
window.FLEET_CONFIG = {
  FUNCTION_URL: 'https://tjivcqxnkftujceumdtx.supabase.co/functions/v1/fleet-live',
  // Google Maps JavaScript API key. It is visible to anyone who opens the app,
  // which is normal for Google Maps. Keep it restricted in Google Cloud:
  //   Website restriction: https://nbr1hawgfan.github.io/*
  //   API restriction:     Maps JavaScript API only
  GOOGLE_MAPS_KEY: 'AIzaSyBG4-2e1qwecM7IZ9idzCwP3nxw4SDBEvw',
  REFRESH_SECONDS: 30,
  // Map starts here before data loads (main yard)
  DEFAULT_CENTER: [35.35153, -94.42776],
  DEFAULT_ZOOM: 11,
  // A ping older than this shows as "old GPS".
  // Trucks report constantly; parked trailer gateways only every few hours.
  TRUCK_STALE_MINUTES: 120,
  TRAILER_STALE_MINUTES: 1440,
  // Tucked behind the "Inactive" button:
  //   trailers with no GPS for this many days
  DEAD_GPS_DAYS: 30,
  //   trucks with no GPS, or engine off, for this many days
  TRUCK_INACTIVE_DAYS: 60
};
