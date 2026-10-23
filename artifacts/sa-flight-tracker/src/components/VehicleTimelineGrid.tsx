import { CarFront } from 'lucide-react';

const SLOT_WIDTH = 48;
const SLOT_COUNT = 48;
const VEHICLE_COL_WIDTH = 200;
const ROW_HEIGHT = 56;
const HEADER_HEIGHT = 40;
const SLOT_MS = 30 * 60 * 1000;

export type TimelineAssignment = {
  id: string;
  vehicle_id: string;
  vehicle_registration: string;
  driver_name: string;
  pickup_at: string;
  dropoff_at: string;
  tracking_state: string;
};

export type TimelineVehicle = {
  vehicle: {
    id: string;
    registration: string;
    make_model: string;
    capacity: number;
    active: boolean;
  };
  available: boolean;
  conflicts: TimelineAssignment[];
};

type Props = {
  rows: TimelineVehicle[];
  dayStart: string;
  flightStart?: string | null;
  flightEnd?: string | null;
  onSlotClick: (vehicle: TimelineVehicle['vehicle'], slotTime: Date) => void;
};

function minutesFromDayStart(value: string, dayStartMs: number): number {
  return (new Date(value).getTime() - dayStartMs) / 60_000;
}

function slotLabel(index: number): string {
  const hour = String(Math.floor(index / 2)).padStart(2, '0');
  return `${hour}:00`;
}

export function VehicleTimelineGrid({ rows, dayStart, flightStart, flightEnd, onSlotClick }: Props) {
  const dayStartMs = new Date(dayStart).getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  const windowStart = flightStart ? Math.max(dayStartMs, new Date(flightStart).getTime()) : dayStartMs;
  const windowEnd = flightEnd ? Math.min(dayEndMs, new Date(flightEnd).getTime()) : dayEndMs;
  const showFlightWindow = Boolean(flightStart && flightEnd && windowEnd > windowStart);
  const flightLeft = VEHICLE_COL_WIDTH + ((windowStart - dayStartMs) / SLOT_MS) * SLOT_WIDTH;
  const flightWidth = ((windowEnd - windowStart) / SLOT_MS) * SLOT_WIDTH;
  const now = new Date();
  const currentLineMinutes = (now.getTime() - dayStartMs) / 60_000;
  const showCurrentLine = currentLineMinutes >= 0 && currentLineMinutes < 1440;
  const currentLeft = VEHICLE_COL_WIDTH + (currentLineMinutes / 30) * SLOT_WIDTH;

  return <section className="timeline-panel" aria-label="Vehicle availability timeline">
    <div className="timeline-heading">
      <div><span className="section-kicker">VEHICLE SCHEDULE · JOHANNESBURG TIME</span><h3>Pick a free transfer window</h3></div>
      <div className="timeline-key"><span><i className="timeline-key-free" />Free slot</span><span><i className="timeline-key-booked" />Existing transfer</span></div>
    </div>
    {rows.length === 0 ? <div className="empty-inline"><CarFront size={15} /> No active fleet vehicles are configured yet.</div> :
      <div className="timeline-scroll" role="region" aria-label="Scroll horizontally through the 24-hour vehicle schedule">
        <div className="timeline-inner" style={{ minHeight: HEADER_HEIGHT + rows.length * ROW_HEIGHT }}>
          <div className="timeline-header">
            <div className="timeline-sticky timeline-vehicle-heading">VEHICLE</div>
            {Array.from({ length: SLOT_COUNT }, (_, index) => <div className="timeline-hour" key={index}>{index % 2 === 0 ? slotLabel(index) : ''}</div>)}
          </div>
          {showFlightWindow && <div className="timeline-flight-window" aria-label="Itinerary flight time window" style={{ left: flightLeft, width: flightWidth }} />}
          {rows.map((item, rowIndex) => <div className="timeline-row" key={item.vehicle.id}>
            <div className="timeline-sticky timeline-vehicle-info">
              <span className="timeline-car-icon"><CarFront size={14} /></span>
              <span className="timeline-vehicle-copy"><b>{item.vehicle.registration}</b><small>{item.vehicle.make_model} · {item.vehicle.capacity} seats</small></span>
            </div>
            {Array.from({ length: SLOT_COUNT }, (_, slotIndex) => {
              const slotStart = new Date(dayStartMs + slotIndex * SLOT_MS);
              const slotEnd = new Date(slotStart.getTime() + SLOT_MS);
              const conflict = item.conflicts.some((assignment) =>
                slotStart.getTime() < new Date(assignment.dropoff_at).getTime() &&
                slotEnd.getTime() > new Date(assignment.pickup_at).getTime(),
              );
              const localSlot = new Intl.DateTimeFormat('en-ZA', {
                hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg',
              }).format(slotStart);
              return <button
                className={`timeline-slot${conflict ? ' timeline-slot-blocked' : ''}`}
                key={slotIndex}
                type="button"
                disabled={conflict}
                aria-label={`${item.vehicle.registration}, ${localSlot}, ${conflict ? 'unavailable' : 'available'}`}
                title={`${item.vehicle.registration} · ${localSlot}${conflict ? ' · unavailable' : ' · select pickup time'}`}
                onClick={() => onSlotClick(item.vehicle, slotStart)}
              />;
            })}
          </div>)}
          {rows.flatMap((item, rowIndex) => item.conflicts.map((assignment) => {
            const start = Math.max(dayStartMs, new Date(assignment.pickup_at).getTime());
            const end = Math.min(dayEndMs, new Date(assignment.dropoff_at).getTime());
            if (end <= start) return null;
            const left = VEHICLE_COL_WIDTH + ((start - dayStartMs) / SLOT_MS) * SLOT_WIDTH + 2;
            const width = Math.max(14, ((end - start) / SLOT_MS) * SLOT_WIDTH - 4);
            return <div
              key={`${item.vehicle.id}-${assignment.id}`}
              className={`timeline-assignment timeline-assignment-${assignment.tracking_state}`}
              style={{ left, width, top: HEADER_HEIGHT + rowIndex * ROW_HEIGHT + 6 }}
              title={`${item.vehicle.registration} · ${assignment.driver_name} · ${assignment.tracking_state.replaceAll('_', ' ')}`}
            >
              <b>{assignment.vehicle_registration}</b><span>{assignment.driver_name}</span>
            </div>;
          }))}
          {showCurrentLine && <div className="timeline-current-line" style={{ left: currentLeft }} aria-label="Current South African time" />}
        </div>
      </div>}
    <p className="timeline-footnote">Select a clear 30-minute slot to start a transfer. The pickup and drop-off times remain editable; the server checks conflicts again when you save.</p>
  </section>;
}
