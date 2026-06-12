import SolarWorker from './solar-worker.ts?worker';

export type GroupOutput = {
	devices: number;
	dailyEnergyWh: number;
	totalEnergyWh: number; // energy over the whole experiment = battery-only no-recharge capacity
	rechargesNeeded?: number; // battery-only: recharges/swaps if the user supplied a battery capacity
	minCapacityWh?: number; // solar: smallest battery capacity (Wh) that survives this scenario
	numSolarPanels?: number;
	chargeHistory?: number[]; // solar: charge trace at minCapacityWh
};

export type TotalOutput = {
	groups: GroupOutput[];
	powerPerDay: number;
	totalPower: number;
};

export type SolarData = { average: number[]; worstDays: number[][] };

function getNumDays(start: string, end: string): number {
	const parse = (d: string) => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
	return Math.round((parse(end).getTime() - parse(start).getTime()) / 86400000) + 1;
}

// Solar generation loss (PV-side wiring, MPPT / charge-controller, soiling,
// temperature). Applied to solar output only.
export const SOLAR_EFFICIENCY = 0.8;

// Circuit / discharge loss (wiring voltage drop, connectors, conversion, battery
// internal resistance and self-discharge). Usable battery energy is treated as
// ~85% of nameplate capacity. Applied to the load in both battery-only and solar
// modes (so it shows up in the reported energy figures, not just the sizing).
export const CIRCUIT_EFFICIENCY = 0.85;

/**
 * Battery-only sizing. Always reports the minimum capacity needed to run the whole
 * experiment with no recharges; if a battery capacity is supplied, also reports how
 * many times that battery must be recharged/swapped.
 */
export function calculateBatteryOnly(
	startDate: string,
	endDate: string,
	devicesPerGroup: number[],
	devicePowerW: number,
	safetyMargin: number = 1.3,
	batteryCapacity?: number
): TotalOutput {
	const lengthOfExperiment = getNumDays(startDate, endDate);
	const powerPerDay = 24 * devicePowerW;
	const groups: GroupOutput[] = devicesPerGroup.map((devices) => {
		// Circuit efficiency is folded into the energy figure so it shows in the UI.
		const dailyEnergyWh = (devices * powerPerDay * safetyMargin) / CIRCUIT_EFFICIENCY;
		const totalEnergyWh = dailyEnergyWh * lengthOfExperiment;
		const rechargesNeeded =
			batteryCapacity && batteryCapacity > 0
				? Math.ceil(totalEnergyWh / batteryCapacity)
				: undefined;
		return { devices, dailyEnergyWh, totalEnergyWh, minCapacityWh: totalEnergyWh, rechargesNeeded };
	});
	return {
		groups,
		powerPerDay: groups.reduce((sum, g) => sum + g.dailyEnergyWh, 0),
		totalPower: groups.reduce((sum, g) => sum + g.totalEnergyWh, 0)
	};
}

/**
 * Solar sizing for one scenario. Builds the day-by-day irradiance sequence
 * (average days, then either the N distinct worst days or, for the stress test,
 * the single worst day repeated) and asks the worker for the smallest battery
 * capacity that survives.
 */
export async function calculateWithSolar(
	startDate: string,
	endDate: string,
	devicesPerGroup: number[],
	solarData: SolarData,
	numWorstDays: number,
	panelRatingW: number,
	numPanelsPerGroup: number[],
	devicePowerW: number,
	safetyMargin: number = 1.3,
	scenario: 'nworst' | 'allworst' = 'nworst'
): Promise<TotalOutput> {
	const base = calculateBatteryOnly(
		startDate,
		endDate,
		devicesPerGroup,
		devicePowerW,
		safetyMargin
	);
	const numDays = getNumDays(startDate, endDate);
	const { average, worstDays } = solarData;

	// Build the per-day irradiance profiles for this scenario.
	const dayProfiles: number[][] = [];
	if (scenario === 'allworst') {
		const worst = worstDays[0] ?? average;
		for (let d = 0; d < numDays; d++) dayProfiles.push(worst);
	} else {
		const n = Math.min(Math.max(numWorstDays, 0), numDays);
		const avgCount = numDays - n;
		for (let d = 0; d < avgCount; d++) dayProfiles.push(average);
		for (let k = 0; k < n; k++) {
			// Use the k-th worst distinct day; fall back to the worst available if we run out.
			dayProfiles.push(worstDays[Math.min(k, worstDays.length - 1)] ?? average);
		}
	}
	const irradianceSeq = dayProfiles.flat();

	const workerResults = await Promise.all(
		base.groups.map(
			(group, i) =>
				new Promise<{ minCapacityWh: number; chargeHistory: number[] }>((resolve, reject) => {
					const worker = new SolarWorker();
					worker.postMessage({
						irradianceSeq,
						panelRatingW,
						numPanels: numPanelsPerGroup[i],
						solarEfficiency: SOLAR_EFFICIENCY,
						circuitEfficiency: CIRCUIT_EFFICIENCY,
						devices: group.devices,
						devicePowerW,
						safetyMargin
					});
					worker.onmessage = (e) => {
						resolve(e.data);
						worker.terminate();
					};
					worker.onerror = (e) => {
						reject(new Error(e.message));
						worker.terminate();
					};
				})
		)
	);

	base.groups.forEach((group, i) => {
		group.numSolarPanels = numPanelsPerGroup[i];
		group.minCapacityWh = workerResults[i].minCapacityWh;
		group.chargeHistory = workerResults[i].chargeHistory;
	});

	return base;
}

/**
 * Fetches hourly solar irradiance from NASA POWER and returns an average hourly
 * profile (over the experiment's seasonal window) plus a ranked list of the
 * distinct worst real days, searched over a widened window so that short
 * experiments still draw from a fair sample.
 */
export async function getAvgSunHours(
	lat: number,
	long: number,
	startDate: string,
	endDate: string
): Promise<SolarData> {
	// Three most recent complete calendar years (current year excluded; advances automatically).
	const lastComplete = new Date().getFullYear() - 1;
	const YEARS = [lastComplete - 2, lastComplete - 1, lastComplete];

	const expMMDDStart = startDate.slice(4);
	const expMMDDEnd = endDate.slice(4);
	const expDays = getNumDays(startDate, endDate);

	// Widen the worst-day search window to at least MIN_WINDOW days, centred on the
	// experiment. Clamp at the calendar-year edges to keep a single in-year request.
	const MIN_WINDOW = 28;
	const pad = Math.max(0, Math.ceil((MIN_WINDOW - expDays) / 2));
	const REF = 2024; // leap year, so Feb 29 is representable
	const toRef = (mmdd: string) => new Date(REF, +mmdd.slice(0, 2) - 1, +mmdd.slice(2, 4));
	const fmt = (d: Date) =>
		`${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
	const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

	let wStart = addDays(toRef(expMMDDStart), -pad);
	let wEnd = addDays(toRef(expMMDDEnd), pad);
	if (wStart.getFullYear() < REF) wStart = new Date(REF, 0, 1);
	if (wEnd.getFullYear() > REF) wEnd = new Date(REF, 11, 31);
	const winMMDDStart = fmt(wStart);
	const winMMDDEnd = fmt(wEnd);

	const getHourlyDataByYear = async (year: number): Promise<Record<string, number>> => {
		const start = `${year}${winMMDDStart}`;
		const end = `${year}${winMMDDEnd}`;
		const url = `https://power.larc.nasa.gov/api/temporal/hourly/point?parameters=ALLSKY_SFC_SW_DWN&community=RE&longitude=${long}&latitude=${lat}&start=${start}&end=${end}&format=JSON`;
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`NASA POWER API error ${response.status} for year ${year}`);
		}
		const data = await response.json();
		return data.properties.parameter.ALLSKY_SFC_SW_DWN;
	};

	const results = await Promise.all(YEARS.map(getHourlyDataByYear));

	// Group every returned hour by calendar day -> 24-hour profile.
	type Day = { mmdd: string; hours: (number | null)[] };
	const days: Day[] = [];
	const dayIndex = new Map<string, Day>();
	for (const hourlyData of results) {
		for (const [key, value] of Object.entries(hourlyData)) {
			const dayKey = key.slice(0, 8); // YYYYMMDD
			const hour = parseInt(key.slice(8, 10), 10);
			if (isNaN(hour) || hour < 0 || hour > 23) continue;
			let day = dayIndex.get(dayKey);
			if (!day) {
				day = { mmdd: dayKey.slice(4), hours: new Array(24).fill(null) };
				dayIndex.set(dayKey, day);
				days.push(day);
			}
			day.hours[hour] = value === -999 ? null : value;
		}
	}

	// Only consider days with near-complete data (avoids fake "worst" days from gaps).
	const validHours = (d: Day) => d.hours.filter((v) => v !== null).length;
	const usableDays = days.filter((d) => validHours(d) >= 20);
	if (usableDays.length === 0) throw new Error('No valid solar data returned for this location.');

	// Average hourly profile over the experiment's own seasonal window.
	const inExperimentWindow = (mmdd: string) =>
		expMMDDStart <= expMMDDEnd
			? mmdd >= expMMDDStart && mmdd <= expMMDDEnd
			: mmdd >= expMMDDStart || mmdd <= expMMDDEnd; // (defensive; experiments don't cross year end)
	const avgDays = usableDays.filter((d) => inExperimentWindow(d.mmdd));
	const sourceForAvg = avgDays.length > 0 ? avgDays : usableDays;
	const average: number[] = new Array(24).fill(0);
	for (let h = 0; h < 24; h++) {
		const vals = sourceForAvg.map((d) => d.hours[h]).filter((v): v is number => v !== null);
		average[h] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
	}

	// Rank distinct days by daily total irradiance (worst = lowest total first).
	const dailyTotal = (d: Day) => d.hours.reduce((s: number, v) => s + (v ?? 0), 0);
	const ranked = [...usableDays].sort((a, b) => dailyTotal(a) - dailyTotal(b));
	const worstDays = ranked.slice(0, 30).map((d) => d.hours.map((v) => v ?? 0));

	return { average, worstDays };
}

// Module-level cache keyed on "lat,long,startDate,endDate"
const solarCache = new Map<string, SolarData>();

export async function getSolarData(
	lat: number,
	long: number,
	startDate: string,
	endDate: string
): Promise<SolarData> {
	const key = `${lat},${long},${startDate},${endDate}`;
	if (solarCache.has(key)) return solarCache.get(key)!;
	const data = await getAvgSunHours(lat, long, startDate, endDate);
	solarCache.set(key, data);
	return data;
}
