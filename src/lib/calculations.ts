const IE_POWER_PER_DAY = 100; // Wh per device per day
const SAFETY_MARGIN = 1.3;


type groupOutput = {
    devices: number,
    totalEnergyWh: number,
    dailyEnergyWh: number,
    minBatteryWh: number,        // battery-only mode: full experiment capacity needed
    solarPanelWatts?: number,    // solar mode
    batteryWithSolarWh?: number  // solar mode: covers non-sun hours only

}

type totalOutput = {
    groups: groupOutput[],
    powerPerDay: number,
    totalPower: number,
    sunHoursPerDay?: number
}

// inputs: # groups, # devices in each group, length of experiment in days
// also location with the location api, IF solarEnabled.
// why we do this: each group has a seperate battery, so we seperate results for each one
// total then just becomes the sum of energyPerDay and totalEnergy
// maybe we don't have user input # of devices in each group? And just split it optimally?

export function calculate(
    lengthOfExperiment: number,
    devicesPerGroup: number[],
    mode: "battery" | "solar",
    avgSunHoursPerDay?: number
): totalOutput {
    const groups: groupOutput[] = devicesPerGroup.map((devices) => {
        const dailyEnergyWh = devices * IE_POWER_PER_DAY * SAFETY_MARGIN;
        const totalEnergyWh = dailyEnergyWh * lengthOfExperiment;
        const minBatteryWh = totalEnergyWh;

        if (mode === 'solar' && avgSunHoursPerDay !== undefined) {
            return {
                devices,
                dailyEnergyWh,
                totalEnergyWh,
                minBatteryWh,
                solarPanelWatts: dailyEnergyWh / avgSunHoursPerDay,
                batteryWithSolarWh: devices * 4 * (24 - avgSunHoursPerDay) * SAFETY_MARGIN
            };
        }

        return { devices, dailyEnergyWh, totalEnergyWh, minBatteryWh };
    });

    return {
        groups,
        powerPerDay: groups.reduce((sum, g) => sum + g.dailyEnergyWh, 0),
        totalPower: groups.reduce((sum, g) => sum + g.totalEnergyWh, 0),
        sunHoursPerDay: avgSunHoursPerDay
    };
}

/**
 * Calculates average sun hours over the past two weeks. 
 * @param lat - latitude coordinate
 * @param long - longitude coordinate
 * @returns - average sun hours over the past two weeks using eligible data in kWh/m^2/day
 */
export async function getAvgSunHours(lat: number, long: number): Promise<number> { 
    const now = new Date();
    const endDate = now.toISOString().split('T')[0].replace(/-/g, '');
    const twoWeeksPrior = new Date();
    twoWeeksPrior.setDate(now.getDate() - 14);
    const startDate = twoWeeksPrior.toISOString().split('T')[0].replace(/-/g, '');
    const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=ALLSKY_SFC_SW_DWN&community=RE&longitude=${long}&latitude=${lat}&start=${startDate}&end=${endDate}&format=JSON`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error(`NASA POWER API Error: ${response.status}`);
    const data = await response.json();
    const allSky: Record<string, number> = data.properties.parameter.ALLSKY_SFC_SW_DWN;    
    const values = Object.values(allSky).filter(v => v !== -999);
    if (values.length === 0) throw new Error('No valid solar data returned for the given location/period');
    const average = values.reduce((sum, v) => sum + v, 0) / values.length;
    return average;
}