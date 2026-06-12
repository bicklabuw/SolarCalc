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
		irradianceSeq,
		panelRatingW,
		numPanels,
		solarEfficiency,
		circuitEfficiency,
		devices,
		devicePowerW,
		safetyMargin
	}: {
		irradianceSeq: number[]; // one irradiance value (Wh/m^2) per hour of the run
		panelRatingW: number;
		numPanels: number;
		solarEfficiency: number;
		circuitEfficiency: number;
		devices: number;
		devicePowerW: number;
		safetyMargin: number;
	} = e.data;

	// Load the battery must supply each hour (includes safety margin + circuit loss).
	const hourlyLoad = (devices * devicePowerW * safetyMargin) / circuitEfficiency;

	// Net load per hour: positive drains the battery, negative charges it.
	// Solar output (Wh) = (irradiance / 1000) * panelRatingW * numPanels * solarEfficiency
	const netLoad = irradianceSeq.map(
		(irr) => hourlyLoad - (irr / 1000) * panelRatingW * numPanels * solarEfficiency
	);

	// Smallest battery capacity (Wh) that keeps the charge from hitting zero.
	// Monotonic in capacity, so a continuous binary search is valid.
	let lo = 0;
	let hi = 1;
	while (!simulate(netLoad, hi)) hi *= 2;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (simulate(netLoad, mid)) hi = mid;
		else lo = mid;
	}
	const minCapacityWh = hi;
	const chargeHistory = simulateHistory(netLoad, minCapacityWh);
	self.postMessage({ minCapacityWh, chargeHistory });
};
