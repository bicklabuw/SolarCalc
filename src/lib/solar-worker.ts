function simulate(netLoad: number[], totalCapacityWh: number): boolean {
	let charge = totalCapacityWh;
	for (const net of netLoad) {
		charge -= net;
		charge = Math.min(charge, totalCapacityWh);
		if (charge < 0) return false;
	}
	return true;
}

function simulateHistory(netLoad: number[], totalCapacityWh: number): number[] {
	let charge = totalCapacityWh;
	const history: number[] = [];
	for (const net of netLoad) {
		charge -= net;
		charge = Math.min(charge, totalCapacityWh);
		if (charge < 0) charge = 0;
		history.push(charge);
	}
	return history;
}

self.onmessage = (e: MessageEvent) => {
	const {
		devices,
		numDays,
		numWorstDays,
		solarAvg,
		solarWorst,
		numPanels,
		panelRatingW,
		systemEfficiency,
		batteryCapacity,
		batteriesWithoutSolar,
		devicePowerW,
		safetyMargin
	}: {
		devices: number;
		numDays: number;
		numWorstDays: number;
		solarAvg: number[];
		solarWorst: number[];
		numPanels: number;
		panelRatingW: number;
		systemEfficiency: number;
		batteryCapacity: number;
		batteriesWithoutSolar: number;
		devicePowerW: number;
		safetyMargin: number;
	} = e.data;

	const hourlyLoad = devices * devicePowerW * safetyMargin;
	const numAvgDays = numDays - numWorstDays;

	// Precompute net load: positive = battery drains, negative = battery charges
	// Solar output (Wh) = irradiance (kWh/m²) * panelRatingW * numPanels * systemEfficiency
	const netLoad: number[] = [];
	for (let d = 0; d < numAvgDays; d++) {
		for (let h = 0; h < 24; h++) {
			netLoad.push(hourlyLoad - (solarAvg[h] / 1000) * panelRatingW * numPanels * systemEfficiency);
		}
	}
	for (let d = 0; d < numWorstDays; d++) {
		for (let h = 0; h < 24; h++) {
			netLoad.push(
				hourlyLoad - (solarWorst[h] / 1000) * panelRatingW * numPanels * systemEfficiency
			);
		}
	}

	// Lower bound: minimum batteries assuming perfect storage (no ceiling losses)
	const totalSolarWh =
		solarAvg.reduce((s, v) => s + v, 0) * panelRatingW * numPanels * systemEfficiency * numDays;
	const totalLoadWh = hourlyLoad * 24 * numDays;
	const lowerBound = Math.max(1, Math.ceil((totalLoadWh - totalSolarWh) / batteryCapacity));

	// Binary search over [lowerBound, batteriesWithoutSolar]
	let lo = lowerBound;
	let hi = batteriesWithoutSolar;
	let result = hi;

	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (simulate(netLoad, mid * batteryCapacity)) {
			result = mid;
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}

	const chargeHistory = simulateHistory(netLoad, result * batteryCapacity);
	self.postMessage({ batteries: result, chargeHistory });
};
