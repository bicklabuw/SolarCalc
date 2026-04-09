const IE_POWER_PER_HOUR = 4;
const IE_POWER_PER_DAY = 24 * IE_POWER_PER_HOUR; // Wh per device per day
const SAFETY_MARGIN = 1.3;


type groupOutput = {
    devices: number,
    totalEnergyWh: number,
    dailyEnergyWh: number,
   // minBatteryWh: number,        // battery-only mode: full experiment capacity needed: This is just totalEnergyWH
    numBatteriesNeededNoSolar: number,    // solar mode
    numSolarPanels?: number,
    numBatteriesNeededWithSolar?: number  // solar mode: run simulation to see minimum number of batteries needed

}

type totalOutput = {
    groups: groupOutput[],
    powerPerDay: number,
    totalPower: number,
}


function getNumDays(start: string, end: string): number {
    const parse = (d: string) => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
    return Math.round((parse(end).getTime() - parse(start).getTime()) / 86400000) + 1;
}

// inputs: # groups, # devices in each group, length of experiment in days
// also location with the location api, IF solarEnabled.
// why we do this: each group has a seperate battery, so we seperate results for each one
// total then just becomes the sum of energyPerDay and totalEnergy
// maybe we don't have user input # of devices in each group? And just split it optimally?
export function calculateBatteryOnly(
    startDate: string,
    endDate: string,
    devicesPerGroup: number[],
    batteryCapacity: number// defaults: 200, 500, 1000, 2000, 2500
    

): totalOutput {
    // get length of experiment by doing endDate - startDate
    const lengthOfExperiment = getNumDays(startDate, endDate); // change this
    const groups: groupOutput[] = devicesPerGroup.map((devices) => {
        const dailyEnergyWh = devices * IE_POWER_PER_DAY * SAFETY_MARGIN;
        const totalEnergyWh = dailyEnergyWh * lengthOfExperiment;
        const numBatteriesNeededNoSolar = Math.ceil(totalEnergyWh / batteryCapacity);
        return {devices, dailyEnergyWh, totalEnergyWh, numBatteriesNeededNoSolar};
    })
    return {
        groups,
        powerPerDay: groups.reduce((sum, g) => sum + g.dailyEnergyWh, 0),
        totalPower: groups.reduce((sum, g) => sum + g.totalEnergyWh, 0)
    };

}

const SYSTEM_EFFICIENCY = 0.80; // derate factor: inverter, wiring, soiling, temperature

export async function calculateWithSolar(
    startDate: string,
    endDate: string,
    devicesPerGroup: number[],
    batteryCapacity: number, // defaults: 200, 500, 1000, 2000, 2500,
    averagePerHr: number[],
    worstPerHr: number[],
    numWorstDays: number,
    panelRatingW: number, // defaults: 40, 100, 160, 200, 220
    numPanelsPerGroup: number[]
): Promise<totalOutput> {
    const batteriesOnly = calculateBatteryOnly(startDate, endDate, devicesPerGroup, batteryCapacity);
    const numDays = getNumDays(startDate, endDate);

    const workerResults = await Promise.all(
        batteriesOnly.groups.map((group, i) =>
            new Promise<number>((resolve, reject) => {
                const worker = new Worker(new URL('./solar-worker.ts', import.meta.url), { type: 'module' });
                worker.postMessage({
                    devices: group.devices,
                    numDays,
                    numWorstDays,
                    solarAvg: averagePerHr,
                    solarWorst: worstPerHr,
                    numPanels: numPanelsPerGroup[i],
                    panelRatingW,
                    systemEfficiency: SYSTEM_EFFICIENCY,
                    batteryCapacity,
                    batteriesWithoutSolar: group.numBatteriesNeededNoSolar
                });
                worker.onmessage = (e) => { resolve(e.data); worker.terminate(); };
                worker.onerror = (e) => { reject(new Error(e.message)); worker.terminate(); };
            })
        )
    );

    batteriesOnly.groups.forEach((group, i) => {
        group.numSolarPanels = numPanelsPerGroup[i];
        group.numBatteriesNeededWithSolar = workerResults[i];
    });

    return batteriesOnly;
}



/**
 * Calculates average sun hours over the past two weeks. 
 * @param lat - latitude coordinate
 * @param long - longitude coordinate
 * @param startDate - starting day of the experiment
 * @param endDate - ending day of the experiment
 * @returns - 2 arrays of size 24. Average[i] returns the sunlight for hour i, averaged over the past 3 years from startDate to endDate. Worst[i] returns the sunglight for hour i, taking the worst value over the past 3 years from startDate to endDate.
 */
export async function getAvgHourlySunHours(lat: number, long: number, startDate: string, endDate: string): Promise<{average: number[]; worst: number[]}> { 
    const YEARS = [2023, 2024, 2025] as const;
    
    const mmdd = (date: string) => date.slice(4);

    const getHourlyDataByYear = async(year: number): Promise<Record<string, number>> => {
        const start = `${year}${mmdd(startDate)}`;
        const end = `${year}${mmdd(endDate)}`;
        const url = `https://power.larc.nasa.gov/api/temporal/hourly/point?parameters=ALLSKY_SFC_SW_DWN&community=RE&longitude=${long}&latitude=${lat}&start=${start}&end=${end}&format=JSON`;
        const response = await fetch(url);
        if (!response.ok) {
            // nasa error
            throw new Error(`NASA POWER API Error ${response.status} for year ${year}`);
        }
        const data = await response.json();
        return data.properties.parameter.ALLSKY_SFC_SW_DWN;
    }
    const results = await Promise.all(YEARS.map(getHourlyDataByYear));

    const hourBuckets: number[][] = Array.from({length: 24}, () => []);

    for (const hourlyData of results) {
        for (const [key, value] of Object.entries(hourlyData)) {
            if (value === -999) continue;
            // Key format: "YYYYMMDD_HH"
            const hour = parseInt(key.split('_')[1], 10);
            if (isNaN(hour) || hour < 0 || hour > 23) continue;
            hourBuckets[hour].push(value);
        }
    }
    const average: number[] = new Array(24).fill(-1);
    const worst: number[] = new Array(24).fill(-1);
    for (let i = 0; i < 24; i++) {
        const values = hourBuckets[i];
        if (values.length == 0) throw new Error(`No valid solar data for hour ${i}`); // should we continue or throw an error?
        average[i] = values.reduce((sum, v) => sum+v, 0) / values.length;
        worst[i] = Math.min(...values);
    }
    return {average, worst}
}

