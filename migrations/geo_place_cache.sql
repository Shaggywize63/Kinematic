-- Server-side reverse-geocode cache: coordinate cell -> human place name.
--
-- The daily travel report used to carry only coordinates; each dashboard browser then reverse-geocoded every
-- point itself, in the viewer's own Google locale — so the SAME point got different (sometimes wrong, foreign)
-- names for different admins. The report now resolves each point ONCE on the server (English / India, see
-- services/placeNames.store.ts + crm/places.service.reverseGeocode) and ships the name in the payload. This
-- table caches those resolutions, keyed by a ~11 m cell (lat/lng rounded to 4 decimals, the same cell the
-- dashboard place-name cache uses), so a point is geocoded at most once ever instead of on every report view.
--
-- Apply to the KINEMATIC database only (the reported case, Bright Kid, is a Kinematic tenant). The resolver
-- degrades gracefully where the table is absent (it reverse-geocodes without persisting), so the Tata project
-- keeps working unchanged until the same additive table is added there.
--
-- Additive and idempotent.
create table if not exists geo_places (
  cell        text primary key,                 -- "22.6955,88.3937" — lat,lng to 4 decimals
  name        text not null,                     -- the resolved formatted address (English / India)
  lat         double precision,
  lng         double precision,
  resolved_at timestamptz not null default now()
);

-- Read by the service-role client only (which bypasses RLS). Enable RLS with no policy so the anon key,
-- if it ever reaches PostgREST, sees nothing — matching the DB-lockdown posture.
alter table geo_places enable row level security;

-- PostgREST caches the schema; make the new table visible without a service restart.
notify pgrst, 'reload schema';
