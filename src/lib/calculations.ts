const SAFETY_MARGIN = 1.3;

export type GroupOutput = {
	devices: number;
	totalEnergyWh: number;
	dailyEnergyWh: number;
	numBatteriesNeededNoSolar: number;
	numSolarPanels?: number;
	numBatteriesNeededWithSolar?: number;
	chargeHistory?: number[];
};

export type TotalOutput = {
	groups: GroupOutput[];
	powerPerDay: number;
	totalPower: number;
};

function getNumDays(start: string, end: string): number {
	const parse = (d: string) => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
	return Math.round((parse(end).getTime() - parse(start).getTime()) / 86400000) + 1;
}

export function calculateBatteryOnly(
	startDate: string,
	endDate: string,
	devicesPerGroup: number[],
	batteryCapacity: number,
	devicePowerW: number
): TotalOutput {
	const lengthOfExperiment = getNumDays(startDate, endDate);
	const powerPerDay = 24 * devicePowerW;
	const groups: GroupOutput[] = devicesPerGroup.map((devices) => {
		const dailyEnergyWh = devices * powerPerDay * SAFETY_MARGIN;
		const totalEnergyWh = dailyEnergyWh * lengthOfExperiment;
		const numBatteriesNeededNoSolar = Math.ceil(totalEnergyWh / batteryCapacity);
		return { devices, dailyEnergyWh, totalEnergyWh, numBatteriesNeededNoSolar };
	});
	return {
		groups,
		powerPerDay: groups.reduce((sum, g) => sum + g.dailyEnergyWh, 0),
		totalPower: groups.reduce((sum, g) => sum + g.totalEnergyWh, 0)
	};
}

const SYSTEM_EFFICIENCY = 0.8;

export async function calculateWithSolar(
	startDate: string,
	endDate: string,
	devicesPerGroup: number[],
	batteryCapacity: number,
	solarData: { average: number[]; worst: number[] },
	numWorstDays: number,
	panelRatingW: number,
	numPanelsPerGroup: number[],
	devicePowerW: number
): Promise<TotalOutput> {
	const batteriesOnly = calculateBatteryOnly(startDate, endDate, devicesPerGroup, batteryCapacity, devicePowerW);
	const numDays = getNumDays(startDate, endDate);
	const { average, worst } = solarData;

	const workerResults = await Promise.all(
		batteriesOnly.groups.map(
			(group, i) =>
				new Promise<{ batteries: number; chargeHistory: number[] }>((resolve, reject) => {
					const worker = new Worker(new URL('./solar-worker.ts', import.meta.url), {
						type: 'module'
					});
					worker.postMessage({
						devices: group.devices,
						numDays,
						numWorstDays,
						solarAvg: average,
						solarWorst: worst,
						numPanels: numPanelsPerGroup[i],
						panelRatingW,
						systemEfficiency: SYSTEM_EFFICIENCY,
						batteryCapacity,
						batteriesWithoutSolar: group.numBatteriesNeededNoSolar,
						devicePowerW
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

	batteriesOnly.groups.forEach((group, i) => {
		group.numSolarPanels = numPanelsPerGroup[i];
		group.numBatteriesNeededWithSolar = workerResults[i].batteries;
		group.chargeHistory = workerResults[i].chargeHistory;
	});

	return batteriesOnly;
}

/**
 * Fetches hourly solar irradiance from NASA POWER API and returns average and
 * worst-case profiles (one value per hour of the day, across 3 years).
 */
export async function getAvgSunHours(
	lat: number,
	long: number,
	startDate: string,
	endDate: string
): Promise<{ average: number[]; worst: number[] }> {
	const YEARS = [2023, 2024, 2025] as const;

	const mmdd = (date: string) => date.replace(/-/g, '').slice(4);

	const getHourlyDataByYear = async (year: number): Promise<Record<string, number>> => {
		const start = `${year}${mmdd(startDate)}`;
		const end = `${year}${mmdd(endDate)}`;
		const url = `https://power.larc.nasa.gov/api/temporal/hourly/point?parameters=ALLSKY_SFC_SW_DWN&community=RE&longitude=${long}&latitude=${lat}&start=${start}&end=${end}&format=JSON`;
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`NASA POWER API error ${response.status} for year ${year}`);
		}
		const data = await response.json();
		return data.properties.parameter.ALLSKY_SFC_SW_DWN;
	};

	const results = await Promise.all(YEARS.map(getHourlyDataByYear));

	const hourBuckets: number[][] = Array.from({ length: 24 }, () => []);

	for (const hourlyData of results) {
		for (const [key, value] of Object.entries(hourlyData)) {
			if (value === -999) continue;
			const hour = parseInt(key.slice(-2), 10);
			if (isNaN(hour) || hour < 0 || hour > 23) continue;
			hourBuckets[hour].push(value);
		}
	}

	const average: number[] = new Array(24).fill(-1);
	const worst: number[] = new Array(24).fill(-1);
	for (let i = 0; i < 24; i++) {
		const values = hourBuckets[i];
		if (values.length === 0) throw new Error(`No valid solar data for hour ${i}`);
		average[i] = values.reduce((sum, v) => sum + v, 0) / values.length;
		worst[i] = Math.min(...values);
	}
	return { average, worst };
}

// Module-level cache keyed on "lat,long,startDate,endDate"
const solarCache = new Map<string, { average: number[]; worst: number[] }>();

export async function getSolarData(
	lat: number,
	long: number,
	startDate: string,
	endDate: string
): Promise<{ average: number[]; worst: number[] }> {
	const key = `${lat},${long},${startDate},${endDate}`;
	if (solarCache.has(key)) return solarCache.get(key)!;
	const data = await getAvgSunHours(lat, long, startDate, endDate);
	solarCache.set(key, data);
	return data;
}
