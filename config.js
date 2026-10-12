// LWH Fleet View — client config. Nothing secret lives here: the Samsara
// token and the PIN check are both inside the Supabase edge function.
window.FLEET_CONFIG = {
  FUNCTION_URL: 'https://tjivcqxnkftujceumdtx.supabase.co/functions/v1/fleet-live',
  REFRESH_SECONDS: 30,
  // Map starts here before data loads (main yard)
  DEFAULT_CENTER: [35.35153, -94.42776],
  DEFAULT_ZOOM: 11,
  // A ping older than this shows as "old GPS"
  STALE_MINUTES: 120
};
