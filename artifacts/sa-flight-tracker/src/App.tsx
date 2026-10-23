import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import L from 'leaflet';
import {
  Activity, AlertTriangle, ArrowUpRight, Compass, Crosshair, Info, MapPin,
  Navigation, Plane, Radio, Search, ShieldCheck, Signal, X
} from 'lucide-react';
import { Link, Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  MapContainer, Marker, Popup, TileLayer, Tooltip, ZoomControl, useMap
} from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import 'leaflet/dist/leaflet.css';
import 'react-leaflet-cluster/dist/assets/MarkerCluster.css';
import 'react-leaflet-cluster/dist/assets/MarkerCluster.Default.css';
import {
  useGetAirports, useGetAirportRoutes, useGetFlights, useGetFlightSummary,
  useHealthCheck
} from '@workspace/api-client-react';
import type { Airport, AirportRoute, Flight } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';
import { AuthProvider, useAuth } from '@/auth';
import {
  DashboardPage, ItineraryPage, NewBookingPage, PrivacyDeskPage, PublicPrivacyRequestPage,
  SignInPage, VerifyPrivacyPage, WorkspaceShell
} from '@/agency';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } }
});

const usePolling = { refetchInterval: 30_000, refetchIntervalInBackground: true };
const SOUTHERN_AFRICA_BOUNDS = L.latLngBounds([-38, 12], [-18, 38]);

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = (v: number) => (v * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatAltitude(meters: number | null) {
  if (meters == null || !Number.isFinite(meters)) return '—';
  return `${Math.round(meters * 3.28084).toLocaleString()} ft`;
}

function formatSpeed(mps: number | null) {
  if (mps == null) return '—';
  return `${Math.round(mps * 1.94384)} kt`;
}

function formatTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' });
}

function PageHead({ eyebrow, title, subtitle, right }: { eyebrow: string; title: string; subtitle: string; right?: ReactNode }) {
  return <div className="page-head"><div><div className="eyebrow">{eyebrow}</div><h1 className="page-title">{title}</h1><p className="page-subtitle">{subtitle}</p></div>{right && <div className="headline-side">{right}</div>}</div>;
}

function Notice({ error = false, children }: { error?: boolean; children: ReactNode }) {
  return <div className={`notice ${error ? 'error' : ''}`} data-testid={error ? 'status-connection-warning' : 'status-data-warning'}><AlertTriangle size={15} /> <span>{children}</span></div>;
}

function LoadingRows({ count = 7 }: { count?: number }) {
  return <div aria-label="Loading flights" data-testid="loading-flight-skeleton">{Array.from({ length: count }, (_, i) => <div key={i} style={{ padding: '13px 15px', borderBottom: '1px solid #263640' }}><div className="skeleton" style={{ width: i % 2 ? '34%' : '42%', height: 11 }} /><div className="skeleton" style={{ width: '69%', height: 8, marginTop: 9 }} /></div>)}</div>;
}

function SummaryStrip({ summary, flights }: { summary?: { totalFlights: number; airborne: number; onGround: number; fetchedAt: string | null; stale: boolean }; flights?: Flight[] }) {
  const airborne = summary?.airborne ?? flights?.filter((f) => !f.onGround).length ?? 0;
  const ground = summary?.onGround ?? flights?.filter((f) => f.onGround).length ?? 0;
  const total = summary?.totalFlights ?? flights?.length ?? 0;
  const highAltitude = flights?.filter((f) => !f.onGround && (f.baroAltitude ?? 0) > 9000).length ?? 0;
  return <section className="summary-strip" aria-label="Airspace summary" data-testid="summary-airspace">
    <div className="summary-cell"><div className="summary-label"><Radio size={12} /> TRACKED TARGETS</div><div className="summary-value">{total.toLocaleString()}<span className="summary-caption">within coverage</span></div></div>
    <div className="summary-cell"><div className="summary-label"><Plane size={12} /> AIRBORNE</div><div className="summary-value cyan">{airborne.toLocaleString()}<span className="summary-caption">in the air</span></div></div>
    <div className="summary-cell"><div className="summary-label"><MapPin size={12} /> ON GROUND</div><div className="summary-value">{ground.toLocaleString()}<span className="summary-caption">surface reports</span></div></div>
    <div className="summary-cell"><div className="summary-label"><ArrowUpRight size={12} /> ABOVE 30,000 FT</div><div className="summary-value amber">{highAltitude.toLocaleString()}<span className="summary-caption">altitude advisory</span></div></div>
  </section>;
}

function getAltitudeColor(flight: Flight) {
  if (flight.onGround) return '#f1bb64';
  const altitude = flight.baroAltitude ?? 0;
  return altitude > 9000 ? '#efae57' : altitude > 4500 ? '#69d4ee' : '#77d9b4';
}

function aircraftLeafletIcon(flight: Flight, focused: boolean) {
  const color = getAltitudeColor(flight);
  const angle = Math.round(flight.trueTrack ?? 0);
  return L.divIcon({
    className: `aircraft-leaflet-icon${focused ? ' focused' : ''}`,
    html: `<span class="aircraft-glyph" style="color:${color};transform:rotate(${angle}deg)"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5L21 16z"/></svg></span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function AirportMarker({ airport }: { airport: Airport }) {
  const icon = useMemo(() => L.divIcon({
    className: 'airport-leaflet-icon',
    html: '<span class="airport-marker"></span>',
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  }), []);
  const showLabel = ['JNB', 'CPT', 'DUR', 'PLZ', 'ELS', 'GRJ'].includes(airport.iataCode || '');
  return <Marker position={[airport.latitude, airport.longitude]} icon={icon}>
    <Popup>
      <div className="map-popup">
        <strong>{airport.iataCode || airport.icaoCode || 'AIRPORT'}</strong>
        <span>{airport.name}</span>
        <small>{airport.city || airport.country}</small>
      </div>
    </Popup>
    {showLabel && <Tooltip direction="right" offset={[7, 0]} permanent>{airport.iataCode}</Tooltip>}
  </Marker>;
}

function AircraftMarker({ flight, focused, onClick }: { flight: Flight; focused: boolean; onClick: () => void }) {
  if (flight.latitude == null || flight.longitude == null) return null;
  const label = flight.callsign?.trim() || flight.icao24;
  return <Marker
    position={[flight.latitude, flight.longitude]}
    icon={aircraftLeafletIcon(flight, focused)}
    title={`${label} · ${formatAltitude(flight.baroAltitude)}`}
    eventHandlers={{ click: onClick }}
    keyboard
  >
    <Popup>
      <div className="map-popup">
        <strong>{label}</strong>
        <span>{flight.airlineName || flight.originCountry || 'Aircraft identity unverified'}</span>
        <small>{formatAltitude(flight.baroAltitude)} · {formatSpeed(flight.velocity)} · {flight.originCountry || 'Origin unknown'}</small>
      </div>
    </Popup>
  </Marker>;
}

function MapController({ selectedFlight, recenterKey }: { selectedFlight: Flight | null; recenterKey: number }) {
  const map = useMap();
  useEffect(() => {
    if (selectedFlight?.latitude != null && selectedFlight.longitude != null) {
      map.flyTo(
        [selectedFlight.latitude, selectedFlight.longitude],
        Math.max(map.getZoom(), 7),
        { duration: 0.8 },
      );
    }
  }, [map, selectedFlight?.icao24, selectedFlight?.latitude, selectedFlight?.longitude]);
  useEffect(() => {
    if (recenterKey > 0) map.flyTo([-30, 24], 5, { duration: 0.8 });
  }, [map, recenterKey]);
  useEffect(() => {
    const timer = window.setTimeout(() => map.invalidateSize(), 120);
    return () => window.clearTimeout(timer);
  }, [map]);
  return null;
}

function MapView({ flights, airports, selectedFlight, setSelectedFlight }: { flights: Flight[]; airports?: Airport[]; selectedFlight: Flight | null; setSelectedFlight: (flight: Flight | null) => void }) {
  const [recenterKey, setRecenterKey] = useState(0);
  const visibleAirports = airports?.filter((airport) => SOUTHERN_AFRICA_BOUNDS.contains([airport.latitude, airport.longitude])) ?? [];
  return <section className="map-panel" aria-label="Live aircraft map" data-testid="map-flight-view">
    <div className="map-toolbar">
      <div className="map-title-group"><Compass size={15} color="#61d2ed" /><span className="map-title">LIVE AIRSPACE</span><span className="map-area-label">Southern Africa · 12°–38°E</span></div>
      <div className="map-tools"><span className="pill">ALTITUDE / FL</span><button className="map-tool" aria-label="Re-centre map" title="Re-centre map" onClick={() => { setSelectedFlight(null); setRecenterKey((value) => value + 1); }} data-testid="button-map-center"><Crosshair size={14} /></button></div>
    </div>
    <div className="map-canvas" data-testid="map-canvas">
      <MapContainer
        center={[-30, 24]}
        zoom={5}
        minZoom={4}
        maxZoom={12}
        maxBounds={SOUTHERN_AFRICA_BOUNDS.pad(0.35)}
        maxBoundsViscosity={0.65}
        scrollWheelZoom
        zoomControl={false}
        className="flight-leaflet-map"
      >
        <MapController selectedFlight={selectedFlight} recenterKey={recenterKey} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ZoomControl position="bottomright" />
        {visibleAirports.map((airport) => <AirportMarker key={airport.airportId} airport={airport} />)}
        <MarkerClusterGroup chunkedLoading maxClusterRadius={42} showCoverageOnHover={false}>
          {flights.map((flight) => <AircraftMarker key={flight.icao24} flight={flight} focused={selectedFlight?.icao24 === flight.icao24} onClick={() => setSelectedFlight(flight)} />)}
        </MarkerClusterGroup>
      </MapContainer>
      <div className="map-grid" aria-hidden="true" />
      {selectedFlight && <div className="selected-card" data-testid="card-selected-flight">
        <div className="selected-card-head"><div><div className="selected-card-code">{selectedFlight.callsign?.trim() || selectedFlight.icao24}</div><div className="selected-card-name">{selectedFlight.airlineName || selectedFlight.originCountry || 'Aircraft · identity unverified'}</div></div><button className="selected-close" onClick={() => setSelectedFlight(null)} aria-label="Close selected flight" data-testid="button-close-flight"><X size={14} /></button></div>
        <div className="selected-stats">
          <div className="selected-stat"><label>Altitude</label><strong style={{ color: (selectedFlight.baroAltitude ?? 0) > 9000 ? '#efb85e' : undefined }}>{formatAltitude(selectedFlight.baroAltitude)}</strong></div>
          <div className="selected-stat"><label>Speed</label><strong>{formatSpeed(selectedFlight.velocity)}</strong></div>
          <div className="selected-stat"><label>Track</label><strong>{selectedFlight.trueTrack == null ? '—' : `${Math.round(selectedFlight.trueTrack)}°`}</strong></div>
          <div className="selected-stat"><label>Squawk</label><strong>{selectedFlight.squawk || '—'}</strong></div>
        </div>
      </div>}
      <div className="map-north">N<span>↑</span></div>
      <div className="map-legend"><span className="legend-item"><i className="legend-dot" /> AIRBORNE</span><span className="legend-item"><i className="legend-dot amber" /> GROUND / HIGH</span></div>
    </div>
    <div className="bottom-strip"><span className="source-note"><Signal size={12} /><span>OpenSky Network · API polled every 30 sec · upstream cache 5 min</span></span><span className="mono">SOUTH AFRICA FIR</span></div>
  </section>;
}

function FlightExplorer({ flights, loading, error, stale, selectedFlight, setSelectedFlight }: { flights: Flight[]; loading: boolean; error: boolean; stale: boolean; selectedFlight: Flight | null; setSelectedFlight: (flight: Flight | null) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'airborne' | 'ground'>('all');
  const filtered = useMemo(() => flights.filter((flight) => {
    const text = `${flight.callsign ?? ''} ${flight.icao24} ${flight.airlineName ?? ''} ${flight.originCountry ?? ''}`.toLowerCase();
    return text.includes(query.toLowerCase()) && (filter === 'all' || (filter === 'airborne' ? !flight.onGround : flight.onGround));
  }).sort((a, b) => (a.callsign || a.icao24).localeCompare(b.callsign || b.icao24)), [flights, query, filter]);
  return <section className="flight-panel" aria-label="Flight explorer" data-testid="flight-explorer">
    <div className="panel-head">
      <div className="panel-title-row"><h2 className="panel-title">Aircraft in range</h2><span className="result-count">{filtered.length} TARGETS</span></div>
      <label className="search-wrap"><Search size={14} /><input className="search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Callsign, hex or airline" aria-label="Search flights" data-testid="input-flight-search" /></label>
      <div className="filter-row" role="group" aria-label="Filter flights">
        {(['all', 'airborne', 'ground'] as const).map((value) => <button key={value} className={`filter-button ${filter === value ? 'selected' : ''}`} onClick={() => setFilter(value)} aria-pressed={filter === value} data-testid={`filter-flights-${value}`}>{value === 'all' ? 'All aircraft' : value === 'airborne' ? 'In air' : 'On ground'}</button>)}
      </div>
    </div>
    <div className="flight-list">
      {loading && <LoadingRows />}
      {!loading && error && <div className="empty-state" data-testid="empty-flights-error"><div className="empty-icon"><Signal size={19} /></div><strong>Flight feed unavailable</strong><p>We could not load position reports. The feed will retry automatically.</p></div>}
      {!loading && !error && filtered.length === 0 && <div className="empty-state" data-testid="empty-flights"><div className="empty-icon"><Plane size={19} /></div><strong>{flights.length ? 'No matching aircraft' : 'Airspace is quiet'}</strong><p>{flights.length ? 'Try another callsign or clear the current filters.' : 'No aircraft positions are available in the current coverage area.'}</p></div>}
      {!loading && !error && filtered.map((flight) => {
        const altitude = flight.baroAltitude;
        const warn = altitude != null && altitude > 9000;
        return <button className={`flight-row ${selectedFlight?.icao24 === flight.icao24 ? 'selected' : ''}`} key={flight.icao24} onClick={() => setSelectedFlight(flight)} data-testid={`row-flight-${flight.icao24}`}>
          <div className="flight-row-top"><div><div className="callsign">{flight.callsign?.trim() || flight.icao24}</div><div className="airline">{flight.airlineName || flight.originCountry || 'Aircraft identity not available'}</div></div><span className={`status-tag ${flight.onGround ? 'ground' : ''}`}>{flight.onGround ? 'GROUND' : 'AIRBORNE'}</span></div>
          <div className="flight-row-bottom" style={{ marginTop: 10 }}><span className={`flight-meta flight-altitude ${warn ? 'warn' : ''}`}><span>{formatAltitude(altitude)}</span><span>{formatSpeed(flight.velocity)}</span></span><span className="flight-meta">{flight.trueTrack == null ? '—' : `${Math.round(flight.trueTrack)}°`} <Navigation size={11} /></span></div>
        </button>;
      })}
    </div>
    <div className="bottom-strip"><span>{stale ? 'Cached positions · feed delayed' : 'Sorted by callsign'}</span><span className="mono">HEX IDENT / ADS-B</span></div>
  </section>;
}

function Home() {
  const flightsQuery = useGetFlights({ query: { ...usePolling, queryKey: ['/api/flights'] } });
  const summaryQuery = useGetFlightSummary({ query: { ...usePolling, queryKey: ['/api/flights/summary'] } });
  const airportsQuery = useGetAirports({ query: { staleTime: 300_000, queryKey: ['/api/airports'] } });
  const flights = flightsQuery.data?.flights ?? [];
  const [selectedFlight, setSelectedFlight] = useState<Flight | null>(null);
  const fetchedAt = flightsQuery.data?.fetchedAt ?? summaryQuery.data?.fetchedAt;
  return <div className="page">
    <PageHead eyebrow="LIVE OPERATIONS · SOUTH AFRICA" title="Airspace, in real time." subtitle="A live view of aircraft reporting across South Africa and the wider region." right={<><span className={`pill ${flightsQuery.data?.stale ? '' : 'live-pill'}`}><i className="live-dot" style={{ display: 'inline-block', marginRight: 7, width: 6, height: 6 }} />{flightsQuery.data?.stale ? 'FEED DELAYED' : 'LIVE FEED'}</span><span className="mono">UPDATED {formatTime(fetchedAt)}</span></>} />
    {flightsQuery.isError && <Notice error>Unable to reach the flight feed. Existing positions may be unavailable; automatic retries are enabled.</Notice>}
    {flightsQuery.data?.warning && <Notice>{flightsQuery.data.warning} Displayed position data may be cached.</Notice>}
    {summaryQuery.data?.stale && !flightsQuery.data?.warning && <Notice>Airspace totals are based on a cached response. Check the timestamp before relying on this view.</Notice>}
    <SummaryStrip summary={summaryQuery.data} flights={flights} />
    <div className="workspace">
      <FlightExplorer flights={flights} loading={flightsQuery.isLoading} error={flightsQuery.isError} stale={!!flightsQuery.data?.stale} selectedFlight={selectedFlight} setSelectedFlight={setSelectedFlight} />
      {flightsQuery.isLoading ? <section className="map-panel"><div className="map-toolbar"><div className="skeleton" style={{ width: 180, height: 12 }} /></div><div className="map-canvas"><div className="skeleton" style={{ position: 'absolute', inset: 0, opacity: .38 }} /></div></section> : <MapView flights={flights} airports={airportsQuery.data} selectedFlight={selectedFlight} setSelectedFlight={setSelectedFlight} />}
    </div>
    <div style={{ marginTop: 11, color: '#71838d', fontSize: 9 }} data-testid="text-flight-data-note">Aircraft positions are live transponder reports; they are not verified flight plans or official ATC instructions.</div>
  </div>;
}

function airportCode(airport: Airport) {
  return airport.iataCode || airport.icaoCode || `ID ${airport.airportId}`;
}

function AirportDetail({ airport, flights, routes }: { airport: Airport; flights: Flight[]; routes: AirportRoute[] }) {
  const [expandedRoutes, setExpandedRoutes] = useState<Record<string, boolean>>({});
  const nearby = flights.map((flight) => {
    if (flight.latitude == null || flight.longitude == null) return null;
    const distance = distanceKm(airport.latitude, airport.longitude, flight.latitude, flight.longitude);
    return distance <= 50 ? { flight, distance } : null;
  }).filter((entry): entry is { flight: Flight; distance: number } => entry !== null).sort((a, b) => a.distance - b.distance);
  const airportCodes = new Set([airport.iataCode, airport.icaoCode].filter((code): code is string => !!code).map(code => code.toUpperCase()));
  const referenceRoutes = routes.filter(route => airportCodes.has(route.sourceAirportCode) || airportCodes.has(route.destinationAirportCode));
  const departures = referenceRoutes.filter(route => airportCodes.has(route.sourceAirportCode));
  const arrivals = referenceRoutes.filter(route => airportCodes.has(route.destinationAirportCode));
  const nearbyAirlines = new Set(nearby.map(({ flight }) => flight.airlineName?.toLocaleLowerCase()).filter((name): name is string => !!name));
  const routeSection = (title: string, directionRoutes: AirportRoute[], direction: 'departures' | 'arrivals') => (
    <div className="route-direction" data-testid={`list-route-${direction}`}>
      <div className="route-direction-title">{title}<span>{directionRoutes.length} ROUTES</span></div>
      {directionRoutes.length === 0 ? <div className="route-empty">No reference routes listed.</div> : (expandedRoutes[direction] ? directionRoutes : directionRoutes.slice(0, 6)).map(route => {
        const carrierNearby = !!route.airlineName && nearbyAirlines.has(route.airlineName.toLocaleLowerCase());
        return <div className="route-entry" key={route.routeKey} data-testid={`row-route-${direction}-${route.routeKey}`}>
          <div><strong>{route.airlineName || route.airlineCode}</strong><span className="route-codes">{route.sourceAirportCode} <ArrowUpRight size={11} /> {route.destinationAirportCode}</span></div>
          <span className={`route-status ${carrierNearby ? 'nearby' : ''}`}>{carrierNearby ? 'CARRIER NEARBY' : 'REFERENCE'}</span>
        </div>;
      })}
      {directionRoutes.length > 6 && <button className="route-more" onClick={() => setExpandedRoutes(current => ({ ...current, [direction]: !current[direction] }))} aria-expanded={!!expandedRoutes[direction]}>{expandedRoutes[direction] ? 'Show fewer' : `Show all ${directionRoutes.length} routes`}</button>}
    </div>
  );
  return <section className="surface airport-detail" data-testid={`detail-airport-${airport.airportId}`}>
    <div className="airport-detail-top"><div><div className="airport-large-code">{airportCode(airport)}</div><h2>{airport.name}</h2><div className="airport-detail-city">{airport.city || airport.country} · {airport.country}</div></div><span className="airport-badge">{airport.type || 'AIRPORT'}</span></div>
    <div className="detail-grid">
      <div className="detail-item"><label>ICAO identifier</label><strong>{airport.icaoCode || 'Not listed'}</strong></div>
      <div className="detail-item"><label>IATA identifier</label><strong>{airport.iataCode || 'Not listed'}</strong></div>
      <div className="detail-item"><label>Field elevation</label><strong>{airport.altitude == null ? '—' : `${Math.round(airport.altitude)} ft`}</strong></div>
      <div className="detail-item"><label>Coordinates</label><strong>{airport.latitude.toFixed(4)}°, {airport.longitude.toFixed(4)}°</strong></div>
      <div className="detail-item"><label>Local time zone</label><strong>{airport.tzDatabase || (airport.timezone == null ? '—' : `UTC${airport.timezone >= 0 ? '+' : ''}${airport.timezone}`)}</strong></div>
      <div className="detail-item"><label>Country</label><strong>{airport.country}</strong></div>
    </div>
    <div className="nearby-head"><h3>Route references</h3><span className="nearby-caption">OpenFlights · not live schedules</span></div>
    <div className="route-board">
      {routeSection('FROM THIS AIRPORT', departures, 'departures')}
      {routeSection('TO THIS AIRPORT', arrivals, 'arrivals')}
    </div>
    <div className="route-disclaimer">Routes are reference records, not confirmed departures or arrivals. “Carrier nearby” only means a callsign-matched aircraft was reported within 50 km.</div>
    <div className="nearby-head"><h3>Aircraft within 50 km</h3><span className="nearby-caption">{nearby.length} transponder reports</span></div>
    <div className="nearby-list" data-testid="list-nearby-aircraft">
      {nearby.length === 0 ? <div className="empty-state" style={{ padding: '28px 12px' }} data-testid="empty-nearby-aircraft"><div className="empty-icon"><Plane size={18} /></div><strong>No aircraft reported nearby</strong><p>There are no current position reports within 50 km of this airport.</p></div> : nearby.map(({ flight, distance }) => <div className="nearby-row" key={flight.icao24} data-testid={`row-nearby-${flight.icao24}`}><strong>{flight.callsign?.trim() || flight.icao24}</strong><span>{distance.toFixed(1)} km</span><span>{formatAltitude(flight.baroAltitude)}</span><span className={`status-tag ${flight.onGround ? 'ground' : ''}`}>{flight.onGround ? 'GROUND' : 'AIRBORNE'}</span></div>)}
    </div>
    <div style={{ marginTop: 17, color: '#71838d', fontSize: 9 }}>Nearby distance is calculated from reported aircraft position and airport coordinates. Position reports may be delayed.</div>
  </section>;
}

function Airports() {
  const airportsQuery = useGetAirports({ query: { staleTime: 300_000, queryKey: ['/api/airports'] } });
  const routesQuery = useGetAirportRoutes({ query: { staleTime: 300_000, queryKey: ['/api/airport-routes'] } });
  const flightsQuery = useGetFlights({ query: { ...usePolling, queryKey: ['/api/flights'] } });
  const [query, setQuery] = useState('');
  const airports = airportsQuery.data ?? [];
  const results = useMemo(() => airports.filter((airport) => `${airport.name} ${airport.city ?? ''} ${airport.iataCode ?? ''} ${airport.icaoCode ?? ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => airportCode(a).localeCompare(airportCode(b))), [airports, query]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = results.find(a => a.airportId === selectedId) ?? results.find(a => a.iataCode === 'JNB') ?? results[0] ?? null;
  return <div className="page">
    <PageHead eyebrow="FIELD DIRECTORY · SOUTH AFRICA" title="Airports & nearby traffic" subtitle="Search by airport name, IATA, ICAO or city. Select a field to see current reports within 50 km." right={<span className="pill">{airports.length} AIRFIELDS</span>} />
    {airportsQuery.isError && <Notice error>Airport directory unavailable. Please retry when the API connection is restored.</Notice>}
    {routesQuery.isError && <Notice>OpenFlights route references are unavailable; airport positions and nearby aircraft remain available.</Notice>}
    {flightsQuery.isError && <Notice error>Nearby aircraft cannot be refreshed because the live flight feed is unavailable.</Notice>}
    <div className="airport-layout">
      <section className="flight-panel" style={{ minHeight: 0 }} aria-label="Airport directory">
        <div className="panel-head"><div className="panel-title-row"><h2 className="panel-title">Airport directory</h2><span className="result-count">{results.length} FIELDS</span></div><label className="search-wrap"><Search size={14} /><input className="search-input" value={query} onChange={(e) => { setQuery(e.target.value); setSelectedId(null); }} placeholder="IATA, ICAO, airport or city" aria-label="Search airports" data-testid="input-airport-search" /></label></div>
        <div className="airport-results">
          {airportsQuery.isLoading && <LoadingRows count={8} />}
          {!airportsQuery.isLoading && !airportsQuery.isError && results.length === 0 && <div className="empty-state" data-testid="empty-airports"><div className="empty-icon"><MapPin size={18} /></div><strong>{airports.length ? 'No airports found' : 'Directory is empty'}</strong><p>Search by city, airport name or code.</p></div>}
          {!airportsQuery.isLoading && results.map(airport => <button key={airport.airportId} className={`airport-row ${selected?.airportId === airport.airportId ? 'active' : ''}`} onClick={() => setSelectedId(airport.airportId)} data-testid={`row-airport-${airport.airportId}`}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><span className="airport-code">{airportCode(airport)}</span><span className="result-count">{airport.type || 'AIRPORT'}</span></div><div className="airport-name">{airport.name}</div><div className="airport-city">{airport.city || airport.country} · {airport.icaoCode || 'ICAO n/a'}</div></button>)}
        </div>
        <div className="bottom-strip"><span>South African airport data</span><span className="mono">OPENFLIGHTS</span></div>
      </section>
      {selected ? <AirportDetail airport={selected} flights={flightsQuery.data?.flights ?? []} routes={routesQuery.data ?? []} /> : <section className="surface airport-detail"><div className="empty-state"><div className="empty-icon"><MapPin size={18} /></div><strong>Select an airport</strong><p>Airport coordinates and nearby aircraft reports will appear here.</p></div></section>}
    </div>
    <div style={{ marginTop: 12, color: '#71838d', fontSize: 9 }} data-testid="text-airport-attribution">Airport directory attribution: OpenFlights. Nearby aircraft positions: OpenSky Network.</div>
  </div>;
}

function About() {
  const health = useHealthCheck({ query: { ...usePolling, queryKey: ['/api/healthz'] } });
  return <div className="page info-layout">
    <div className="info-hero"><div className="eyebrow">SYSTEM NOTES · SOURCES & LIMITATIONS</div><h1>Know what the signal says — and what it doesn’t.</h1><p>SA Travel brings client bookings and ground transfers together with live aircraft position reports and open airport data. The airspace map is an observation tool, not a flight-plan service or an air traffic control system.</p></div>
    <div className="info-columns">
      <section className="info-card"><h2>Data sources</h2>
        <div className="source-row"><strong>OpenSky Network</strong><span>Live aircraft state vectors</span></div>
        <div className="source-row"><strong>OpenFlights</strong><span>Airport reference directory</span></div>
        <div className="source-row"><strong>OpenStreetMap</strong><span>Map context & geographic labels</span></div>
        <p style={{ marginTop: 13 }}>Aircraft positions are derived from crowdsourced ADS-B and other transponder observations. Coverage varies by location, aircraft equipment and receiver visibility. Airport names, codes and coordinates are reference data.</p>
      </section>
      <section className="info-card"><h2>Refresh & connection</h2>
        <div className="source-row"><strong>API polling</strong><span>Every 30 seconds</span></div>
        <div className="source-row"><strong>OpenSky snapshot cache</strong><span>Up to 5 minutes</span></div>
        <div className="source-row"><strong>Airport directory</strong><span>Cached between visits</span></div>
        <div className="source-row"><strong>API status</strong><span data-testid="status-health-detail">{health.isError ? 'Connection unavailable' : health.data?.status || 'Checking connection'}</span></div>
        <p style={{ marginTop: 13 }}>The timestamp shown with each response is when the data was fetched. The interface checks the API every 30 seconds, while the server caches OpenSky snapshots for up to 5 minutes to respect upstream limits. A stale feed can continue showing cached positions when updates are interrupted.</p>
      </section>
      <section className="info-card"><h2>Reading the display</h2>
        <div className="data-key">
          <div className="key-row"><span className="key-mark"><Plane size={11} /></span><span>Map markers follow reported latitude, longitude and true track. Altitude tint is a quick visual cue; amber flags ground or higher-altitude targets.</span></div>
          <div className="key-row"><span className="key-mark"><ArrowUpRight size={11} /></span><span>Altitude and speed are converted from reported metric values to feet and knots for readability. Missing or withheld values appear as a dash.</span></div>
          <div className="key-row"><span className="key-mark">50</span><span>Airport nearby aircraft are calculated using great-circle distance from reported aircraft coordinates; the radius is 50 km.</span></div>
        </div>
      </section>
      <section className="info-card"><h2>Important distinction</h2>
        <div className="notice" style={{ margin: 0 }}><ShieldCheck size={16} /><span>These are observed position reports, not verified flight-plan data. A callsign or airline label may be incomplete, inferred or absent. This service does not provide ATC clearances, safety alerts or operational advice.</span></div>
        <p style={{ marginTop: 13 }}>Map tiles and geographic context © OpenStreetMap contributors. Airport reference data © OpenFlights. Aircraft tracking data provided by OpenSky Network.</p>
      </section>
    </div>
  </div>;
}

function LoadingSession() {
  return <div className="session-loading"><span className="session-loading-mark"><Plane size={18} /></span><div className="skeleton" style={{ width: 180, height: 10 }} /><div className="skeleton" style={{ width: 260, height: 7 }} /></div>;
}

function SessionRouter() {
  const auth = useAuth();
  const [path] = useLocation();
  if (path === '/privacy/request') return <ErrorBoundary resetKey={path}><PublicPrivacyRequestPage /></ErrorBoundary>;
  if (path.startsWith('/privacy/verify/')) return <ErrorBoundary resetKey={path}><VerifyPrivacyPage /></ErrorBoundary>;
  if (auth.loading) return <LoadingSession />;
  if (!auth.user) return path === '/' ? <SignInPage /> : <Redirect to="/" />;
  if (path === '/') return <Redirect to="/dashboard" />;
  const flightPage = ['/flights', '/airports', '/about'].includes(path);
  return <ErrorBoundary resetKey={path}><WorkspaceShell flightPage={flightPage}><Switch>
    <Route path="/dashboard" component={DashboardPage} />
    <Route path="/dashboard/bookings/new" component={NewBookingPage} />
    <Route path="/dashboard/itinerary/:id" component={ItineraryPage} />
    <Route path="/dashboard/privacy" component={PrivacyDeskPage} />
    <Route path="/flights" component={Home} />
    <Route path="/airports" component={Airports} />
    <Route path="/about" component={About} />
    <Route component={NotFound} />
  </Switch></WorkspaceShell></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><AuthProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><SessionRouter /></WouterRouter></AuthProvider><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
