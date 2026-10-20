// Flight-board filtering remains consistent as live snapshots arrive.
import type { FlightView } from '../../core/projection.ts';
export type FlightFilter = 'all' | 'airborne' | 'holding';
type SearchableFlight = Pick<FlightView, 'id' | 'title' | 'pilot' | 'phase'>;
export function filterFlights<T extends SearchableFlight>(flights: T[], query: string, filter: FlightFilter): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return flights.filter((flight) => {
    if (filter === 'airborne' && flight.phase !== 'airborne' && flight.phase !== 'holding') return false;
    if (filter === 'holding' && flight.phase !== 'holding') return false;
    const text = `${flight.id} ${flight.title} ${flight.pilot}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
