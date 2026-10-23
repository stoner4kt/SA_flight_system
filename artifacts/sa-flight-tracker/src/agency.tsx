import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'wouter';
import {
  Activity, AlertCircle, ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays, CarFront, Check,
  ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, FileKey2, LogOut, Plane, Plus,
  RefreshCw, ShieldCheck, X
} from 'lucide-react';
import {
  getGetDashboardSummaryQueryKey, getGetItineraryQueryKey, getListDsrRequestsQueryKey,
  getListItinerariesQueryKey, useCreateDsrRequest, useCreateFleetAssignment, useCreateItinerary,
  useGetDashboardSummary, useGetFleetAvailability, useGetFlightSummary, useGetFlights, useGetItinerary, useListDsrRequests,
  useListItineraries, useUpdateDsrRequest, useUpdateFleetTrackingState, useVerifyDsrToken
} from '@workspace/api-client-react';
import { VehicleTimelineGrid } from '@/components/VehicleTimelineGrid';
import type {
  AssignmentInput, DsrRequest, DsrRequestInputRequestType, DsrRequestUpdateStatus,
  FlightSegment, FleetAssignmentTrackingState, ItineraryInput, ListDsrRequestsStatus
} from '@workspace/api-client-react';
import { supabase, useAuth } from '@/auth';

const trackingStates: FleetAssignmentTrackingState[] = ['scheduled', 'en_route', 'arrived', 'passenger_onboard', 'completed', 'cancelled'];
const dsrStatuses: DsrRequestUpdateStatus[] = ['verified', 'processing', 'completed', 'rejected'];
const dateLabel = (value?: string | null) => value ? new Date(value).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Johannesburg' }) : 'Not scheduled';
const compactDate = (value?: string | null) => value ? new Date(value).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' }) : '—';
const initials = (value: string) => value.split(/[ @._-]/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
const humanize = (value: string) => value.replaceAll('_', ' ');
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const toSastInput = (value: Date) => new Date(value.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 16);
function southAfricanDayBounds(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  const start = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00+02:00`);
  return { from: start.toISOString(), to: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString() };
}

function useAgencyRealtime() {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase.channel('agency-operations-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fleet_assignments' }, () => {
        void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListItinerariesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: ['/api/fleet/availability'] });
        void queryClient.invalidateQueries({ queryKey: ['/api/itineraries'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'itineraries' }, () => {
        void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListItinerariesQueryKey() });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'popia_dsr_requests' }, () => {
        void queryClient.invalidateQueries({ queryKey: getListDsrRequestsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      })
      .subscribe();
    return () => { void supabase?.removeChannel(channel); };
  }, [queryClient]);
}

export function WorkspaceShell({ children, flightPage = false }: { children: ReactNode; flightPage?: boolean }) {
  const [path] = useLocation();
  const { user, signOut } = useAuth();
  const links = [
    { href: '/dashboard', label: 'Overview', icon: Activity, group: 'OPERATIONS' },
    { href: '/dashboard/bookings/new', label: 'New booking', icon: Plus, group: 'OPERATIONS' },
    { href: '/dashboard/privacy', label: 'Privacy requests', icon: ShieldCheck, group: 'COMPLIANCE' },
    { href: '/flights', label: 'Live airspace', icon: Plane, group: 'FLIGHT INTELLIGENCE' },
    { href: '/airports', label: 'Airports', icon: ArrowUpRight, group: 'FLIGHT INTELLIGENCE' },
    { href: '/about', label: 'System notes', icon: CircleHelp, group: 'FLIGHT INTELLIGENCE' },
  ];
  return <div className={`agency-frame${flightPage ? ' agency-frame-flight' : ''}`}>
    <aside className="agency-rail">
      <Link href="/dashboard" className="agency-brand" data-testid="link-workspace-home">
        <span className="agency-brand-mark"><Plane size={17} /></span>
        <span className="agency-brand-copy"><strong>SA TRAVEL</strong><small>FIELD OFFICE · JHB</small></span>
      </Link>
      <div className="rail-rule" />
      <nav className="rail-navigation" aria-label="Workspace navigation">
        {links.map((item, index) => {
          const Icon = item.icon;
          const selected = item.href === '/dashboard' ? path === '/dashboard' : item.href === '/dashboard/bookings/new' ? path.startsWith('/dashboard/bookings') || path.startsWith('/dashboard/itinerary') : path === item.href;
          const priorGroup = index > 0 ? links[index - 1].group : '';
          return <div key={item.href}>
            {priorGroup !== item.group && <div className="rail-label">{item.group}</div>}
            <Link href={item.href} className={`rail-link${selected ? ' active' : ''}`} data-testid={`link-${item.href.replaceAll('/', '-').replace(/^-/, '')}`}>
              <Icon size={16} strokeWidth={1.8} /><span>{item.label}</span>{item.href === '/dashboard/privacy' && <span className="rail-link-trailing">•</span>}
            </Link>
          </div>;
        })}
      </nav>
      <div className="rail-bottom">
        <div className="rail-service"><span className="service-dot" /><span><b>Systems operational</b><small>Session protected</small></span></div>
        <div className="agent-profile"><span className="agent-avatar">{initials(user?.email || 'Agent')}</span><span className="agent-profile-copy"><b>{user?.email?.split('@')[0] || 'Agent'}</b><small>Travel operations</small></span><button className="icon-button rail-signout" onClick={() => void signOut()} aria-label="Sign out" title="Sign out" data-testid="button-sign-out"><LogOut size={15} /></button></div>
      </div>
    </aside>
    <div className="agency-content">
      <header className="agency-topline">
        <div className="crumb"><span>SA TRAVEL</span><span>/</span><strong>{path.startsWith('/flights') ? 'AIRSPACE' : path.startsWith('/airports') ? 'AIRPORTS' : path.startsWith('/about') ? 'SYSTEM NOTES' : path.includes('privacy') ? 'PRIVACY DESK' : path.includes('itinerary') || path.includes('bookings') ? 'ITINERARY DESK' : 'OPERATIONS'}</strong></div>
        <div className="topline-meta"><span className="topline-status"><i /> JHB · UTC+2</span><span className="topline-date">{new Date().toLocaleDateString('en-ZA', { weekday: 'short', day: '2-digit', month: 'short' })}</span></div>
      </header>
      <main className={`agency-main${flightPage ? ' agency-main-flight' : ''}`}>{children}</main>
      <nav className="agency-mobile-nav" aria-label="Mobile navigation">
        {links.slice(0, 5).map((item) => { const Icon = item.icon; return <Link key={item.href} href={item.href} className={path === item.href ? 'active' : ''}><Icon size={17} /><span>{item.label === 'Privacy requests' ? 'Privacy' : item.label === 'Live airspace' ? 'Flights' : item.label}</span></Link>; })}
      </nav>
    </div>
  </div>;
}

export function SignInPage() {
  const { signIn, configured } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    const message = await signIn(email.trim(), password);
    setBusy(false);
    if (message) setError(message); else navigate('/dashboard');
  }
  return <div className="auth-scene">
    <div className="auth-aside">
      <Link href="/" className="auth-brand"><span className="agency-brand-mark"><Plane size={17} /></span> SA TRAVEL <span className="auth-brand-slash">/</span> OPERATIONS</Link>
      <div className="auth-message"><span className="auth-index">01 — SOUTH AFRICA</span><h1>Every arrival<br />has a next step.</h1><p>One desk for the booking, the vehicle, the passenger and the moments in between.</p></div>
      <div className="auth-map-lines" aria-hidden="true"><span /><span /><span /><i>JNB</i><i>CPT</i><i>DUR</i></div>
      <div className="auth-aside-foot"><span>AGENCY WORKSPACE</span><span>25°44′S 28°11′E</span></div>
    </div>
    <section className="auth-card">
      <div className="auth-card-kicker"><span>STAFF ACCESS</span><span className="auth-kicker-mark">A—01</span></div>
      <h2>Welcome back.</h2><p className="auth-intro">Sign in with your agency account to continue.</p>
      {!configured && <div className="setup-alert"><AlertCircle size={17} /><div><strong>Workspace setup required</strong><p>Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to enable staff login.</p></div></div>}
      <form onSubmit={submit} className="auth-form">
        <label>Email address<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@agency.co.za" data-testid="input-login-email" /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your password" data-testid="input-login-password" /></label>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <button className="button-primary auth-submit" disabled={!configured || busy} data-testid="button-login">{busy ? 'Checking access…' : <>Sign in to workspace <ArrowRight size={16} /></>}</button>
      </form>
      <div className="auth-card-foot"><ShieldCheck size={14} /><span>Protected by Supabase authentication. Access is for agency staff only.</span></div>
    </section>
  </div>;
}

function PageHeading({ kicker, title, description, actions }: { kicker: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><div className="section-kicker">{kicker}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</div>;
}
function ErrorPanel({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="state-panel state-error"><span className="state-symbol"><AlertCircle size={18} /></span><div><strong>We couldn’t load this view</strong><p>{message}</p>{retry && <button className="text-action" onClick={retry}><RefreshCw size={13} /> Try again</button>}</div></div>;
}
function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return <div className="skeleton-block" aria-label="Loading"><span /><span /><span style={{ width: '62%' }} />{lines > 3 && <span style={{ width: '45%' }} />}</div>;
}
function StatTile({ label, value, note, icon: Icon, accent }: { label: string; value: string | number; note: string; icon: typeof Activity; accent?: string }) {
  return <div className={`stat-tile ${accent || ''}`}><div className="stat-tile-top"><span>{label}</span><Icon size={16} /></div><strong>{value}</strong><small>{note}</small></div>;
}

export function DashboardPage() {
  useAgencyRealtime();
  const summary = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey(), refetchInterval: 60_000 } });
  const itineraries = useListItineraries({ query: { queryKey: getListItinerariesQueryKey(), refetchOnMount: 'always' } });
  const flights = useGetFlights({ query: { queryKey: ['/api/flights'], refetchInterval: 30_000 } });
  const flightSummary = useGetFlightSummary({ query: { queryKey: ['/api/flights/summary'], refetchInterval: 30_000 } });
  const items = itineraries.data ?? [];
  const flightCount = flightSummary.data?.totalFlights ?? flights.data?.flights.length ?? 0;
  return <div className="workspace-page">
     <PageHeading kicker="AGENCY WORKSPACE · SOUTH AFRICA" title="Good day, team." description="Your travel movements, vehicles and live airspace at a glance." actions={<Link href="/dashboard/bookings/new" className="button-primary" data-testid="button-new-booking"><Plus size={16} /> Record booking</Link>} />
    {(summary.isError || itineraries.isError) && <ErrorPanel message="Operations summaries are unavailable. Your session is still active; retry the connection." retry={() => { void summary.refetch(); void itineraries.refetch(); }} />}
    <div className="stat-grid">
      {summary.isLoading ? <SkeletonBlock lines={4} /> : <StatTile label="Active itineraries" value={summary.data?.totalItineraries ?? '—'} note="Bookings on the books" icon={CalendarDays} />}
      {summary.isLoading ? <SkeletonBlock lines={4} /> : <StatTile label="Vehicle movements" value={summary.data?.activeAssignments ?? '—'} note="Assignments in progress" icon={CarFront} accent="stat-teal" />}
      {summary.isLoading ? <SkeletonBlock lines={4} /> : <StatTile label="Fleet available" value={summary.data?.availableVehicles ?? '—'} note="Vehicles ready to assign" icon={Activity} accent="stat-ochre" />}
      {summary.isLoading ? <SkeletonBlock lines={4} /> : <StatTile label="Privacy queue" value={summary.data?.pendingDsrRequests ?? '—'} note="Requests awaiting action" icon={FileKey2} accent="stat-rust" />}
    </div>
    <section className="airspace-banner">
      <div className="airspace-banner-art"><span className="radar-ring r1" /><span className="radar-ring r2" /><span className="radar-ring r3" /><span className="radar-sweep" /><Plane size={23} /></div>
      <div className="airspace-copy"><span className="section-kicker">LIVE AIRSPACE · SOUTHERN AFRICA</span><h2>{flights.isLoading ? 'Checking the live feed…' : `${flightCount.toLocaleString()} aircraft in range`}</h2><p>{flights.isError ? 'Live reports are temporarily unavailable.' : flights.data?.stale ? 'Cached positions are showing; feed updates may be delayed.' : `${flightSummary.data?.airborne ?? '—'} airborne · ${flightSummary.data?.onGround ?? '—'} on ground · refreshed every 30 seconds`}</p></div>
      <Link href="/flights" className="airspace-link" data-testid="link-open-live-map">Open live map <ArrowUpRight size={15} /></Link>
    </section>
    <div className="dashboard-columns">
      <section className="panel-card itinerary-panel">
        <div className="panel-heading"><div><span className="section-kicker">CLIENT MOVEMENTS</span><h2>Recent bookings</h2></div><Link href="/dashboard/bookings/new" className="small-link">New booking <ArrowRight size={13} /></Link></div>
        {itineraries.isLoading ? <SkeletonBlock lines={4} /> : items.length === 0 && !itineraries.isError ? <div className="empty-card"><span className="empty-icon-warm"><Plane size={18} /></span><strong>No bookings recorded</strong><p>Start with a client and their flight segments. Pickups can be assigned once the trip is saved.</p><Link href="/dashboard/bookings/new" className="text-action">Create the first booking <ArrowRight size={13} /></Link></div> : <div className="itinerary-list">
          {items.slice(0, 6).map((itinerary) => <Link href={`/dashboard/itinerary/${itinerary.id}`} key={itinerary.id} className="itinerary-row" data-testid={`row-itinerary-${itinerary.id}`}>
            <span className="date-chip"><b>{compactDate(itinerary.departure_at).split(' ')[0]}</b><small>{compactDate(itinerary.departure_at).split(' ')[1]}</small></span>
            <span className="itinerary-main"><b>{itinerary.client_name}</b><small>{itinerary.itinerary_ref} · {itinerary.client_email}</small></span>
            <span className={`status-chip status-${itinerary.status}`}>{humanize(itinerary.status)}</span>
            <span className="assignment-count"><CarFront size={13} /> {itinerary.assignment_count}</span><ArrowUpRight size={14} className="row-arrow" />
          </Link>)}
        </div>}
        <div className="panel-footer"><span>{itineraries.isLoading ? 'Loading bookings' : `${items.length} itinerary${items.length === 1 ? '' : 's'} in workspace`}</span><Link href="/dashboard/bookings/new">Record another <ArrowRight size={12} /></Link></div>
      </section>
      <section className="panel-card activity-panel">
        <div className="panel-heading"><div><span className="section-kicker">ON THE DESK</span><h2>Recent activity</h2></div><span className="activity-live"><i /> SYNCED</span></div>
        {summary.isLoading ? <SkeletonBlock lines={4} /> : (summary.data?.recentActivity?.length ?? 0) === 0 ? <div className="empty-card empty-activity"><span className="empty-icon-warm"><Clock3 size={17} /></span><strong>No recent activity</strong><p>New assignments and milestones will be noted here.</p></div> : <div className="activity-list">
          {summary.data?.recentActivity.map((event) => <div className="activity-event" key={event.id}><span className={`activity-mark activity-${event.kind}`}><Activity size={13} /></span><div><b>{event.title}</b><p>{event.detail}</p><small>{dateLabel(event.occurredAt)} {event.itineraryReference ? `· ${event.itineraryReference}` : ''}</small></div></div>)}
        </div>}
      </section>
    </div>
    <div className="dashboard-bottom-note"><ShieldCheck size={14} /><span>Client information is held for operational use only. Handle identity and passport details according to POPIA.</span><Link href="/dashboard/privacy">Privacy desk <ArrowUpRight size={12} /></Link></div>
  </div>;
}

type SegmentForm = { flight_number: string; airline: string; origin: string; destination: string; departure_time: string; arrival_time: string; terminal: string };
const blankSegment = (): SegmentForm => ({ flight_number: '', airline: '', origin: '', destination: '', departure_time: '', arrival_time: '', terminal: '' });
const toIso = (value: string) => value ? new Date(`${value}:00+02:00`).toISOString() : '';
export function NewBookingPage() {
  const create = useCreateItinerary();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [passport, setPassport] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [segments, setSegments] = useState<SegmentForm[]>([blankSegment()]);
  const [error, setError] = useState('');
  const changeSegment = (index: number, key: keyof SegmentForm, value: string) => setSegments((current) => current.map((segment, i) => i === index ? { ...segment, [key]: value } : segment));
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    const flight_segments: FlightSegment[] = segments.map((segment) => ({
      flight_number: segment.flight_number.trim() || null, airline: segment.airline.trim() || null,
      origin: segment.origin.trim().toUpperCase(), destination: segment.destination.trim().toUpperCase(),
      departure_time: toIso(segment.departure_time), arrival_time: toIso(segment.arrival_time), terminal: segment.terminal.trim() || null
    }));
    if (!flight_segments.length || flight_segments.some((segment) => !segment.origin || !segment.destination || !segment.departure_time || !segment.arrival_time)) {
      setError('Complete an origin, destination and both times for each flight segment.'); return;
    }
    const input: ItineraryInput = { client_name: clientName.trim(), client_email: clientEmail.trim(), client_phone: phone.trim() || null, passport_number: passport.trim() || null, sa_id_number: idNumber.trim() || null, flight_segments };
    create.mutate({ data: input }, {
      onSuccess: async (created) => {
        await Promise.all([queryClient.invalidateQueries({ queryKey: getListItinerariesQueryKey() }), queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() })]);
        navigate(`/dashboard/itinerary/${created.id}`);
      },
      onError: (reason) => setError(reason instanceof Error ? reason.message : 'Booking could not be saved. Please try again.')
    });
  }
  return <div className="workspace-page narrow-page">
    <div className="backline"><Link href="/dashboard" className="back-link"><ChevronLeft size={15} /> Back to operations</Link><span>BOOKING RECORD · NEW</span></div>
    <PageHeading kicker="CLIENT MOVEMENTS" title="Record a booking." description="Capture the flight details first. Vehicle transfers can be coordinated from the itinerary once saved." />
    <form className="booking-form" onSubmit={submit}>
      <section className="form-section">
        <div className="form-section-head"><span className="section-number">01</span><div><h2>Passenger details</h2><p>Share only what is required for this trip.</p></div></div>
        <div className="form-grid two"><label>Client name <input required maxLength={160} value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Full name" data-testid="input-client-name" /></label><label>Email address <input type="email" required maxLength={320} value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} placeholder="client@example.co.za" data-testid="input-client-email" /></label><label>Phone number · international format <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+27820000000" data-testid="input-client-phone" /></label><label>Passport number <input value={passport} onChange={(e) => setPassport(e.target.value)} placeholder="Optional" data-testid="input-client-passport" /></label><label className="form-full">South African ID number <input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} placeholder="Optional" data-testid="input-client-id" /></label></div>
      </section>
      <section className="form-section">
        <div className="form-section-head"><span className="section-number">02</span><div><h2>Flight segments</h2><p>Times are stored as ISO timestamps. Local time is shown in Johannesburg.</p></div></div>
        {segments.map((segment, index) => <div className="segment-card" key={index}><div className="segment-card-top"><span>SEGMENT {String(index + 1).padStart(2, '0')}</span>{segments.length > 1 && <button type="button" className="quiet-icon" onClick={() => setSegments((current) => current.filter((_, i) => i !== index))} aria-label="Remove segment"><X size={15} /></button>}</div>
          <div className="form-grid two"><label>Flight number <input value={segment.flight_number} onChange={(e) => changeSegment(index, 'flight_number', e.target.value)} placeholder="SA 321" /></label><label>Airline <input value={segment.airline} onChange={(e) => changeSegment(index, 'airline', e.target.value)} placeholder="Carrier name" /></label><label>Origin airport <input required value={segment.origin} onChange={(e) => changeSegment(index, 'origin', e.target.value)} placeholder="JNB" /></label><label>Destination airport <input required value={segment.destination} onChange={(e) => changeSegment(index, 'destination', e.target.value)} placeholder="CPT" /></label><label>Departure <input required type="datetime-local" value={segment.departure_time} onChange={(e) => changeSegment(index, 'departure_time', e.target.value)} /></label><label>Arrival <input required type="datetime-local" value={segment.arrival_time} onChange={(e) => changeSegment(index, 'arrival_time', e.target.value)} /></label><label className="form-full">Terminal / meeting note <input value={segment.terminal} onChange={(e) => changeSegment(index, 'terminal', e.target.value)} placeholder="Optional" /></label></div>
        </div>)}
        {segments.length < 12 && <button type="button" className="add-segment" onClick={() => setSegments((current) => [...current, blankSegment()])}><Plus size={14} /> Add another segment <span>UP TO 12</span></button>}
      </section>
      {error && <div className="form-error" role="alert"><AlertCircle size={16} />{error}</div>}
      <div className="form-actions"><span><ShieldCheck size={14} /> Selected identity and contact fields are encrypted at rest.</span><button className="button-primary" disabled={create.isPending} data-testid="button-save-booking">{create.isPending ? 'Saving booking…' : <>Save booking <ArrowRight size={15} /></>}</button></div>
    </form>
  </div>;
}

function AssignmentForm({ itineraryId, clientEmail, departureAt, arrivalAt, refresh }: { itineraryId: string; clientEmail: string; departureAt?: string | null; arrivalAt?: string | null; refresh: () => void }) {
  const dayBounds = useMemo(() => southAfricanDayBounds(arrivalAt ?? departureAt), [arrivalAt, departureAt]);
  const from = dayBounds?.from ?? '';
  const to = dayBounds?.to ?? '';
  const availabilityParams = useMemo(() => ({ from, to }), [from, to]);
  const availability = useGetFleetAvailability(availabilityParams, { query: { enabled: Boolean(from && to), queryKey: ['/api/fleet/availability', availabilityParams] } });
  const create = useCreateFleetAssignment();
  const [open, setOpen] = useState(false);
  const [vehicleId, setVehicleId] = useState('');
  const [driver, setDriver] = useState('');
  const [contact, setContact] = useState('');
  const [pickupAt, setPickupAt] = useState(arrivalAt ? toSastInput(new Date(new Date(arrivalAt).getTime() + 15 * 60 * 1000)) : departureAt ? toSastInput(new Date(new Date(departureAt).getTime() - 90 * 60 * 1000)) : '');
  const [dropoffAt, setDropoffAt] = useState(arrivalAt ? toSastInput(new Date(new Date(arrivalAt).getTime() + 75 * 60 * 1000)) : departureAt ? toSastInput(new Date(departureAt)) : '');
  const [pickup, setPickup] = useState('');
  const [dropoff, setDropoff] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [notificationNotice, setNotificationNotice] = useState('');
  const vehicles = availability.data ?? [];
  const activeVehicles = vehicles.filter((item) => item.vehicle.active);
  const freeVehicles = activeVehicles.filter((item) => item.available);
  const selectTimelineSlot = (vehicle: { id: string }, slotTime: Date) => {
    setVehicleId(vehicle.id);
    setPickupAt(toSastInput(slotTime));
    setDropoffAt(toSastInput(new Date(slotTime.getTime() + 60 * 60 * 1000)));
    setOpen(true);
    setError('');
  };
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!vehicleId) { setError('Choose an available vehicle for this transfer.'); return; }
    const data: AssignmentInput = { itinerary_id: itineraryId, vehicle_id: vehicleId, driver_name: driver.trim(), driver_contact: contact.trim(), pickup_at: toIso(pickupAt), dropoff_at: toIso(dropoffAt), pickup_address: pickup.trim(), dropoff_address: dropoff.trim(), client_email: clientEmail, notes: notes.trim() || null };
    create.mutate({ data }, { onSuccess: (result) => { setOpen(false); setNotificationNotice(result.notification_sent ? 'Transfer saved and itinerary email sent.' : result.notification_message || 'Transfer saved, but the itinerary email was not sent.'); refresh(); }, onError: (reason) => setError(reason instanceof Error ? reason.message : 'Vehicle assignment failed.') });
  }
  if (!from || !to) return <div className="setup-note"><CalendarDays size={16} /><span>Add a flight time before checking the fleet schedule.</span></div>;
  return <div className="assignment-availability">
    {notificationNotice && <div className="setup-note" role="status">{notificationNotice}</div>}
    <div className="availability-banner"><div><span className="section-kicker">FLEET WINDOW · SAST</span><strong>{availability.isLoading ? 'Checking availability…' : availability.isError ? 'Availability unavailable' : `${freeVehicles.length} vehicles free all day`}</strong><small>{dateLabel(arrivalAt ?? departureAt)}</small></div><button className="button-outline" type="button" disabled={availability.isLoading} onClick={() => void availability.refetch()}><RefreshCw size={14} /> Refresh</button></div>
    {availability.isError && <ErrorPanel message="Vehicle availability could not be checked. Retry before assigning a transfer." retry={() => void availability.refetch()} />}
    {!availability.isLoading && !availability.isError && vehicles.length === 0 && <div className="empty-inline">No fleet vehicles are configured for this time range.</div>}
    {!availability.isLoading && !availability.isError && vehicles.length > 0 && dayBounds && <VehicleTimelineGrid rows={vehicles} dayStart={dayBounds.from} flightStart={departureAt} flightEnd={arrivalAt} onSlotClick={selectTimelineSlot} />}
    {!availability.isLoading && vehicles.length > 0 && <div className="vehicle-options">{vehicles.map((item) => <div className={`vehicle-option${item.available ? ' vehicle-free' : ''}`} key={item.vehicle.id}><span className="vehicle-icon"><CarFront size={17} /></span><span className="vehicle-copy"><b>{item.vehicle.registration}</b><small>{item.vehicle.make_model} · seats {item.vehicle.capacity}</small></span><span className={`availability-tag ${item.available ? 'free' : ''}`}>{item.available ? 'FREE ALL DAY' : `${item.conflicts.length} BOOKED WINDOW${item.conflicts.length === 1 ? '' : 'S'}`}</span></div>)}</div>}
    {!open ? <button type="button" className="button-primary" disabled={activeVehicles.length === 0} onClick={() => { setVehicleId(freeVehicles[0]?.vehicle.id ?? activeVehicles[0]?.vehicle.id ?? ''); setOpen(true); }}><Plus size={15} /> Assign transfer</button> :
      <form className="assignment-form" onSubmit={submit}><div className="form-section-head compact"><span className="section-number">+</span><div><h2>Assign vehicle & driver</h2><p>Pickup and drop-off information is shared with the passenger.</p></div><button type="button" className="quiet-icon" onClick={() => setOpen(false)}><X size={15} /></button></div>
        <div className="form-grid two"><label>Vehicle <select required value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>{activeVehicles.map((item) => <option value={item.vehicle.id} key={item.vehicle.id}>{item.vehicle.registration} · {item.vehicle.make_model}{item.available ? ' · free all day' : ` · ${item.conflicts.length} booked windows`}</option>)}</select></label><label>Driver name <input required value={driver} onChange={(e) => setDriver(e.target.value)} /></label><label>Driver contact · international format <input required value={contact} onChange={(e) => setContact(e.target.value)} placeholder="+27820000000" /></label><label>Pickup time · SAST <input required type="datetime-local" value={pickupAt} onChange={(e) => setPickupAt(e.target.value)} /></label><label>Drop-off time · SAST <input required type="datetime-local" value={dropoffAt} onChange={(e) => setDropoffAt(e.target.value)} /></label><label>Pickup address <input required value={pickup} onChange={(e) => setPickup(e.target.value)} placeholder="Airport arrivals, terminal…" /></label><label>Drop-off address <input required value={dropoff} onChange={(e) => setDropoff(e.target.value)} placeholder="Hotel or destination" /></label><label className="form-full">Driver / passenger notes <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" /></label></div>
        {error && <div className="form-error"><AlertCircle size={15} />{error}</div>}<div className="dialog-actions"><button type="button" className="button-quiet" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="button-primary" disabled={create.isPending}>{create.isPending ? 'Assigning…' : 'Confirm assignment'}</button></div>
      </form>}
  </div>;
}

export function ItineraryPage() {
  useAgencyRealtime();
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';
  const queryClient = useQueryClient();
  const itinerary = useGetItinerary(id, { query: { queryKey: getGetItineraryQueryKey(id), refetchOnMount: 'always' } });
  const updateTracking = useUpdateFleetTrackingState();
  const data = itinerary.data;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getGetItineraryQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: getListItinerariesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  };
  return <div className="workspace-page">
    <div className="backline"><Link href="/dashboard" className="back-link"><ChevronLeft size={15} /> All bookings</Link><span>ITINERARY CONTROL</span></div>
    {itinerary.isLoading && <div className="detail-loading"><SkeletonBlock lines={5} /><SkeletonBlock lines={3} /></div>}
    {itinerary.isError && <ErrorPanel message="This itinerary could not be found or loaded." retry={() => void itinerary.refetch()} />}
    {data && <>
      <div className="itinerary-hero">
        <div><div className="section-kicker">ITINERARY · {data.itinerary_ref}</div><h1>{data.client_name}</h1><p>{data.client_email}</p></div>
        <div className="hero-statuses"><span className={`status-chip status-${data.status}`}>{humanize(data.status)}</span><span className="assignment-pill"><CarFront size={14} /> {data.assignment_count} transfers</span></div>
      </div>
      <section className="panel-card segments-panel"><div className="panel-heading"><div><span className="section-kicker">FLIGHT PLAN</span><h2>Journey segments</h2></div><span className="segment-total">{data.flight_data?.segments?.length ?? 0} SEGMENTS</span></div>
        {!data.flight_data?.segments?.length ? <div className="empty-inline">No flight segments are attached to this itinerary.</div> : <div className="journey-list">{data.flight_data.segments.map((segment, index) => <div className="journey-row" key={`${segment.flight_number}-${index}`}><div className="journey-time"><b>{dateLabel(segment.departure_time).split(',')[1]?.trim() || dateLabel(segment.departure_time)}</b><small>{compactDate(segment.departure_time)}</small></div><div className="journey-route"><div className="airport-code-block"><b>{segment.origin}</b><small>DEPARTURE</small></div><div className="route-rule"><span /><small>{segment.flight_number || 'FLIGHT'}</small><ArrowRight size={14} /></div><div className="airport-code-block"><b>{segment.destination}</b><small>ARRIVAL</small></div></div><div className="journey-meta"><span>{segment.airline || 'Airline not listed'}</span><span>{segment.terminal || 'Terminal not listed'}</span></div></div>)}</div>}
      </section>
      <section className="transfer-section">
        <div className="section-heading-row"><div><span className="section-kicker">GROUND OPERATIONS</span><h2>Transfers & fleet</h2></div><span className="section-heading-aside">Airport pickup · client drop-off</span></div>
        <AssignmentForm itineraryId={data.id} clientEmail={data.client_email} departureAt={data.departure_at} arrivalAt={data.arrival_at} refresh={refresh} />
        <div className="transfer-list">
          {(data.fleet_assignments ?? []).length === 0 ? <div className="empty-card transfer-empty"><span className="empty-icon-warm"><CarFront size={18} /></span><strong>No transfer assigned yet</strong><p>Check vehicle availability above, then assign a driver and journey times.</p></div> : data.fleet_assignments.map((assignment) => <article className="transfer-card" key={assignment.id}>
            <div className="transfer-card-head"><span className="transfer-vehicle"><CarFront size={17} /><b>{assignment.vehicle_registration}</b></span><label className={`tracking-control tracking-${assignment.tracking_state}`}><span>{humanize(assignment.tracking_state)}</span><ChevronDown size={13} /><select aria-label={`Tracking status for ${assignment.vehicle_registration}`} value={assignment.tracking_state} disabled={updateTracking.isPending} onChange={(event) => updateTracking.mutate({ id: assignment.id, data: { tracking_state: event.target.value as FleetAssignmentTrackingState } }, { onSuccess: refresh })}>{trackingStates.map((state) => <option key={state} value={state}>{humanize(state)}</option>)}</select></label></div>
            <div className="transfer-driver"><span className="agent-avatar small">{initials(assignment.driver_name)}</span><span><b>{assignment.driver_name}</b><small>{assignment.driver_contact || 'No contact supplied'}</small></span></div>
            <div className="transfer-route"><div><span className="route-dot pickup" /><small>PICK UP · {dateLabel(assignment.pickup_at)}</small><b>{assignment.pickup_address}</b></div><ArrowDownRight size={15} /><div><span className="route-dot dropoff" /><small>DROP OFF · {dateLabel(assignment.dropoff_at)}</small><b>{assignment.dropoff_address}</b></div></div>
          </article>)}
        </div>
        {updateTracking.isError && <div className="form-error"><AlertCircle size={15} />Could not update transfer status. Try changing it again.</div>}
      </section>
    </>}
  </div>;
}

const requestTypes: DsrRequestInputRequestType[] = ['access', 'erasure', 'correction', 'objection'];
const dsrFilterOptions: (ListDsrRequestsStatus | 'all')[] = ['all', 'pending', 'verified', 'processing', 'completed', 'rejected'];
export function PrivacyDeskPage() {
  useAgencyRealtime();
  const [filter, setFilter] = useState<ListDsrRequestsStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const params = useMemo(() => ({ page, limit: 10, ...(filter === 'all' ? {} : { status: filter }) }), [page, filter]);
  const list = useListDsrRequests(params, { query: { queryKey: getListDsrRequestsQueryKey(params), refetchOnMount: 'always' } });
  const update = useUpdateDsrRequest();
  const queryClient = useQueryClient();
  const dsrs = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / (list.data?.limit ?? 10)));
  function updateStatus(request: DsrRequest, status: DsrRequestUpdateStatus) {
    update.mutate({ id: request.id, data: { status, notes: request.notes } }, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: getListDsrRequestsQueryKey(params) }); void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); } });
  }
  return <div className="workspace-page">
    <PageHeading kicker="POPIA · DATA SUBJECT RIGHTS" title="Privacy desk." description="Review verification, progress and completion of data-subject requests." actions={<Link href="/privacy/request" className="button-outline" data-testid="link-public-request"><ArrowUpRight size={15} /> Public request form</Link>} />
    <div className="privacy-callout"><span className="privacy-icon"><ShieldCheck size={18} /></span><div><b>Handle every request with care.</b><p>Confirm identity before processing access or erasure requests. Record a clear resolution before marking one complete.</p></div><span className="privacy-law">POPIA · 2020</span></div>
    <div className="list-toolbar"><div className="filter-pills" role="group" aria-label="Filter privacy requests">{dsrFilterOptions.map((option) => <button type="button" key={option} className={filter === option ? 'selected' : ''} onClick={() => { setFilter(option); setPage(1); }}>{option === 'all' ? 'All requests' : humanize(option)}</button>)}</div><span className="list-count">{list.data?.total ?? '—'} REQUESTS</span></div>
    {list.isLoading && <div className="privacy-loading"><SkeletonBlock lines={4} /><SkeletonBlock lines={4} /></div>}
    {list.isError && <ErrorPanel message="Privacy requests could not be loaded. Check your staff session and retry." retry={() => void list.refetch()} />}
    {!list.isLoading && !list.isError && dsrs.length === 0 && <div className="empty-card privacy-empty"><span className="empty-icon-warm"><FileKey2 size={18} /></span><strong>{filter === 'all' ? 'The privacy queue is clear' : `No ${humanize(filter)} requests`}</strong><p>New public data-subject requests will appear here after submission.</p></div>}
    {!list.isLoading && dsrs.length > 0 && <div className="dsr-list">{dsrs.map((request) => <article className="dsr-card" key={request.id} data-testid={`card-dsr-${request.id}`}><div className="dsr-card-top"><div className="dsr-subject"><span className="subject-avatar">{initials(request.subject_name || request.subject_email)}</span><span><b>{request.subject_name || 'Name not provided'}</b><small>{request.subject_email}</small></span></div><span className={`status-chip status-${request.status}`}>{humanize(request.status)}</span></div><div className="dsr-facts"><span><small>REQUEST TYPE</small><b>{humanize(request.request_type)}</b></span><span><small>SUBMITTED</small><b>{dateLabel(request.created_at)}</b></span><span><small>VERIFIED</small><b>{request.verified_at ? dateLabel(request.verified_at) : 'Awaiting verification'}</b></span></div>
      {request.notes && <p className="dsr-notes">{request.notes}</p>}
      <div className="dsr-card-bottom"><span>{request.completed_at ? `Completed ${dateLabel(request.completed_at)}` : 'Status updates are recorded with the request.'}</span><label className="dsr-status-control">Update status <select value={request.status} disabled={update.isPending || request.status === 'pending'} onChange={(event) => updateStatus(request, event.target.value as DsrRequestUpdateStatus)}>{request.status === 'pending' && <option value="pending">pending · awaiting email</option>}{dsrStatuses.map((status) => <option value={status} key={status}>{humanize(status)}</option>)}</select></label></div>
    </article>)}</div>}
    {pages > 1 && <div className="pagination"><button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={15} /> Previous</button><span>PAGE {page} OF {pages}</span><button type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next <ChevronRight size={15} /></button></div>}
    {update.isError && <div className="form-error"><AlertCircle size={15} />Request status did not update. Please retry.</div>}
  </div>;
}

export function PublicPrivacyRequestPage() {
  const create = useCreateDsrRequest();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [type, setType] = useState<DsrRequestInputRequestType>('access');
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [submission, setSubmission] = useState<{ sent: boolean; message: string } | null>(null);
  const [error, setError] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    create.mutate({ data: { subject_email: email.trim(), subject_name: name.trim() || null, request_type: type } }, { onSuccess: (result) => setSubmission({ sent: result.verification_email_sent, message: result.message }), onError: (reason) => setError(reason instanceof Error ? reason.message : 'Request could not be submitted. Please try again.') });
  }
  return <div className="public-privacy-page"><header className="public-privacy-top"><Link href="/" className="agency-brand"><span className="agency-brand-mark"><Plane size={17} /></span><span className="agency-brand-copy"><strong>SA TRAVEL</strong><small>PRIVACY CENTRE</small></span></Link><span>POPIA · DATA RIGHTS</span></header>
    <main className="public-privacy-main"><div className="public-side-copy"><div className="section-kicker">YOUR INFORMATION · YOUR CHOICE</div><h1>A clear way to exercise your rights.</h1><p>Submit a request relating to personal information held by SA Travel. We will email you a verification link before our team begins processing it.</p><div className="public-promise"><ShieldCheck size={18} /><span><b>Verification comes first.</b><small>We use your email to verify your identity and keep you informed about your request.</small></span></div></div>
      <section className="public-form-card">{submission ? <div className="success-state"><span className="success-seal">{submission.sent ? <Check size={22} /> : <AlertCircle size={22} />}</span><div className="section-kicker">REQUEST RECEIVED</div><h2>{submission.sent ? 'Check your inbox.' : 'Request recorded.'}</h2><p>{submission.message}</p><Link href="/" className="text-action">Return to sign in <ArrowRight size={14} /></Link></div> : <><div className="section-kicker">SUBMIT A REQUEST</div><h2>How can we help?</h2><p>Fields marked with an asterisk are required.</p><form className="public-form" onSubmit={submit}><label>Your name <span>OPTIONAL</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="Name as held by SA Travel" /></label><label>Email address <b>*</b><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} placeholder="you@example.com" /></label><label>Request type <b>*</b><select required value={type} onChange={(e) => setType(e.target.value as DsrRequestInputRequestType)}>{requestTypes.map((value) => <option value={value} key={value}>{humanize(value)}</option>)}</select></label><label className="consent-check"><input type="checkbox" required checked={consentConfirmed} onChange={(e) => setConsentConfirmed(e.target.checked)} /><span>I confirm this request concerns my personal information or that I am authorised to act on the subject’s behalf.</span></label>{error && <div className="form-error"><AlertCircle size={15} />{error}</div>}<button className="button-primary" disabled={create.isPending}>{create.isPending ? 'Submitting request…' : <>Send verification email <ArrowRight size={15} /></>}</button></form><div className="public-form-foot"><FileKey2 size={13} /> We do not request identity documents through this form.</div></>}</section></main>
    <footer className="public-footer"><span>SA TRAVEL · PRIVACY CENTRE</span><Link href="/">STAFF SIGN IN <ArrowUpRight size={11} /></Link></footer></div>;
}

export function VerifyPrivacyPage() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? '';
  const result = useVerifyDsrToken(token, { query: { queryKey: ['/api/popia/verify', token], enabled: Boolean(token), retry: false } });
  return <div className="verify-scene"><Link href="/privacy/request" className="agency-brand"><span className="agency-brand-mark"><ShieldCheck size={17} /></span><span className="agency-brand-copy"><strong>SA TRAVEL</strong><small>PRIVACY CENTRE</small></span></Link><section className="verify-card">
    <span className={`verify-seal${result.data?.verified ? ' verified' : ''}`}>{result.isLoading ? <RefreshCw size={22} /> : result.data?.verified ? <Check size={23} /> : <FileKey2 size={22} />}</span>
    <div className="section-kicker">EMAIL VERIFICATION</div>
    <h1>{result.isLoading ? 'Confirming your request…' : result.data?.verified ? 'Your email is verified.' : result.isError ? 'This link could not be verified.' : 'Request verification'}</h1>
    <p>{result.isLoading ? 'We are checking the verification link with the privacy service.' : result.data?.message || (result.isError ? 'The link may have expired or already been used. Please submit a new request or contact the agency.' : 'Use the verification link sent to your email to confirm your identity.')}</p>
    {result.data?.request_id && <span className="verification-ref">REFERENCE · {result.data.request_id}</span>}
    <Link href="/privacy/request" className="button-outline">Return to privacy centre <ArrowRight size={14} /></Link>
  </section><span className="verify-foot">SA TRAVEL · DATA SUBJECT REQUESTS</span></div>;
}

