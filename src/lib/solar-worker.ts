const IE_POWER_PER_HOUR = 4;
const SAFETY_MARGIN = 1.3;

function simulate(netLoad: number[], totalCapacityWh: number): boolean {
    let charge = totalCapacityWh;
    for (const net of netLoad) {
        charge -= net;
        charge = Math.min(charge, totalCapacityWh); // ceiling: can't exceed full
        if (charge < 0) return false;
    }
    return true;
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
        batteriesWithoutSolar
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
    } = e.data;

    const hourlyLoad = devices * IE_POWER_PER_HOUR * SAFETY_MARGIN; // Wh per hour (constant)
    const numAvgDays = numDays - numWorstDays;

    // Precompute net load: positive = battery drains, negative = battery charges
    // Solar output (Wh) = irradiance (kWh/m²) * panelRatingW * numPanels * systemEfficiency
    // (irradiance/1000 normalizes to STC 1000 W/m², then * 1000 for Wh → cancels out)
    const netLoad: number[] = [];
    for (let d = 0; d < numAvgDays; d++) {
        for (let h = 0; h < 24; h++) {
            netLoad.push(hourlyLoad - solarAvg[h] * panelRatingW * numPanels * systemEfficiency);
        }
    }
    for (let d = 0; d < numWorstDays; d++) {
        for (let h = 0; h < 24; h++) {
            netLoad.push(hourlyLoad - solarWorst[h] * panelRatingW * numPanels * systemEfficiency);
        }
    }

    // Lower bound: minimum batteries assuming perfect storage (no ceiling losses)
    const totalSolarWh = solarAvg.reduce((s, v) => s + v, 0) * panelRatingW * numPanels * systemEfficiency * numDays;
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

    self.postMessage(result);
};
