<script lang="ts">
	import {
		calculateBatteryOnly,
		calculateWithSolar,
		getSolarData,
		type TotalOutput
	} from '$lib/calculations';
	import DeviceGroup from '$lib/components/DeviceGroup.svelte';
	import ChargeGraph from '$lib/components/ChargeGraph.svelte';
	import ResultsTable from '$lib/components/ResultsTable.svelte';

	// ── Shared inputs ────────────────────────────────────────────────────────────

	type Group = { name: string; devices: number; panels: number };

	let startDate = $state('');
	let endDate = $state('');

	let devicePowerW = $state(4);
	let safetyMarginPct = $state(30);

	const BATTERY_PRESETS = [200, 500, 1000, 2000, 2500];
	let batteryPreset = $state(1000);
	let batteryCustom = $state('');
	let useCustomBattery = $state(false);
	const effectiveBattery = $derived(
		useCustomBattery ? (parseFloat(batteryCustom) || 0) : batteryPreset
	);

	let groups = $state<Group[]>([{ name: '', devices: 4, panels: 1 }]);

	// ── Mode ──────────────────────────────────────────────────────────────────────

	let mode = $state<'battery' | 'solar' | null>(null);
	let pendingMode = $state<'battery' | 'solar' | null>(null); // awaiting confirmation

	function trySetMode(next: 'battery' | 'solar') {
		if (next === mode) return;
		if (batteryResult || solarResultN) {
			pendingMode = next;
		} else {
			applyMode(next);
		}
	}

	function applyMode(next: 'battery' | 'solar') {
		mode = next;
		pendingMode = null;
		batteryResult = null;
		solarResultN = null;
		solarResultAll = null;
		errors = {};
	}

	// ── Solar inputs ──────────────────────────────────────────────────────────────

	let lat = $state('');
	let long = $state('');
	let numWorstDays = $state(3);
	let committedWorstDays = $state(3);
	let committedBatteryCapacity = $state<number>(effectiveBattery);
	const PANEL_PRESETS = [40, 100, 160, 200, 220];
	let panelPreset = $state(100);
	let panelCustom = $state('');
	let useCustomPanel = $state(false);
	const effectivePanel = $derived(
		useCustomPanel ? (parseFloat(panelCustom) || 0) : panelPreset
	);

	let geoError = $state('');

	function useMyLocation() {
		geoError = '';
		if (!navigator.geolocation) {
			geoError = 'Geolocation not supported by this browser.';
			return;
		}
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				lat = pos.coords.latitude.toFixed(4);
				long = pos.coords.longitude.toFixed(4);
			},
			() => {
				geoError = 'Location access denied. Enter coordinates manually.';
			}
		);
	}

	// Silently warm the cache whenever solar inputs are valid
	$effect(() => {
		const latN = parseFloat(lat);
		const lonN = parseFloat(long);
		if (!lat || !long || !startDate || !endDate || mode !== 'solar') return;
		if (isNaN(latN) || isNaN(lonN)) return;
		getSolarData(latN, lonN, startDate, endDate).catch(() => {});
	});

	// ── Status / errors ───────────────────────────────────────────────────────────

	let status = $state<'idle' | 'fetching' | 'running' | 'done' | 'error'>('idle');
	let statusMsg = $state('');
	let errors = $state<Record<string, string>>({});

	// ── Results ───────────────────────────────────────────────────────────────────

	let batteryResult = $state<TotalOutput | null>(null);
	let solarResultN = $state<TotalOutput | null>(null);
	let solarResultAll = $state<TotalOutput | null>(null);

	// ── Derived helpers ───────────────────────────────────────────────────────────

	const totalDays = $derived(() => {
		if (!startDate || !endDate) return 0;
		const s = new Date(startDate);
		const e = new Date(endDate);
		return Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
	});

	// Convert YYYY-MM-DD (from <input type="date">) to YYYYMMDD for calculations
	function toCompact(iso: string): string {
		return iso.replace(/-/g, '');
	}

	// ── Validation ────────────────────────────────────────────────────────────────

	function validate(): boolean {
		const errs: Record<string, string> = {};

		if (!startDate) errs.startDate = 'Required.';
		if (!endDate) errs.endDate = 'Required.';
		if (startDate && endDate && startDate >= endDate) {
			errs.endDate = 'End date must be after start date.';
		}

		if (effectiveBattery <= 0) errs.battery = 'Battery capacity must be greater than 0.';

		if (groups.length === 0) {
			errs.groups = 'Add at least one group.';
		} else if (groups.every((g) => g.devices < 1)) {
			errs.groups = 'Each group must have at least one device.';
		}

		if (mode === 'solar') {
			const latN = parseFloat(lat);
			const lonN = parseFloat(long);
			if (!lat || isNaN(latN) || latN < -90 || latN > 90)
				errs.lat = 'Enter a valid latitude (−90 to 90).';
			if (!long || isNaN(lonN) || lonN < -180 || lonN > 180)
				errs.long = 'Enter a valid longitude (−180 to 180).';
			if (effectivePanel <= 0) errs.panel = 'Panel rating must be greater than 0.';
			if (groups.some((g) => g.panels < 0)) errs.panels = 'Panel count cannot be negative.';
			const days = totalDays();
			if (numWorstDays < 0 || numWorstDays > days)
				errs.worstDays = `Must be between 0 and ${days} (total days).`;
		}

		errors = errs;
		return Object.keys(errs).length === 0;
	}

	// ── Calculate ─────────────────────────────────────────────────────────────────

	async function calculate() {
		if (!validate()) return;

		const start = toCompact(startDate);
		const end = toCompact(endDate);
		const devicesPerGroup = groups.map((g) => g.devices);

		if (mode === 'battery') {
			batteryResult = calculateBatteryOnly(start, end, devicesPerGroup, effectiveBattery, devicePowerW, 1 + safetyMarginPct / 100);
			status = 'done';
			return;
		}

		// Solar mode
		const latN = parseFloat(lat);
		const lonN = parseFloat(long);
		const panels = groups.map((g) => g.panels);
		const days = totalDays();

		try {
			status = 'fetching';
			statusMsg = 'Fetching solar data…';
			const solarData = await getSolarData(latN, lonN, start, end);

			status = 'running';
			statusMsg = 'Running simulation…';
			committedWorstDays = numWorstDays;
			committedBatteryCapacity = effectiveBattery;
			const margin = 1 + safetyMarginPct / 100;
			[solarResultN, solarResultAll] = await Promise.all([
				calculateWithSolar(start, end, devicesPerGroup, effectiveBattery, solarData, numWorstDays, effectivePanel, panels, devicePowerW, margin),
				calculateWithSolar(start, end, devicesPerGroup, effectiveBattery, solarData, days, effectivePanel, panels, devicePowerW, margin)
			]);

			// Keep battery-only for "reduction vs battery-only" comparison
			batteryResult = calculateBatteryOnly(start, end, devicesPerGroup, effectiveBattery, devicePowerW, margin);

			status = 'done';
			statusMsg = '';
		} catch (err) {
			status = 'error';
			statusMsg = err instanceof Error ? err.message : 'An error occurred.';
		}
	}

	// ── Methodology accordion ─────────────────────────────────────────────────────

	let methodologyOpen = $state(false);

	// ── Helpers for results display ───────────────────────────────────────────────

	function groupName(i: number) {
		return groups[i]?.name || `Group ${i + 1}`;
	}
</script>

<div class="min-h-screen bg-[#0f0f0f] px-4 py-8 text-[#e8e8e8]">
	<div class="mx-auto max-w-2xl space-y-8">

		<!-- Header -->
		<div>
			<h1 class="text-lg font-semibold tracking-wide text-[#e8e8e8]">Solar / Battery Calculator</h1>
			<p class="mt-1 text-sm text-[#e8e8e8]">Power planning for field experiments.</p>
		</div>

		<!-- ── 1. Experiment Parameters ───────────────────────────────────────── -->
		<section class="space-y-4">
			<h2 class="text-xs font-medium uppercase tracking-widest text-[#e8e8e8]">Experiment Parameters</h2>

			<div class="grid grid-cols-2 gap-4">
				<div>
					<label class="block text-xs text-[#e8e8e8]" for="startDate">Start date</label>
					<input
						id="startDate"
						type="date"
						bind:value={startDate}
						class="mt-1 w-full rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
					/>
					{#if errors.startDate}<p class="mt-0.5 text-xs text-red-400">{errors.startDate}</p>{/if}
				</div>
				<div>
					<label class="block text-xs text-[#e8e8e8]" for="endDate">End date</label>
					<input
						id="endDate"
						type="date"
						bind:value={endDate}
						class="mt-1 w-full rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
					/>
					{#if errors.endDate}<p class="mt-0.5 text-xs text-red-400">{errors.endDate}</p>{/if}
				</div>
			</div>

			<div>
				<p class="text-xs text-[#e8e8e8]">Battery capacity (Wh)</p>
				<div class="mt-1 flex flex-wrap gap-1.5">
					{#each BATTERY_PRESETS as preset}
						<button
							onclick={() => { batteryPreset = preset; useCustomBattery = false; }}
							class="rounded-sm border px-3 py-1 text-sm transition-colors {!useCustomBattery && batteryPreset === preset
								? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
								: 'border-[#333] text-[#aaa] hover:border-[#555]'}"
						>
							{preset}
						</button>
					{/each}
					<button
						onclick={() => (useCustomBattery = true)}
						class="rounded-sm border px-3 py-1 text-sm transition-colors {useCustomBattery
							? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
							: 'border-[#333] text-[#aaa] hover:border-[#555]'}"
					>
						Custom
					</button>
				</div>
				{#if useCustomBattery}
					<input
						type="number"
						bind:value={batteryCustom}
						placeholder="Enter Wh"
						min="1"
						class="mt-2 w-40 rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
					/>
				{/if}
				{#if errors.battery}<p class="mt-0.5 text-xs text-red-400">{errors.battery}</p>{/if}
			</div>

			<div>
				<label class="block text-xs text-[#e8e8e8]" for="devicePowerW">
					Device power draw (W per device)
					<span class="ml-1 text-[#888]">— Insect Eavesdropper uses 4W</span>
				</label>
				<input
					id="devicePowerW"
					type="number"
					bind:value={devicePowerW}
					min="0.1"
					step="0.1"
					class="mt-1 w-32 rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
				/>
				<p class="mt-0.5 text-xs text-[#888]">~{(devicePowerW * 24).toFixed(0)} Wh/day per device</p>
			</div>

			<div>
				<label class="block text-xs text-[#e8e8e8]" for="safetyMarginPct">
					Safety margin (%)
					<span class="ml-1 text-[#888]">— default is 30%</span>
				</label>
				<input
					id="safetyMarginPct"
					type="number"
					bind:value={safetyMarginPct}
					min="0"
					max="200"
					step="1"
					class="mt-1 w-32 rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
				/>
				<p class="mt-0.5 text-xs text-[#888]">Adds {safetyMarginPct}% buffer to device power draw</p>
			</div>
		</section>

		<!-- ── 2. Device Groups ───────────────────────────────────────────────── -->
		<section class="space-y-3">
			<h2 class="text-xs font-medium uppercase tracking-widest text-[#e8e8e8]">Device Groups</h2>
			<p class="text-xs text-[#e8e8e8]">Each group has its own battery. Devices draw {devicePowerW} W continuously (~{(devicePowerW * 24).toFixed(0)} Wh/day each).</p>
			{#if mode === 'solar'}
				<p class="rounded-sm border border-[#f59e0b]/30 bg-[#f59e0b]/5 px-3 py-2 text-xs text-[#f59e0b]">
					Make sure to set the number of solar panels for each group below.
				</p>
			{/if}

			{#if errors.groups}
				<p class="text-xs text-red-400">{errors.groups}</p>
			{/if}

			<div class="space-y-2">
				{#each groups as _group, i (i)}
					<DeviceGroup
						bind:group={groups[i]}
						index={i}
						showSolarInputs={mode === 'solar'}
						canRemove={groups.length > 1}
						onRemove={() => groups.splice(i, 1)}
					/>
				{/each}
			</div>

			{#if errors.panels}
				<p class="text-xs text-red-400">{errors.panels}</p>
			{/if}

			<button
				onclick={() => groups.push({ name: '', devices: 4, panels: 1 })}
				class="text-sm text-[#888] hover:text-[#e8e8e8] transition-colors"
			>
				+ Add Group
			</button>
		</section>

		<!-- ── 3. Mode Buttons ────────────────────────────────────────────────── -->
		<section class="space-y-3">
			<h2 class="text-xs font-medium uppercase tracking-widest text-[#e8e8e8]">Mode</h2>

			<div class="flex gap-3">
				<button
					onclick={() => trySetMode('battery')}
					class="flex-1 rounded-sm border py-2 text-sm font-medium transition-colors {mode === 'battery'
						? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
						: 'border-[#333] text-[#888] hover:border-[#555] hover:text-[#e8e8e8]'}"
				>
					Battery Only
				</button>
				<button
					onclick={() => trySetMode('solar')}
					class="flex-1 rounded-sm border py-2 text-sm font-medium transition-colors {mode === 'solar'
						? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
						: 'border-[#333] text-[#888] hover:border-[#555] hover:text-[#e8e8e8]'}"
				>
					Battery + Solar
				</button>
			</div>

			{#if pendingMode}
				<p class="text-sm text-[#888]">
					Switching modes will clear your current results.
					<button onclick={() => applyMode(pendingMode!)} class="ml-1 text-[#f59e0b] hover:underline">Confirm</button>
					<button onclick={() => (pendingMode = null)} class="ml-1 text-[#888] hover:text-[#e8e8e8]">Cancel</button>
				</p>
			{/if}
		</section>

		<!-- ── 4. Solar Inputs ────────────────────────────────────────────────── -->
		{#if mode === 'solar'}
			<section class="space-y-4">
				<h2 class="text-xs font-medium uppercase tracking-widest text-[#e8e8e8]">Solar Parameters</h2>

				<div class="grid grid-cols-2 gap-4">
					<div>
						<label class="block text-xs text-[#e8e8e8]" for="lat">
							Latitude
							<button onclick={useMyLocation} class="ml-2 text-[#f59e0b] hover:underline">Use my location</button>
						</label>
						<input
							id="lat"
							type="number"
							bind:value={lat}
							placeholder="e.g. 37.7749"
							step="any"
							class="mt-1 w-full rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
						/>
						{#if errors.lat}<p class="mt-0.5 text-xs text-red-400">{errors.lat}</p>{/if}
					</div>
					<div>
						<label class="block text-xs text-[#e8e8e8]" for="long">Longitude</label>
						<input
							id="long"
							type="number"
							bind:value={long}
							placeholder="e.g. -122.4194"
							step="any"
							class="mt-1 w-full rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
						/>
						{#if errors.long}<p class="mt-0.5 text-xs text-red-400">{errors.long}</p>{/if}
					</div>
				</div>

				{#if geoError}
					<p class="text-xs text-red-400">{geoError}</p>
				{/if}

				<div>
					<label class="block text-xs text-[#e8e8e8]" for="worstDays">
						Number of worst days (N)
						<span class="ml-1 text-[#aaa]">— appended at end of simulation as worst-case days</span>
					</label>
					<input
						id="worstDays"
						type="number"
						bind:value={numWorstDays}
						min="0"
						class="mt-1 w-24 rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
					/>
					{#if errors.worstDays}<p class="mt-0.5 text-xs text-red-400">{errors.worstDays}</p>{/if}
				</div>

				<div>
					<p class="text-xs text-[#e8e8e8]">Panel rating (W)</p>
					<div class="mt-1 flex flex-wrap gap-1.5">
						{#each PANEL_PRESETS as preset}
							<button
								onclick={() => { panelPreset = preset; useCustomPanel = false; }}
								class="rounded-sm border px-3 py-1 text-sm transition-colors {!useCustomPanel && panelPreset === preset
									? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
									: 'border-[#333] text-[#aaa] hover:border-[#555]'}"
							>
								{preset}W
							</button>
						{/each}
						<button
							onclick={() => (useCustomPanel = true)}
							class="rounded-sm border px-3 py-1 text-sm transition-colors {useCustomPanel
								? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
								: 'border-[#333] text-[#aaa] hover:border-[#555]'}"
						>
							Custom
						</button>
					</div>
					{#if useCustomPanel}
						<input
							type="number"
							bind:value={panelCustom}
							placeholder="Enter W"
							min="1"
							class="mt-2 w-40 rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
						/>
					{/if}
					{#if errors.panel}<p class="mt-0.5 text-xs text-red-400">{errors.panel}</p>{/if}
				</div>
			</section>
		{/if}

		<!-- ── 5. Calculate Button ────────────────────────────────────────────── -->
		{#if mode}
			<div class="space-y-2">
				<button
					onclick={calculate}
					disabled={status === 'fetching' || status === 'running'}
					class="w-full rounded-sm bg-[#f59e0b] py-2.5 text-sm font-semibold text-[#0f0f0f] transition-opacity disabled:opacity-50"
				>
					{status === 'fetching' || status === 'running' ? statusMsg : 'Calculate'}
				</button>

				{#if status === 'error'}
					<p class="text-sm text-red-400">{statusMsg}</p>
				{/if}
			</div>
		{/if}

		<!-- ── 6. Results ─────────────────────────────────────────────────────── -->
		{#if mode === 'battery' && batteryResult}
			<section class="space-y-4 rounded-sm border border-[#2a2a2a] bg-[#1a1a1a] p-4">
				<h2 class="text-xs font-medium uppercase tracking-widest text-[#888]">Results — Battery Only</h2>

				<div>
					<p class="mb-2 text-xs text-[#999]">Batteries required per group</p>
					<ResultsTable
						mode="battery"
						groups={batteryResult.groups.map((g, i) => ({
							name: groupName(i),
							batteriesNoSolar: g.numBatteriesNeededNoSolar
						}))}
					/>
				</div>

				<div class="border-t border-[#2a2a2a] pt-3 text-sm text-[#999]">
					<div class="flex justify-between">
						<span>Daily energy use</span>
						<span class="font-mono text-[#e8e8e8]">{batteryResult.powerPerDay.toFixed(0)} Wh</span>
					</div>
					<div class="mt-1 flex justify-between">
						<span>Total energy</span>
						<span class="font-mono text-[#e8e8e8]">{batteryResult.totalPower.toFixed(0)} Wh</span>
					</div>
				</div>
			</section>
		{/if}

		{#if mode === 'solar' && solarResultN && solarResultAll && batteryResult}
			<section class="space-y-6 rounded-sm border border-[#2a2a2a] bg-[#1a1a1a] p-4">
				<h2 class="text-xs font-medium uppercase tracking-widest text-[#888]">Results — Battery + Solar</h2>

				<div>
					<p class="mb-2 text-xs text-[#999]">Batteries required per group</p>
					<ResultsTable
						mode="solar"
						{committedWorstDays}
						groups={batteryResult.groups.map((g, i) => ({
							name: groupName(i),
							batteriesNoSolar: g.numBatteriesNeededNoSolar,
							batteriesN: solarResultN!.groups[i].numBatteriesNeededWithSolar,
							batteriesAll: solarResultAll!.groups[i].numBatteriesNeededWithSolar
						}))}
					/>
				</div>

				<div class="space-y-6 border-t border-[#2a2a2a] pt-4">
					<ChargeGraph
						title="Simulation — {committedWorstDays} worst day{committedWorstDays === 1 ? '' : 's'}"
						groups={solarResultN.groups.map((g, i) => ({
							name: groupName(i),
							chargeHistory: g.chargeHistory!,
							numBatteries: g.numBatteriesNeededWithSolar!
						}))}
						batteryCapacityWh={committedBatteryCapacity}
					/>
					<ChargeGraph
						title="Simulation — all worst days"
						groups={solarResultAll.groups.map((g, i) => ({
							name: groupName(i),
							chargeHistory: g.chargeHistory!,
							numBatteries: g.numBatteriesNeededWithSolar!
						}))}
						batteryCapacityWh={committedBatteryCapacity}
					/>
				</div>
			</section>
		{/if}

		<!-- ── 7. Methodology Accordion ───────────────────────────────────────── -->
		<section class="border-t border-[#2a2a2a] pt-4">
			<button
				onclick={() => (methodologyOpen = !methodologyOpen)}
				class="flex w-full items-center gap-2 text-left text-sm text-[#888] hover:text-[#888] transition-colors"
			>
				<span class="font-mono text-xs">{methodologyOpen ? '▼' : '▶'}</span>
				How is this calculated?
			</button>

			{#if methodologyOpen}
				<div class="mt-4 space-y-3 text-sm text-[#888] leading-relaxed">
					<div>
						<p class="mb-0.5 text-xs font-medium uppercase tracking-wide text-[#e8e8e8]">Solar irradiance data</p>
						<p>Hourly irradiance (kWh/m²) is fetched from the NASA POWER API using the ALLSKY_SFC_SW_DWN parameter, over the same seasonal date range for the years 2023–2025.</p>
					</div>
					<div>
						<p class="mb-0.5 text-xs font-medium uppercase tracking-wide text-[#e8e8e8]">Average vs worst case</p>
						<p>For each hour of the day, the average profile takes the mean irradiance across all matching days and years. The worst-case profile takes the single lowest observed value for that hour.</p>
					</div>
					<div>
						<p class="mb-0.5 text-xs font-medium uppercase tracking-wide text-[#e8e8e8]">Solar panel output</p>
						<p>Panel output (Wh) = irradiance × panel rating × number of panels × 80% system efficiency, which accounts for wiring losses, inverter efficiency, soiling, and temperature.</p>
					</div>
					<div>
						<p class="mb-0.5 text-xs font-medium uppercase tracking-wide text-[#e8e8e8]">Hour-by-hour simulation</p>
						<p>The battery charges when solar output exceeds device load and discharges otherwise. Energy beyond the battery's capacity is lost. A configurable safety margin (default 30%) is applied to device power draw.</p>
					</div>
					<div>
						<p class="mb-0.5 text-xs font-medium uppercase tracking-wide text-[#e8e8e8]">N worst days scenario</p>
						<p>The first (total days − N) days use the average hourly profile. The final N days use the worst-case profile. Battery state carries over naturally between days.</p>
					</div>
					<div>
						<p class="mb-0.5 text-xs font-medium uppercase tracking-wide text-[#e8e8e8]">All worst days scenario</p>
						<p>Every day uses the worst-case hourly profile — the maximum stress test for the system.</p>
					</div>
					<div>
						<p class="mb-0.5 text-xs font-medium uppercase tracking-wide text-[#e8e8e8]">Finding the minimum batteries</p>
						<p>A binary search is run over candidate battery counts. For each candidate, the full simulation is executed. The smallest count that keeps the battery from running out is used.</p>
					</div>
				</div>
			{/if}
		</section>

	</div>
</div>
