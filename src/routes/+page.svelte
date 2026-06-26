<script lang="ts">
	import {
		calculateBatteryOnly,
		calculateWithSolar,
		getSolarData,
		SOLAR_EFFICIENCY,
		CIRCUIT_EFFICIENCY,
		type TotalOutput
	} from '$lib/calculations';

	// Expected losses, shown in the UI so users see where energy goes.
	const solarLossPct = Math.round((1 - SOLAR_EFFICIENCY) * 100);
	const circuitLossPct = Math.round((1 - CIRCUIT_EFFICIENCY) * 100);
	import DeviceGroup from '$lib/components/DeviceGroup.svelte';
	import ChargeGraph from '$lib/components/ChargeGraph.svelte';
	import ResultsTable from '$lib/components/ResultsTable.svelte';
	import labLogo from '$lib/assets/bicklab_logo.png';

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
	let customBatteryMode = $state<'wh' | 'ahv'>('wh');
	let batteryAh = $state('');
	let batteryV = $state('');
	const customWhFromAhV = $derived(() => {
		const ah = parseFloat(batteryAh);
		const v = parseFloat(batteryV);
		if (isNaN(ah) || isNaN(v)) return 0;
		return ah * v;
	});
	const effectiveBattery = $derived(() => {
		if (!useCustomBattery) return batteryPreset;
		if (customBatteryMode === 'ahv') return customWhFromAhV();
		return parseFloat(batteryCustom) || 0;
	});

	// When false (default) the calculator finds the minimum battery itself; when true
	// the user supplies a specific battery to check (solar) or get recharges (battery).
	let provideBattery = $state(false);
	const userBatteryWh = $derived(() => (provideBattery ? effectiveBattery() : undefined));
	// Snapshot of the supplied battery at calculate-time, for the "enough / short" readout.
	let committedUserBattery = $state<number | undefined>(undefined);

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
	const PANEL_PRESETS = [40, 100, 160, 200, 220];
	let panelPreset = $state(100);
	let panelCustom = $state('');
	let useCustomPanel = $state(false);
	const effectivePanel = $derived(useCustomPanel ? parseFloat(panelCustom) || 0 : panelPreset);

	let geoError = $state('');

	const readableCoords = $derived(() => {
		const latN = parseFloat(lat);
		const lonN = parseFloat(long);
		if (isNaN(latN) || isNaN(lonN)) return '';
		if (latN < -90 || latN > 90 || lonN < -180 || lonN > 180) return '';
		const latDir = latN >= 0 ? 'N' : 'S';
		const lonDir = lonN >= 0 ? 'E' : 'W';
		return `${Math.abs(latN).toFixed(4)}° ${latDir}, ${Math.abs(lonN).toFixed(4)}° ${lonDir}`;
	});

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

	// ── Geocoding (OpenStreetMap Nominatim) ──────────────────────────────────────
	// Nominatim's usage policy caps requests at ~1/sec per client. We debounce
	// reverse lookups and rate-limit forward searches to stay well under that.

	let placeQuery = $state('');
	let placeSearching = $state(false);
	let placeError = $state('');

	let nearestPlace = $state('');
	let nearestUnpopulated = $state(false);
	let nearestLooking = $state(false);
	let reverseTimer: ReturnType<typeof setTimeout> | null = null;
	let lastNominatimRequest = 0;
	const MIN_REQUEST_GAP_MS = 1100;

	async function searchPlace() {
		const q = placeQuery.trim();
		if (!q) return;
		const now = Date.now();
		const wait = lastNominatimRequest + MIN_REQUEST_GAP_MS - now;
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastNominatimRequest = Date.now();
		placeSearching = true;
		placeError = '';
		try {
			const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1`;
			const res = await fetch(url, { headers: { Accept: 'application/json' } });
			if (!res.ok) throw new Error(`Status ${res.status}`);
			const results = (await res.json()) as Array<{
				lat: string;
				lon: string;
				display_name: string;
			}>;
			if (!results.length) {
				placeError = 'No results. Try a different city or zip code.';
				return;
			}
			const first = results[0];
			lat = parseFloat(first.lat).toFixed(4);
			long = parseFloat(first.lon).toFixed(4);
			geoError = '';
		} catch {
			placeError = 'Lookup failed. Check your connection and try again.';
		} finally {
			placeSearching = false;
		}
	}

	async function lookupNearest(latN: number, lonN: number) {
		const now = Date.now();
		const wait = lastNominatimRequest + MIN_REQUEST_GAP_MS - now;
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastNominatimRequest = Date.now();
		nearestLooking = true;
		try {
			const url = `https://nominatim.openstreetmap.org/reverse?lat=${latN}&lon=${lonN}&format=jsonv2&zoom=10`;
			const res = await fetch(url, { headers: { Accept: 'application/json' } });
			if (!res.ok) throw new Error(`Status ${res.status}`);
			const data = (await res.json()) as {
				error?: string;
				address?: Record<string, string>;
				display_name?: string;
			};
			if (data.error || !data.address) {
				nearestPlace = '';
				nearestUnpopulated = true;
				return;
			}
			const a = data.address;
			const place = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
			const region = a.state || a.region || '';
			const country = a.country || '';
			const parts = [place, region && region !== place ? region : '', country].filter(Boolean);
			nearestPlace = parts.join(', ');
			nearestUnpopulated = !place && !region;
			// Coordinates are the source of truth: when they resolve to a real place,
			// reflect that place back into the city/zip search box so the two inputs
			// stay in sync. Leave the search box alone for open-water / errored lookups.
			if (nearestPlace) {
				placeQuery = nearestPlace;
			}
		} catch {
			nearestPlace = '';
			nearestUnpopulated = false;
		} finally {
			nearestLooking = false;
		}
	}

	// Debounced reverse lookup whenever lat/long are valid. The 1500ms wait keeps
	// us well below 1 req/sec even when a forward search has just filled the fields.
	$effect(() => {
		const latN = parseFloat(lat);
		const lonN = parseFloat(long);
		if (reverseTimer) clearTimeout(reverseTimer);
		if (isNaN(latN) || isNaN(lonN) || latN < -90 || latN > 90 || lonN < -180 || lonN > 180) {
			nearestPlace = '';
			nearestUnpopulated = false;
			return;
		}
		reverseTimer = setTimeout(() => lookupNearest(latN, lonN), 1500);
	});

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

		if (!startDate) errs.startDate = 'Please select a start date.';
		if (!endDate) errs.endDate = 'Please select an end date.';
		if (startDate && endDate && startDate >= endDate) {
			errs.endDate = 'End date must be after start date.';
		}

		if (provideBattery && effectiveBattery() <= 0)
			errs.battery = 'Battery capacity must be greater than 0.';

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
			if (!startDate || !endDate) {
				// Dates already flagged; skip worstDays bound check to avoid the
				// confusing "between 0 and 0" message.
			} else if (numWorstDays < 0 || numWorstDays > days) {
				errs.worstDays = `Must be between 0 and ${days} (total days in your date range).`;
			}
		}

		errors = errs;
		return Object.keys(errs).length === 0;
	}

	function scrollToFirstError() {
		requestAnimationFrame(() => {
			const firstError = document.querySelector('[data-field-error]') as HTMLElement | null;
			if (firstError) firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
		});
	}

	// ── Calculate ─────────────────────────────────────────────────────────────────

	async function calculate() {
		geoError = '';
		if (!validate()) {
			scrollToFirstError();
			return;
		}

		const start = toCompact(startDate);
		const end = toCompact(endDate);
		const devicesPerGroup = groups.map((g) => g.devices);

		if (mode === 'battery') {
			committedUserBattery = userBatteryWh();
			batteryResult = calculateBatteryOnly(
				start,
				end,
				devicesPerGroup,
				devicePowerW,
				1 + safetyMarginPct / 100,
				userBatteryWh()
			);
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
			committedUserBattery = userBatteryWh();
			const margin = 1 + safetyMarginPct / 100;
			[solarResultN, solarResultAll] = await Promise.all([
				calculateWithSolar(
					start,
					end,
					devicesPerGroup,
					solarData,
					numWorstDays,
					effectivePanel,
					panels,
					devicePowerW,
					margin,
					'nworst'
				),
				calculateWithSolar(
					start,
					end,
					devicesPerGroup,
					solarData,
					days,
					effectivePanel,
					panels,
					devicePowerW,
					margin,
					'allworst'
				)
			]);

			// Battery-only baseline (also gives the no-recharge capacity per group)
			batteryResult = calculateBatteryOnly(
				start,
				end,
				devicesPerGroup,
				devicePowerW,
				margin,
				userBatteryWh()
			);

			status = 'done';
			statusMsg = '';
		} catch (err) {
			status = 'error';
			statusMsg = err instanceof Error ? err.message : 'An error occurred.';
		}
	}

	// ── Methodology + Definitions accordions ──────────────────────────────────────

	let methodologyOpen = $state(false);
	let positioningOpen = $state(false);
	let wiringOpen = $state(false);
	let definitionsOpen = $state(false);

	function jumpTo(id: string) {
		// Open the definitions accordion if a term is clicked while it's collapsed,
		// then scroll/highlight on the next frame so the target is in the DOM.
		if (!definitionsOpen) definitionsOpen = true;
		requestAnimationFrame(() => {
			const el = document.getElementById(id);
			if (!el) return;
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			el.classList.remove('def-flash');
			void el.offsetWidth; // restart animation
			el.classList.add('def-flash');
		});
	}

	// ── Helpers for results display ───────────────────────────────────────────────

	function groupName(i: number) {
		return groups[i]?.name || `Group ${i + 1}`;
	}
</script>

{#snippet term(label: string, id: string)}
	<button type="button" class="def-link" onclick={() => jumpTo(id)} title="Jump to definition"
		>{label}</button
	>
{/snippet}

<div class="min-h-screen bg-[#0f0f0f] px-4 pt-14 pb-8 text-[#e8e8e8]">
	<div class="mx-auto max-w-2xl space-y-8">
		<!-- ── Header ─────────────────────────────────────────────────────────── -->
		<header
			class="flex flex-wrap items-center justify-between gap-4 border-b border-[#2a2a2a] pb-5"
		>
			<div class="leading-tight">
				<h1 class="text-lg font-semibold tracking-wide text-[#e8e8e8]">
					Solar / Battery Calculator
				</h1>
				<p class="mt-0.5 text-xs text-[#666] italic">Created by Geet Gambhir and Alex Arovas</p>
			</div>
			<div class="flex items-center gap-3">
				<div class="text-right leading-tight">
					<a
						href="https://bicklab.com"
						target="_blank"
						rel="noopener noreferrer"
						class="text-lg font-semibold tracking-wide text-[#e8e8e8] hover:text-[#f59e0b]"
					>
						Bick Lab
					</a>
					<span
						class="mt-0.5 block text-xs text-[#666] italic"
						title="Preprint paper link will go here"
					>
						Preprint paper coming soon →
					</span>
				</div>
				<a href="https://bicklab.com" target="_blank" rel="noopener noreferrer" class="shrink-0">
					<img src={labLogo} alt="Bick Lab logo" class="h-12 w-12 rounded-sm object-contain" />
				</a>
			</div>
		</header>

		<!-- ── 1. Experiment Parameters ───────────────────────────────────────── -->
		<section class="space-y-4">
			<h2 class="text-xs font-medium tracking-widest text-[#e8e8e8] uppercase">
				Experiment Parameters
			</h2>

			<div class="grid grid-cols-2 gap-4">
				<div>
					<label class="block text-xs text-[#e8e8e8]" for="startDate">
						Start date
						{#if !startDate}<span class="ml-1 text-[#f59e0b]">(required)</span>{/if}
					</label>
					<input
						id="startDate"
						type="date"
						bind:value={startDate}
						class="mt-1 w-full rounded-sm border bg-[#1a1a1a] px-3 py-1.5 text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none {!startDate
							? 'border-[#f59e0b]/60'
							: 'border-[#333]'}"
					/>
					{#if errors.startDate}<p data-field-error class="mt-0.5 text-xs text-red-400">
							{errors.startDate}
						</p>{/if}
				</div>
				<div>
					<label class="block text-xs text-[#e8e8e8]" for="endDate">
						End date
						{#if !endDate}<span class="ml-1 text-[#f59e0b]">(required)</span>{/if}
					</label>
					<input
						id="endDate"
						type="date"
						bind:value={endDate}
						class="mt-1 w-full rounded-sm border bg-[#1a1a1a] px-3 py-1.5 text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none {!endDate
							? 'border-[#f59e0b]/60'
							: 'border-[#333]'}"
					/>
					{#if errors.endDate}<p data-field-error class="mt-0.5 text-xs text-red-400">
							{errors.endDate}
						</p>{/if}
				</div>
			</div>

			<div>
				<p class="text-xs text-[#e8e8e8]">
					Battery ({@render term('Wh', 'def-wh')}) <span class="text-[#888]">(optional)</span>
				</p>
				<div class="mt-1 flex flex-wrap gap-1.5">
					<button
						onclick={() => (provideBattery = false)}
						class="rounded-sm border px-3 py-1 text-sm transition-colors {!provideBattery
							? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
							: 'border-[#333] text-[#aaa] hover:border-[#555]'}"
					>
						Calculate the minimum for me
					</button>
					<button
						onclick={() => (provideBattery = true)}
						class="rounded-sm border px-3 py-1 text-sm transition-colors {provideBattery
							? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
							: 'border-[#333] text-[#aaa] hover:border-[#555]'}"
					>
						I have a battery
					</button>
				</div>
				{#if !provideBattery}
					<p class="mt-1 text-xs text-[#888]">
						The calculator will report the smallest battery that works. Choose
						<span class="text-[#aaa]">I have a battery</span> to check a specific one (and, in battery-only
						mode, see how many recharges it needs).
					</p>
				{/if}
				{#if provideBattery}
					<div class="mt-2 flex flex-wrap gap-1.5">
						{#each BATTERY_PRESETS as preset (preset)}
							<button
								onclick={() => {
									batteryPreset = preset;
									useCustomBattery = false;
								}}
								class="rounded-sm border px-3 py-1 text-sm transition-colors {!useCustomBattery &&
								batteryPreset === preset
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
							Custom (Wh or Ah × V)
						</button>
					</div>
					{#if !useCustomBattery}
						<p class="mt-1 text-xs text-[#888]">
							Click <span class="text-[#aaa]">Custom</span> to enter Wh directly, or compute it from {@render term(
								'Ah',
								'def-ah'
							)} × {@render term('V', 'def-v')}.
						</p>
					{/if}
					{#if useCustomBattery}
						<div class="mt-2 space-y-2 rounded-sm border border-[#2a2a2a] bg-[#141414] p-3">
							<div class="flex gap-1.5">
								<button
									onclick={() => (customBatteryMode = 'wh')}
									class="rounded-sm border px-2.5 py-0.5 text-xs transition-colors {customBatteryMode ===
									'wh'
										? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
										: 'border-[#333] text-[#888] hover:border-[#555]'}"
								>
									Enter Wh
								</button>
								<button
									onclick={() => (customBatteryMode = 'ahv')}
									class="rounded-sm border px-2.5 py-0.5 text-xs transition-colors {customBatteryMode ===
									'ahv'
										? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
										: 'border-[#333] text-[#888] hover:border-[#555]'}"
								>
									Compute from Ah × V
								</button>
							</div>

							{#if customBatteryMode === 'wh'}
								<input
									type="number"
									bind:value={batteryCustom}
									placeholder="Enter Wh"
									min="1"
									class="w-40 rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
								/>
							{:else}
								<div class="flex flex-wrap items-center gap-2">
									<label class="flex items-center gap-1.5 text-xs text-[#888]">
										<span>Ah</span>
										<input
											type="number"
											bind:value={batteryAh}
											placeholder="Enter Ah"
											min="0"
											step="any"
											class="w-28 rounded-sm border border-[#333] bg-[#1a1a1a] px-2 py-1 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
										/>
									</label>
									<span class="text-[#666]">×</span>
									<label class="flex items-center gap-1.5 text-xs text-[#888]">
										<span>V</span>
										<input
											type="number"
											bind:value={batteryV}
											placeholder="Enter V"
											min="0"
											step="any"
											class="w-28 rounded-sm border border-[#333] bg-[#1a1a1a] px-2 py-1 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
										/>
									</label>
									<span class="text-[#666]">=</span>
									<span class="font-mono text-sm text-[#f59e0b]">
										{customWhFromAhV().toFixed(1)} Wh
									</span>
								</div>
								<p class="text-xs text-[#666]">Example: 100 Ah × 12 V = 1200 Wh</p>
							{/if}
						</div>
					{/if}
				{/if}
				{#if errors.battery}<p data-field-error class="mt-0.5 text-xs text-red-400">
						{errors.battery}
					</p>{/if}
			</div>

			<div>
				<label class="block text-xs text-[#e8e8e8]" for="devicePowerW">
					Device power draw ({@render term('W', 'def-w')} per device)
					<span class="ml-1 text-[#888]">
						(Example:
						<a
							href="https://www.insecteavesdropper.com"
							target="_blank"
							rel="noopener noreferrer"
							class="underline decoration-dotted underline-offset-2 hover:text-[#e8e8e8]"
							>Insect Eavesdropper</a
						>
						uses 4 W)
					</span>
				</label>
				<input
					id="devicePowerW"
					type="number"
					bind:value={devicePowerW}
					placeholder="Enter W"
					min="0.1"
					step="0.1"
					class="mt-1 w-32 rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
				/>
				<p class="mt-0.5 font-mono text-xs text-[#888]">
					{devicePowerW} W × 24 h = {(devicePowerW * 24).toFixed(0)}
					{@render term('Wh', 'def-wh')}/day per device
				</p>
			</div>

			<div>
				<label class="block text-xs text-[#e8e8e8]" for="safetyMarginPct">
					{@render term('Safety margin', 'def-safety')} (%)
					<span class="ml-1 text-[#888]">(default is 30%)</span>
				</label>
				<input
					id="safetyMarginPct"
					type="number"
					bind:value={safetyMarginPct}
					placeholder="Enter %"
					min="0"
					max="200"
					step="1"
					class="mt-1 w-32 rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
				/>
				<p class="mt-0.5 font-mono text-xs text-[#888]">
					{devicePowerW} W × {(1 + safetyMarginPct / 100).toFixed(2)} = {(
						devicePowerW *
						(1 + safetyMarginPct / 100)
					).toFixed(2)}
					{@render term('W', 'def-w')} effective draw per device
				</p>
			</div>

			<div class="rounded-sm border border-[#2a2a2a] bg-[#161616] px-3 py-2">
				<p class="text-xs font-medium tracking-wide text-[#999]">Model assumptions (fixed)</p>
				<p class="mt-0.5 text-xs text-[#888]">
					{@render term('Solar loss', 'def-eff')}
					{solarLossPct}% (solar mode) &middot; {@render term('Circuit loss', 'def-circuit')}
					{circuitLossPct}% (both modes)
				</p>
			</div>
		</section>

		<!-- ── 2. Device Groups ───────────────────────────────────────────────── -->
		<section class="space-y-3">
			<h2 class="text-xs font-medium tracking-widest text-[#e8e8e8] uppercase">Device Groups</h2>

			<div
				class="space-y-2 rounded-sm border border-[#2a2a2a] bg-[#141414] px-3 py-2.5 text-xs leading-relaxed text-[#aaa]"
			>
				<p>
					<strong class="text-[#e8e8e8]">Most users only need one group.</strong> A {@render term(
						'group',
						'def-group'
					)} is a cluster of devices powered by one {@render term(
						'battery',
						'def-bank'
					)}{#if mode === 'solar'}&nbsp;and one set of solar panels{/if}. The <em>devices</em> count is
					how many that battery powers; the results below give the battery for each group.
				</p>
				<p>
					Use <strong class="text-[#e8e8e8]">multiple groups</strong> to split your devices across more
					than one independent battery. That can be because they're deployed at separate sites (e.g.&nbsp;two
					field stations a kilometer apart), or simply because one battery can't power them all. Each
					group is sized independently in the results below.
				</p>
				<p class="text-[#777]">
					Each device draws {devicePowerW}&nbsp;W continuously (<span class="font-mono"
						>{devicePowerW} W × 24 h = {(devicePowerW * 24).toFixed(0)} Wh/day</span
					> each).
				</p>
			</div>

			{#if mode === 'solar'}
				<p
					class="rounded-sm border border-[#f59e0b]/30 bg-[#f59e0b]/5 px-3 py-2 text-xs text-[#f59e0b]"
				>
					Make sure to set the number of solar panels for each group below.
				</p>
			{/if}

			{#if errors.groups}
				<p data-field-error class="text-xs text-red-400">{errors.groups}</p>
			{/if}

			<div class="space-y-2">
				{#each { length: groups.length }, i (i)}
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
				<p data-field-error class="text-xs text-red-400">{errors.panels}</p>
			{/if}

			<button
				onclick={() => groups.push({ name: '', devices: 4, panels: 1 })}
				class="text-sm text-[#888] transition-colors hover:text-[#e8e8e8]"
			>
				+ Add another group
			</button>
		</section>

		<!-- ── 3. Mode Buttons ────────────────────────────────────────────────── -->
		<section class="space-y-3">
			<h2 class="text-xs font-medium tracking-widest text-[#e8e8e8] uppercase">Mode</h2>

			<div class="flex gap-3">
				<button
					onclick={() => trySetMode('battery')}
					class="flex-1 rounded-sm border py-2 text-sm font-medium transition-colors {mode ===
					'battery'
						? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
						: 'border-[#333] text-[#888] hover:border-[#555] hover:text-[#e8e8e8]'}"
				>
					Battery Only
				</button>
				<button
					onclick={() => trySetMode('solar')}
					class="flex-1 rounded-sm border py-2 text-sm font-medium transition-colors {mode ===
					'solar'
						? 'border-[#f59e0b] bg-[#f59e0b]/10 text-[#f59e0b]'
						: 'border-[#333] text-[#888] hover:border-[#555] hover:text-[#e8e8e8]'}"
				>
					Battery + Solar
				</button>
			</div>

			{#if pendingMode}
				<p class="text-sm text-[#888]">
					Switching modes will clear your current results.
					<button
						onclick={() => applyMode(pendingMode!)}
						class="ml-1 text-[#f59e0b] hover:underline">Confirm</button
					>
					<button onclick={() => (pendingMode = null)} class="ml-1 text-[#888] hover:text-[#e8e8e8]"
						>Cancel</button
					>
				</p>
			{/if}
		</section>

		<!-- ── 4. Solar Inputs ────────────────────────────────────────────────── -->
		{#if mode === 'solar'}
			<section class="space-y-4">
				<h2 class="text-xs font-medium tracking-widest text-[#e8e8e8] uppercase">
					Solar Parameters
				</h2>

				<div class="space-y-2 rounded-sm border border-[#2a2a2a] bg-[#141414] p-3">
					<div class="space-y-0.5">
						<h4 class="text-sm font-semibold tracking-wide text-[#e8e8e8]">Location</h4>
						<p class="text-xs text-[#888]">Use either of the methods below.</p>
					</div>

					<div>
						<div class="flex items-center gap-3 pt-1 pb-2">
							<div class="h-px flex-1 bg-[#2a2a2a]"></div>
							<label
								for="placeQuery"
								class="text-xs font-medium tracking-widest text-[#888] uppercase"
							>
								search by city or zip
							</label>
							<div class="h-px flex-1 bg-[#2a2a2a]"></div>
						</div>
						<div class="mt-1 flex flex-wrap items-stretch gap-2">
							<div class="flex min-w-55 flex-1 gap-2">
								<input
									id="placeQuery"
									type="text"
									bind:value={placeQuery}
									onkeydown={(e) => {
										if (e.key === 'Enter') {
											e.preventDefault();
											searchPlace();
										}
									}}
									placeholder="e.g. Madison, WI or 53703"
									class="flex-1 rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
								/>
								<button
									type="button"
									onclick={searchPlace}
									disabled={placeSearching || !placeQuery.trim()}
									class="rounded-sm border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-3 py-1.5 text-sm text-[#f59e0b] hover:bg-[#f59e0b]/20 disabled:opacity-50"
								>
									{placeSearching ? 'Searching…' : 'Find'}
								</button>
							</div>
							<button
								type="button"
								onclick={useMyLocation}
								class="rounded-sm border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-3 py-1.5 text-sm text-[#f59e0b] hover:bg-[#f59e0b]/20"
								title="Use this device's current GPS location"
							>
								Use my location
							</button>
						</div>
						{#if placeError}
							<p class="mt-0.5 text-xs text-red-400">{placeError}</p>
						{/if}
					</div>

					<div class="flex items-center gap-3 pt-2 pb-1">
						<div class="h-px flex-1 bg-[#2a2a2a]"></div>
						<span class="text-xs font-medium tracking-widest text-[#888] uppercase">
							or enter coordinates manually
						</span>
						<div class="h-px flex-1 bg-[#2a2a2a]"></div>
					</div>

					<div class="grid grid-cols-2 gap-4">
						<div>
							<label class="block text-xs text-[#aaa]" for="lat">
								{@render term('Latitude', 'def-latlong')}
								<span class="ml-1 text-[#666]">(-90 to 90, positive = north)</span>
							</label>
							<input
								id="lat"
								type="number"
								bind:value={lat}
								placeholder="Enter latitude"
								step="any"
								class="mt-1 w-full rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
							/>
							{#if errors.lat}<p data-field-error class="mt-0.5 text-xs text-red-400">
									{errors.lat}
								</p>{/if}
						</div>
						<div>
							<label class="block text-xs text-[#aaa]" for="long">
								{@render term('Longitude', 'def-latlong')}
								<span class="ml-1 text-[#666]">(-180 to 180, positive = east)</span>
							</label>
							<input
								id="long"
								type="number"
								bind:value={long}
								placeholder="Enter longitude"
								step="any"
								class="mt-1 w-full rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
							/>
							{#if errors.long}<p data-field-error class="mt-0.5 text-xs text-red-400">
									{errors.long}
								</p>{/if}
						</div>
					</div>
				</div>

				{#if readableCoords()}
					<div class="space-y-0.5">
						<p class="font-mono text-xs text-[#888]">
							<span class="text-[#aaa]">Coordinates:</span>
							<span class="text-[#e8e8e8]">{readableCoords()}</span>
						</p>
						{#if nearestLooking && !nearestPlace && !nearestUnpopulated}
							<p class="text-xs text-[#666] italic">Looking up nearest place…</p>
						{:else if nearestPlace}
							<p class="text-xs text-[#888]">
								<span class="text-[#aaa]">Nearest place:</span>
								<span class="text-[#e8e8e8]">{nearestPlace}</span>
							</p>
						{:else if nearestUnpopulated}
							<p class="text-xs text-amber-400">
								⚠ No nearby populated place found. This may be open water or a remote area;
								double-check your coordinates if that's not what you intended.
							</p>
						{/if}
					</div>
				{/if}

				{#if geoError}
					<p class="text-xs text-red-400">{geoError}</p>
				{/if}

				<div>
					<label class="block text-xs text-[#e8e8e8]" for="worstDays">
						{@render term('Number of worst days', 'def-worst')} (N)
						<span class="ml-1 text-[#aaa]">(appended at end of simulation as worst-case days)</span>
					</label>
					<input
						id="worstDays"
						type="number"
						bind:value={numWorstDays}
						placeholder="Enter N"
						min="0"
						class="mt-1 w-32 rounded-sm border border-[#333] bg-[#1a1a1a] px-3 py-1.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
					/>
					{#if errors.worstDays}<p data-field-error class="mt-0.5 text-xs text-red-400">
							{errors.worstDays}
						</p>{/if}
				</div>

				<div>
					<p class="text-xs text-[#e8e8e8]">
						{@render term('Panel rating', 'def-panel')} ({@render term('W', 'def-w')})
					</p>
					<div class="mt-1 flex flex-wrap gap-1.5">
						{#each PANEL_PRESETS as preset (preset)}
							<button
								onclick={() => {
									panelPreset = preset;
									useCustomPanel = false;
								}}
								class="rounded-sm border px-3 py-1 text-sm transition-colors {!useCustomPanel &&
								panelPreset === preset
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
					{#if errors.panel}<p data-field-error class="mt-0.5 text-xs text-red-400">
							{errors.panel}
						</p>{/if}
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
			<section
				class="space-y-5 rounded-sm border-2 border-[#f59e0b]/40 bg-[#1a1a1a] p-5 shadow-[0_0_0_4px_rgba(245,158,11,0.04)]"
			>
				<div class="flex items-baseline justify-between gap-2 border-b border-[#2a2a2a] pb-2">
					<h2 class="text-base font-semibold tracking-wide text-[#f59e0b]">Results</h2>
					<span class="text-xs tracking-widest text-[#888] uppercase">Battery Only</span>
				</div>

				<div>
					<h3 class="text-sm font-medium text-[#e8e8e8]">Battery per group</h3>
					<p class="mb-2 text-xs text-[#888]">
						{provideBattery
							? 'Recharges with your battery, plus the no-recharge minimum. Use one per group.'
							: 'Smallest single battery that lasts the whole experiment. Use one per group.'}
					</p>
					<ResultsTable
						mode="battery"
						experimentDays={totalDays()}
						{term}
						groups={batteryResult.groups.map((g, i) => ({
							name: groupName(i),
							dailyUseWh: g.dailyEnergyWh,
							minCapacityWh: g.minCapacityWh,
							rechargesNeeded: g.rechargesNeeded,
							runtimePerChargeDays:
								committedUserBattery && committedUserBattery > 0 && g.dailyEnergyWh > 0
									? committedUserBattery / g.dailyEnergyWh
									: undefined
						}))}
					/>
				</div>
			</section>
		{/if}

		{#if mode === 'solar' && solarResultN && solarResultAll && batteryResult}
			<section
				class="space-y-6 rounded-sm border-2 border-[#f59e0b]/40 bg-[#1a1a1a] p-5 shadow-[0_0_0_4px_rgba(245,158,11,0.04)]"
			>
				<div class="flex items-baseline justify-between gap-2 border-b border-[#2a2a2a] pb-2">
					<h2 class="text-base font-semibold tracking-wide text-[#f59e0b]">Results</h2>
					<span class="text-xs tracking-widest text-[#888] uppercase">Battery + Solar</span>
				</div>

				<div>
					<h3 class="text-sm font-medium text-[#e8e8e8]">Recommended battery per group</h3>
					<p class="mb-2 text-xs text-[#888]">
						Smallest single battery that survives. Use one per group.
					</p>
					<ResultsTable
						mode="solar"
						{committedWorstDays}
						groups={batteryResult.groups.map((g, i) => ({
							name: groupName(i),
							dailyUseWh: g.dailyEnergyWh,
							minCapacityBatteryOnly: g.minCapacityWh,
							minCapacityN: solarResultN!.groups[i].minCapacityWh,
							minCapacityAll: solarResultAll!.groups[i].minCapacityWh
						}))}
					/>
					{#if committedUserBattery && committedUserBattery > 0}
						<div class="mt-2 rounded-sm border border-[#2a2a2a] bg-[#141414] px-3 py-2 text-xs">
							<p class="mb-1 text-[#aaa]">
								Your battery ({committedUserBattery.toLocaleString()} Wh) vs the worst-stretch need:
							</p>
							{#each solarResultN.groups as g, i (i)}
								{@const need = g.minCapacityWh ?? 0}
								{@const ok = committedUserBattery >= need}
								<div class="flex justify-between py-0.5">
									<span class="text-[#bbb]">{groupName(i)}</span>
									<span class="font-mono {ok ? 'text-[#5fa87a]' : 'text-[#d08770]'}">
										{ok
											? `enough (+${Math.round(committedUserBattery - need).toLocaleString()} Wh)`
											: `short by ${Math.ceil(need - committedUserBattery).toLocaleString()} Wh`}
									</span>
								</div>
							{/each}
						</div>
					{/if}
					<div class="mt-3 space-y-1 text-xs text-[#888]">
						<p>
							Solar data comes from NASA's {@render term('POWER API', 'def-nasa')}, using the three
							previous years over your date range. For ranges shorter than a month, the worst days
							are drawn from a one-month window centered on your dates.
						</p>
						<p>
							{@render term('Worst stretch', 'def-worststretch')} takes the {committedWorstDays} lowest-sunlight
							day{committedWorstDays === 1 ? '' : 's'} in that data, each a different day, and places
							{committedWorstDays === 1 ? 'it' : 'them'} back-to-back at the end of your experiment (the
							realistic plan).
						</p>
						<p>
							{@render term('Worst case', 'def-worstcase')} assumes every day is as low as the single
							lowest-sunlight day in that data (a deliberately extreme test).
						</p>
					</div>
				</div>

				<div class="space-y-6 border-t border-[#2a2a2a] pt-4">
					<ChargeGraph
						title="Worst stretch: {committedWorstDays} lowest-sunlight day{committedWorstDays === 1
							? ''
							: 's'} placed at the end"
						groups={solarResultN.groups.map((g, i) => ({
							name: groupName(i),
							chargeHistory: g.chargeHistory!,
							capacityWh: g.minCapacityWh!
						}))}
					/>
					<ChargeGraph
						title="Worst case: every day at the single lowest-sunlight day"
						groups={solarResultAll.groups.map((g, i) => ({
							name: groupName(i),
							chargeHistory: g.chargeHistory!,
							capacityWh: g.minCapacityWh!
						}))}
					/>
				</div>
			</section>
		{/if}

		<!-- ── 7. Reference & background (methodology + positioning + definitions) ── -->
		<section
			class="space-y-4 rounded-sm border border-[#f59e0b]/25 bg-[#141414] p-5 shadow-[0_0_0_4px_rgba(245,158,11,0.03)]"
		>
			<div>
				<h2 class="text-xs font-semibold tracking-widest text-[#f59e0b] uppercase">
					Reference & background
				</h2>
				<p class="mt-1.5 text-xs leading-relaxed text-[#aaa]">
					How this calculator works, field tips for deploying panels, and definitions of every term
					used above. Click any section to expand it.
				</p>
			</div>

			<div class="border-t border-[#2a2a2a] pt-4">
				<button
					onclick={() => (methodologyOpen = !methodologyOpen)}
					class="flex w-full items-center gap-2 text-left text-sm font-medium text-[#aaa] transition-colors hover:text-[#e8e8e8]"
				>
					<span class="font-mono text-xs text-[#666]">{methodologyOpen ? '▼' : '▶'}</span>
					How is this calculated?
				</button>

				{#if methodologyOpen}
					<div class="mt-4 space-y-3 text-sm leading-relaxed text-[#888]">
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								{@render term('Solar irradiance', 'def-irradiance')} data
							</p>
							<p>
								Hourly {@render term('irradiance', 'def-irradiance')} (kWh/m²) is fetched from the {@render term(
									'NASA POWER API',
									'def-nasa'
								)} using the ALLSKY_SFC_SW_DWN parameter, over the same seasonal date range for the three
								most recent complete years.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Average vs worst case
							</p>
							<p>
								For each hour of the day, the average profile takes the mean {@render term(
									'irradiance',
									'def-irradiance'
								)} across all matching days and years. The worst days are the actual lowest-sunlight days
								from the pulled data (the three previous years near your dates), each keeping its real
								hourly shape, so they are realistic days rather than a synthetic worst hour.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Solar panel output
							</p>
							<p>
								Panel output ({@render term('Wh', 'def-wh')}) =
								{@render term('irradiance', 'def-irradiance')} ×
								{@render term('panel rating', 'def-panel')} ×
								{@render term('number of panels', 'def-numpanels')} × 80% {@render term(
									'solar efficiency',
									'def-eff'
								)}.
							</p>
							<p class="mt-1 font-mono text-xs text-[#777]">
								e.g. 0.5 kWh/m² × 100 W × 2 panels × 0.8 = 80 Wh in that hour
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Hour-by-hour simulation
							</p>
							<p>
								The {@render term('battery', 'def-bank')} charges when solar output exceeds device load
								and discharges otherwise. Energy beyond the battery's total
								{@render term('capacity', 'def-wh')} is lost. A configurable
								{@render term('safety margin', 'def-safety')} (default 30%) is applied to device {@render term(
									'power draw',
									'def-w'
								)}, and a flat {@render term('circuit loss', 'def-circuit')} (15%) is applied to the battery
								side so that usable battery energy is ~85% of nameplate.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								{@render term('N worst days', 'def-worst')} scenario
							</p>
							<p>
								The first (total days − N) days use the average hourly profile. The final N days use
								the N distinct worst days (the N lowest-sunlight days from the pulled data, worst to
								least), one after another. The charge state carries over naturally between days.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								All worst days scenario
							</p>
							<p>
								Every day uses the single lowest-sunlight day from the pulled data. This is the
								deliberately extreme stress test for the system.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Finding the recommended battery
							</p>
							<p>
								A binary search finds the smallest battery capacity (in Wh) that keeps the charge
								above zero across the whole simulation. The result is the recommended size for a
								single battery per group; in battery-only mode the calculator instead reports how
								many times your battery must be recharged.
							</p>
						</div>
					</div>
				{/if}
			</div>

			<div class="border-t border-[#2a2a2a] pt-4">
				<button
					onclick={() => (positioningOpen = !positioningOpen)}
					class="flex w-full items-center gap-2 text-left text-sm font-medium text-[#aaa] transition-colors hover:text-[#e8e8e8]"
				>
					<span class="font-mono text-xs text-[#666]">{positioningOpen ? '▼' : '▶'}</span>
					Solar panel positioning tips
				</button>

				{#if positioningOpen}
					<div class="mt-4 space-y-3 text-sm leading-relaxed text-[#888]">
						<p class="text-[#aaa]">
							A perfectly sized system still under-performs if the panels are pointed wrong, tilted
							poorly, or partly shaded. These rules of thumb are the biggest levers. None of them
							have to be exact, but getting them roughly right makes a real difference.
						</p>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Facing direction
							</p>
							<p>
								In the Northern Hemisphere (positive latitude), aim panels at <em>true south</em>.
								In the Southern Hemisphere (negative latitude), aim at <em>true north</em>. True
								south&thinsp;/&thinsp;north is not the same as magnetic south&thinsp;/&thinsp;north;
								the two can differ by 10–20° depending on where you are, so check the magnetic
								declination for your site if you're aligning with a compass. Near the equator, the
								optimal direction matters less and a near-flat panel works well. Within roughly ±20°
								of true south&thinsp;/&thinsp;north the loss is small, so don't worry about being
								pixel-perfect.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Tilt angle
							</p>
							<p>
								<span class="font-semibold text-[#aaa]">Tilt</span> is the angle between the panel
								face and the flat ground. <span class="font-semibold text-[#aaa]">0°</span> means
								the panel is lying flat, face pointed straight up at the sky.
								<span class="font-semibold text-[#aaa]">90°</span>
								means the panel is standing on its edge, perpendicular to the ground (its face pointed
								sideways at the horizon).
							</p>
							<div
								class="my-2 space-y-1 rounded-sm border border-[#2a2a2a] bg-[#141414] py-3 font-mono text-xs text-[#888]"
							>
								<div class="flex items-end justify-around gap-3">
									<div class="flex flex-col items-center gap-1">
										<svg width="84" height="60" viewBox="0 0 84 60" aria-hidden="true">
											<line x1="6" y1="50" x2="78" y2="50" stroke="#555" stroke-width="1.5" />
											<!-- Panel sits directly on the ground (bottom at y=50) -->
											<rect x="18" y="47" width="48" height="3" fill="#f59e0b" />
											<!-- Sun above (face is up) -->
											<g>
												<circle cx="42" cy="14" r="3" fill="#fbbf24" />
												<g stroke="#fbbf24" stroke-width="1.2" stroke-linecap="round">
													<line x1="42" y1="6" x2="42" y2="8" />
													<line x1="42" y1="20" x2="42" y2="22" />
													<line x1="34" y1="14" x2="36" y2="14" />
													<line x1="48" y1="14" x2="50" y2="14" />
													<line x1="36.5" y1="8.5" x2="37.7" y2="9.7" />
													<line x1="46.3" y1="9.7" x2="47.5" y2="8.5" />
													<line x1="36.5" y1="19.5" x2="37.7" y2="18.3" />
													<line x1="46.3" y1="18.3" x2="47.5" y2="19.5" />
												</g>
											</g>
											<!-- Sun rays hitting the face (extend down to the panel top) -->
											<g stroke="#fbbf24" stroke-width="0.7" stroke-dasharray="2,2" opacity="0.6">
												<line x1="34" y1="24" x2="34" y2="45" />
												<line x1="42" y1="24" x2="42" y2="45" />
												<line x1="50" y1="24" x2="50" y2="45" />
											</g>
											<text x="66" y="34" text-anchor="middle" font-size="12" fill="#aaa">0°</text>
										</svg>
										<span>flat (face up)</span>
									</div>
									<div class="flex flex-col items-center gap-1">
										<svg width="84" height="60" viewBox="0 0 84 60" aria-hidden="true">
											<line x1="6" y1="50" x2="78" y2="50" stroke="#555" stroke-width="1.5" />
											<g transform="rotate(-43 18 50)">
												<rect x="18" y="48.5" width="48" height="3" fill="#f59e0b" />
											</g>
											<!-- Sun upper-left (face points up-left after -43° rotation) -->
											<g>
												<circle cx="14" cy="12" r="3" fill="#fbbf24" />
												<g stroke="#fbbf24" stroke-width="1.2" stroke-linecap="round">
													<line x1="14" y1="4" x2="14" y2="6" />
													<line x1="14" y1="18" x2="14" y2="20" />
													<line x1="6" y1="12" x2="8" y2="12" />
													<line x1="20" y1="12" x2="22" y2="12" />
													<line x1="8.5" y1="6.5" x2="9.7" y2="7.7" />
													<line x1="18.3" y1="7.7" x2="19.5" y2="6.5" />
													<line x1="8.5" y1="17.5" x2="9.7" y2="16.3" />
													<line x1="18.3" y1="16.3" x2="19.5" y2="17.5" />
												</g>
											</g>
											<!-- Three parallel rays perpendicular to the tilted panel face.
											     Direction vector (14, 15) is at ~47° from horizontal, which is
											     90° to the -43° panel surface. -->
											<g stroke="#fbbf24" stroke-width="0.7" stroke-dasharray="2,2" opacity="0.6">
												<line x1="21" y1="19" x2="35" y2="34" />
												<line x1="27" y1="14" x2="41" y2="29" />
												<line x1="15" y1="24" x2="29" y2="39" />
											</g>
											<!-- Angle arc -->
											<path
												d="M 34 50 A 16 16 0 0 0 29.3 38.9"
												fill="none"
												stroke="#888"
												stroke-width="0.8"
											/>
											<text x="62" y="40" text-anchor="middle" font-size="12" fill="#aaa">~43°</text
											>
										</svg>
										<span>~latitude</span>
									</div>
									<div class="flex flex-col items-center gap-1">
										<svg width="84" height="60" viewBox="0 0 84 60" aria-hidden="true">
											<line x1="6" y1="50" x2="78" y2="50" stroke="#555" stroke-width="1.5" />
											<rect x="40" y="8" width="3" height="42" fill="#f59e0b" />
											<!-- Sun on the LEFT (face points left when vertical) -->
											<g>
												<circle cx="14" cy="28" r="3" fill="#fbbf24" />
												<g stroke="#fbbf24" stroke-width="1.2" stroke-linecap="round">
													<line x1="14" y1="20" x2="14" y2="22" />
													<line x1="14" y1="34" x2="14" y2="36" />
													<line x1="6" y1="28" x2="8" y2="28" />
													<line x1="20" y1="28" x2="22" y2="28" />
													<line x1="8.5" y1="22.5" x2="9.7" y2="23.7" />
													<line x1="18.3" y1="23.7" x2="19.5" y2="22.5" />
													<line x1="8.5" y1="33.5" x2="9.7" y2="32.3" />
													<line x1="18.3" y1="32.3" x2="19.5" y2="33.5" />
												</g>
											</g>
											<!-- Horizontal rays hitting the left face of the vertical panel -->
											<g stroke="#fbbf24" stroke-width="0.7" stroke-dasharray="2,2" opacity="0.6">
												<line x1="22" y1="18" x2="38" y2="18" />
												<line x1="22" y1="28" x2="38" y2="28" />
												<line x1="22" y1="38" x2="38" y2="38" />
											</g>
											<!-- Angle arc -->
											<path
												d="M 56 50 A 16 16 0 0 0 43 36"
												fill="none"
												stroke="#888"
												stroke-width="0.8"
											/>
											<text x="66" y="30" text-anchor="middle" font-size="12" fill="#aaa">90°</text>
										</svg>
										<span>vertical</span>
									</div>
								</div>
								<p class="mt-4 px-3 text-center text-xs text-[#888]">
									<svg
										class="inline-block align-middle"
										width="16"
										height="16"
										viewBox="0 0 14 14"
										aria-hidden="true"
									>
										<circle cx="7" cy="7" r="2.5" fill="#fbbf24" />
										<g stroke="#fbbf24" stroke-width="1.2" stroke-linecap="round">
											<line x1="7" y1="1.5" x2="7" y2="3" />
											<line x1="7" y1="11" x2="7" y2="12.5" />
											<line x1="1.5" y1="7" x2="3" y2="7" />
											<line x1="11" y1="7" x2="12.5" y2="7" />
											<line x1="3" y1="3" x2="4" y2="4" />
											<line x1="10" y1="4" x2="11" y2="3" />
											<line x1="3" y1="11" x2="4" y2="10" />
											<line x1="10" y1="10" x2="11" y2="11" />
										</g>
									</svg>
									= where the panel face points (the glass / sun-catching side)
								</p>
							</div>
							<p>
								A reasonable year-round tilt is roughly <em>equal to your latitude</em> (e.g.&nbsp;~43°
								at Madison, Wisconsin). It does not need to be exact (within ~10° of latitude only costs
								a few percent of annual output) so being roughly right matters far more than getting the
								exact degree.
							</p>
							<p class="mt-1">
								If most of your energy demand falls in <em>winter</em> (when the sun is low in the
								sky), add about 15° to your tilt to face it. If most of your demand falls in
								<em>summer</em> (when the sun is high overhead), subtract about 15°. By
								<em>winter&thinsp;/&thinsp;summer-heavy</em> we mean the season when you most need power,
								not just when you're deployed. Near the spring and fall equinoxes the sun tracks close
								to the celestial equator, so a tilt equal to your latitude is already near-optimal and
								no seasonal adjustment is needed. A small tilt also helps panels self-clean in the rain.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Avoid shading (this one really matters)
							</p>
							<p>
								<span class="font-semibold text-[#aaa]"
									>Keep the panel completely clear of obstructions.</span
								>
								Even a tiny shadow, from a single leaf, a thin tree branch, a fence wire, an antenna,
								or a nearby pole, can dramatically cut a panel's output, often by far more than the shaded
								area would suggest. This is because the cells inside a panel are wired in series. Think
								of it like cars on a single-lane road: every car behind a slow one is stuck moving at
								the slow car's speed, no matter how fast they could otherwise go. In a panel, every cell
								in the string is throttled to whatever the worst-lit cell can produce, so shading just
								one cell can choke the entire panel.
							</p>
							<p class="mt-1">
								Trace the sun's path across the sky for every season you'll be deployed, not just at
								install time, and check that no tree, building, equipment box, or piece of
								vegetation will cast a shadow at any time of day. When in doubt, give the panel more
								open sky.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Keep them clean
							</p>
							<p>
								Dust, bird droppings, pollen, snow, and fallen leaves all reduce output. In dusty or
								rural deployments, plan for periodic cleaning or de-rate the system further with the
								safety margin above.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Mounting and ventilation
							</p>
							<p>
								Hot panels are less efficient. Leave a small air gap behind the panel so it can shed
								heat, and secure it well enough to handle local wind loads. Cables should be strain-
								relieved and shaded from direct sun where possible.
							</p>
						</div>
					</div>
				{/if}
			</div>

			<div class="border-t border-[#2a2a2a] pt-4">
				<button
					onclick={() => (wiringOpen = !wiringOpen)}
					class="flex w-full items-center gap-2 text-left text-sm font-medium text-[#aaa] transition-colors hover:text-[#e8e8e8]"
				>
					<span class="font-mono text-xs text-[#666]">{wiringOpen ? '▼' : '▶'}</span>
					Wiring &amp; battery tips
				</button>
				{#if wiringOpen}
					<div class="mt-4 space-y-3 text-sm leading-relaxed text-[#888]">
						<p class="text-[#aaa]">
							One battery per group is the safe default. A few field rules keep losses and hazards
							down.
						</p>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Prefer one battery
							</p>
							<p>
								Use a single battery of the recommended capacity for each group. If you need more
								capacity, reach for one larger battery rather than wiring several together.
								Connecting batteries in parallel is genuinely hazardous for the unpracticed: any
								difference in charge, age, or internal resistance between them drives a large
								current from one battery into another, which can overheat cells, melt connectors,
								vent or rupture a battery, and in the worst case start a fire. (Series wiring is
								safer but raises the voltage and brings its own pitfalls.) A single larger battery
								sidesteps all of this. When in doubt, size up one battery rather than combining
								several.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Keep wire runs short and thick
							</p>
							<p>
								The calculator assumes a fixed ~15% circuit loss, which suits a well-wired setup.
								Long or thin wires add voltage drop on top of that: keep the battery close to the
								devices, use an adequate wire gauge, and minimize the run length. Doubling a run
								roughly doubles its wiring loss. As a rough guide on a 12 V system, runs under ~25
								ft on adequate wire usually stay within the assumed loss; by ~50 ft on thin wire the
								extra drop can reach several percent, and past ~100 ft it can rival the 15% circuit
								loss itself, so shorten the run, step up the wire gauge, or use a higher battery
								voltage.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								One battery, one cluster
							</p>
							<p>
								Don't power devices that sit far apart from a single battery. Give each cluster its
								own group and its own battery, so no long cable has to carry current across the
								field.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Connections and protection
							</p>
							<p>
								Use secure, weatherproof connectors, strain-relieve cables, and add an appropriately
								rated fuse close to the battery terminal. Good connections matter as much as the
								right capacity.
							</p>
						</div>
					</div>
				{/if}
			</div>

			<div class="border-t border-[#2a2a2a] pt-4">
				<button
					onclick={() => (definitionsOpen = !definitionsOpen)}
					class="flex w-full items-center gap-2 text-left text-sm font-medium text-[#aaa] transition-colors hover:text-[#e8e8e8]"
				>
					<span class="font-mono text-xs text-[#666]">{definitionsOpen ? '▼' : '▶'}</span>
					Definitions
				</button>

				{#if definitionsOpen}
					<dl class="mt-4 space-y-3 text-sm leading-relaxed text-[#888]">
						<div id="def-w" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Watt (W) - power
							</dt>
							<dd>
								The instantaneous rate of energy use. A 4 W device consumes 4 joules every second.
								Power draw is constant in this model. The device is always on.
							</dd>
						</div>

						<div id="def-wh" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Watt-hour (Wh) - energy
							</dt>
							<dd>
								Energy used (or stored) over time. 1 Wh = running 1 W for 1 hour. Battery capacity
								is measured in Wh. The optional battery input above is the capacity of one battery.
								The calculator recommends a single battery per group; the default Calculate the
								minimum for me reports the smallest battery that works. A single 1000 Wh battery can
								power a 4 W device for about 250 hours (1000 ÷ 4) in ideal conditions.
							</dd>
							<dd class="mt-1 font-mono text-xs text-[#666]">
								Wh = W × hours · e.g. 4 W × 24 h = 96 Wh/day
							</dd>
						</div>

						<div id="def-ah" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Amp-hour (Ah) - charge
							</dt>
							<dd>
								A measure of charge often printed on lead-acid and lithium batteries. By itself it
								doesn't tell you how much energy is stored. You also need the battery's nominal
								voltage.
							</dd>
							<dd class="mt-1 font-mono text-xs text-[#666]">
								Ah × V = Wh · e.g. 100 Ah × 12 V = 1200 Wh
							</dd>
						</div>

						<div id="def-v" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Volt (V) - nominal voltage
							</dt>
							<dd>
								The battery's nominal voltage (commonly 12 V, 24 V, or 48 V for off-grid systems).
								Multiply Ah by V to get the Wh capacity used by this calculator.
							</dd>
						</div>

						<div id="def-irradiance" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								SOLAR IRRADIANCE (kWh/m²)
							</dt>
							<dd>
								The solar energy striking one square metre of ground in a given hour. A clear noon
								hour might be ~1 kWh/m²; a cloudy morning closer to 0.1 kWh/m². This calculator
								treats the panel rating as the wattage produced under 1 kW/m² of irradiance, then
								scales linearly with the actual irradiance value.
							</dd>
						</div>

						<div id="def-panel" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Panel rating (W)
							</dt>
							<dd>
								The peak wattage a solar panel produces under standard test conditions (1 kW/m²
								irradiance, 25 °C). A "100 W" panel rarely delivers 100 W in the field; actual
								output depends on irradiance and system losses.
							</dd>
						</div>

						<div id="def-numpanels" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Number of panels
							</dt>
							<dd>
								How many identical panels are wired into a single group. Output is assumed to scale
								linearly: two 100 W panels behave like one 200 W panel.
							</dd>
						</div>

						<div id="def-eff" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Solar efficiency (80%)
							</dt>
							<dd>
								A flat de-rating applied to raw panel output to account for PV-side wiring losses,
								charge controller / inverter inefficiency, soiling, and temperature effects. 80% is
								a common rule-of-thumb for well-installed off-grid systems. Applies to solar
								generation only.
							</dd>
						</div>

						<div id="def-circuit" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Circuit loss (15%)
							</dt>
							<dd>
								A flat de-rating on the battery side for wiring, conversion, battery internal
								resistance, and self-discharge: usable battery energy is treated as ~85% of
								nameplate capacity. Applies in both battery-only and battery + solar modes, and is
								included in the energy figures above.
							</dd>
						</div>

						<div id="def-safety" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Safety margin (%)
							</dt>
							<dd>
								An extra buffer added to device power draw when sizing batteries. A 30% margin
								treats a 4 W device as if it draws 5.2 W, so the system is sized against unexpected
								load spikes or under-performance.
							</dd>
						</div>

						<div id="def-sizeband" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Battery size (lasts per charge)
							</dt>
							<dd>
								In battery-only mode with your own battery, the <em>lasts per charge</em> value is
								colored to show how well that size suits fieldwork, based on how long the battery
								runs before a recharge or swap (R) versus your experiment length (E).
								<span class="mt-1 block"
									><span style="color:#f87171">Too small</span>: R is under min(3 days, a third of
									the run); you would swap every couple of days or less, usually impractical.</span
								>
								<span class="block"
									><span style="color:#fb923c">Frequent swaps</span>: under min(7 days, half the
									run); workable, but you will recharge often.</span
								>
								<span class="block"
									><span style="color:#facc15">Periodic swaps</span>: lasts longer than that but not
									the whole run; at least one recharge before the end.</span
								>
								<span class="block"
									><span style="color:#4ade80">Lasts the run</span>: one charge covers the entire
									experiment, so no recharges. The sweet spot.</span
								>
								<span class="block"
									><span style="color:#c084fc">Oversized</span>: more than twice the run; it works,
									but the battery is heavier and pricier than a single deployment needs.</span
								>
							</dd>
						</div>

						<div id="def-group" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">Group</dt>
							<dd>
								A cluster of devices powered by one {@render term('battery', 'def-bank')} (and one set
								of solar panels in solar mode). A group need not be a single site: use separate groups
								whenever devices must run on separate batteries, whether they are far apart or one battery
								cannot power them all.
							</dd>
						</div>

						<div id="def-bank" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Battery (per group)
							</dt>
							<dd>
								The battery for one group. This calculator recommends a single
								{@render term('Wh', 'def-wh')}-rated battery per group, sized in Wh. If you ever
								need more capacity, use one larger battery where possible; wiring several batteries
								together (especially in parallel) is error-prone and best avoided by
								non-specialists. The tool therefore reports a recommended capacity (in Wh) for one
								battery rather than a count of several batteries to wire together.
							</dd>
						</div>

						<div id="def-latlong" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Latitude / Longitude
							</dt>
							<dd>
								Coordinates of your field site, used to look up historical solar irradiance.
								Latitude is north–south (−90 to 90); longitude is east–west (−180 to 180).
							</dd>
						</div>

						<div id="def-worst" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Number of worst days (N)
							</dt>
							<dd>
								How many low-sunlight days to string together at the end of the simulation. The
								calculator picks the N lowest-sunlight days from the data it pulled, the three
								previous years over your dates, widened to a one-month window for short experiments,
								each a different real day, worst first. Putting them at the <em>end</em> is the toughest
								timing, because the battery has the least chance to recharge afterward.
							</dd>
						</div>

						<div id="def-worststretch" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Worst stretch
							</dt>
							<dd>
								The realistic bad-weather plan. The calculator takes the N lowest-sunlight days from
								the data it pulled (the three previous years near your dates, widened to a one-month
								window for short experiments), each a different real day, and runs them back-to-back
								at the end of the experiment, when the battery has had the least chance to recharge.
							</dd>
						</div>

						<div id="def-worstcase" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">Worst case</dt>
							<dd>
								A deliberately extreme stress test. Every single day of the experiment is treated as
								low-sunlight as the single worst day in the pulled data. Real deployments almost
								never see this, but a system that survives it will survive anything in that sample.
							</dd>
						</div>

						<div id="def-nasa" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								NASA POWER API
							</dt>
							<dd>
								A public NASA dataset providing hourly historical solar and meteorological data
								anywhere on Earth. This calculator queries the
								<span class="font-mono text-[#aaa]">ALLSKY_SFC_SW_DWN</span> parameter (all-sky surface
								shortwave downward irradiance) for the three most recent complete years in the same seasonal
								window as the user's date range.
							</dd>
						</div>
					</dl>
				{/if}
			</div>
		</section>
	</div>
</div>
