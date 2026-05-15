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
	// Snapshot of battery Wh at calculate-time; reassigned in calculate().
	let committedBatteryCapacity = $state<number>(1000);
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

		if (effectiveBattery() <= 0) errs.battery = 'Battery capacity must be greater than 0.';

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
			batteryResult = calculateBatteryOnly(
				start,
				end,
				devicesPerGroup,
				effectiveBattery(),
				devicePowerW,
				1 + safetyMarginPct / 100
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
			committedBatteryCapacity = effectiveBattery();
			const margin = 1 + safetyMarginPct / 100;
			[solarResultN, solarResultAll] = await Promise.all([
				calculateWithSolar(
					start,
					end,
					devicesPerGroup,
					effectiveBattery(),
					solarData,
					numWorstDays,
					effectivePanel,
					panels,
					devicePowerW,
					margin
				),
				calculateWithSolar(
					start,
					end,
					devicesPerGroup,
					effectiveBattery(),
					solarData,
					days,
					effectivePanel,
					panels,
					devicePowerW,
					margin
				)
			]);

			// Keep battery-only for "reduction vs battery-only" comparison
			batteryResult = calculateBatteryOnly(
				start,
				end,
				devicesPerGroup,
				effectiveBattery(),
				devicePowerW,
				margin
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

<div class="min-h-screen bg-[#0f0f0f] px-4 py-8 text-[#e8e8e8]">
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
					Battery capacity ({@render term('Wh', 'def-wh')})
				</p>
				<div class="mt-1 flex flex-wrap gap-1.5">
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
					).toFixed(2)} W effective draw per device
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
					<strong class="text-[#e8e8e8]">Most users only need one group.</strong> A
					{@render term('group', 'def-group')} is any cluster of devices sharing one
					{@render term('battery bank', 'def-bank')}{#if mode === 'solar'}&nbsp;and <em
							>one set of solar panels</em
						>{/if}. A battery bank can be a single battery or several batteries wired together (the
					results below tell you how many batteries the bank needs to hold). The number of
					<em>devices</em> in the group is how many devices that bank has to power.
				</p>
				<p>
					Use <strong class="text-[#e8e8e8]">multiple groups</strong> to split your devices across more
					than one independent battery bank. That can be because they're deployed at separate sites (e.g.&nbsp;two
					field stations a kilometer apart), or simply because one bank can't power them all. Each group
					is sized independently in the results below.
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
					<p class="text-xs font-medium text-[#e8e8e8]">
						Location
						<span class="ml-1 font-normal text-[#888]">
							(set it by city / zip, by GPS, or by entering coordinates directly)
						</span>
					</p>

					<div>
						<label class="block text-xs text-[#aaa]" for="placeQuery">
							Search by city, town, or zip code
						</label>
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

					<p class="pt-1 text-xs text-[#888]">Or enter latitude and longitude directly:</p>

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
					<h3 class="mb-2 text-sm font-medium text-[#e8e8e8]">
						Batteries per group
						<span class="ml-1 text-xs font-normal text-[#888]"
							>(how many batteries each group's bank must contain)</span
						>
					</h3>
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
			<section
				class="space-y-6 rounded-sm border-2 border-[#f59e0b]/40 bg-[#1a1a1a] p-5 shadow-[0_0_0_4px_rgba(245,158,11,0.04)]"
			>
				<div class="flex items-baseline justify-between gap-2 border-b border-[#2a2a2a] pb-2">
					<h2 class="text-base font-semibold tracking-wide text-[#f59e0b]">Results</h2>
					<span class="text-xs tracking-widest text-[#888] uppercase">Battery + Solar</span>
				</div>

				<div>
					<h3 class="mb-2 text-sm font-medium text-[#e8e8e8]">
						Batteries per group
						<span class="ml-1 text-xs font-normal text-[#888]"
							>(how many batteries each group's bank must contain)</span
						>
					</h3>
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
						title="Simulation: {committedWorstDays} worst day{committedWorstDays === 1 ? '' : 's'}"
						groups={solarResultN.groups.map((g, i) => ({
							name: groupName(i),
							chargeHistory: g.chargeHistory!,
							numBatteries: g.numBatteriesNeededWithSolar!
						}))}
						batteryCapacityWh={committedBatteryCapacity}
					/>
					<ChargeGraph
						title="Simulation: all worst days"
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
								)} using the ALLSKY_SFC_SW_DWN parameter, over the same seasonal date range for the years
								2023–2025.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Average vs worst case
							</p>
							<p>
								For each hour of the day, the average profile takes the mean
								{@render term('irradiance', 'def-irradiance')} across all matching days and years. The
								worst-case profile takes the single lowest observed value for that hour.
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
									'system efficiency',
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
								The {@render term('battery bank', 'def-bank')} charges when solar output exceeds device
								load and discharges otherwise. Energy beyond the bank's total
								{@render term('capacity', 'def-wh')} is lost. A configurable
								{@render term('safety margin', 'def-safety')} (default 30%) is applied to device {@render term(
									'power draw',
									'def-w'
								)}.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								{@render term('N worst days', 'def-worst')} scenario
							</p>
							<p>
								The first (total days − N) days use the average hourly profile. The final N days use
								the worst-case profile. The bank's charge state carries over naturally between days.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								All worst days scenario
							</p>
							<p>
								Every day uses the worst-case hourly profile. This is the maximum stress test for
								the system.
							</p>
						</div>
						<div>
							<p class="mb-0.5 text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Finding the minimum batteries
							</p>
							<p>
								A binary search is run over candidate battery counts. Each candidate is interpreted
								as a battery bank made of that many batteries wired together. For each candidate,
								the full simulation is executed. The smallest count that keeps the bank from running
								out of charge is used.
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
											<!-- Rays hitting the upper-left edge of the tilted panel -->
											<g stroke="#fbbf24" stroke-width="0.7" stroke-dasharray="2,2" opacity="0.6">
												<line x1="18" y1="18" x2="26" y2="32" />
												<line x1="25" y1="16" x2="34" y2="26" />
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
								is measured in Wh. The "Battery capacity" input above is the capacity of one
								individual battery; a {@render term('battery bank', 'def-bank')} of N such batteries holds
								N times that capacity. A single 1000 Wh battery can power a 4 W device for about 250 hours
								(1000 ÷ 4) in ideal conditions.
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
								System efficiency (80%)
							</dt>
							<dd>
								A flat de-rating applied to raw panel output to account for wiring losses, charge
								controller / inverter inefficiency, soiling, and temperature effects. 80% is a
								common rule-of-thumb for well-installed off-grid systems.
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

						<div id="def-group" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">Group</dt>
							<dd>
								A set of devices powered by a single, shared power system (one
								{@render term('battery bank', 'def-bank')}, plus one set of solar panels in solar
								mode). A group does not have to map to a single physical site. Use multiple groups
								whenever your devices need to be split across more than one independent power
								system, whether because they're at different locations or because one bank can't
								handle them all.
							</dd>
						</div>

						<div id="def-bank" class="px-2 py-1">
							<dt class="text-xs font-medium tracking-wide text-[#e8e8e8] uppercase">
								Battery bank
							</dt>
							<dd>
								The full energy store for one group: one or more individual
								{@render term('Wh', 'def-wh')}-rated batteries wired together so they share the load
								and behave like a single, larger battery. When this calculator says "the bank" or
								"battery bank" it means this whole collection; when it says "batteries" (plural) or
								gives a count, it means the number of individual units that make up the bank. All
								batteries in a bank are assumed to be the same model with the same capacity.
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
								N WORST DAYS
							</dt>
							<dd>
								For each hour of the day, the worst observed irradiance across the historical record
								is taken, and the last N days of the simulation use this worst-case profile. Placing
								the bad stretch right at the <em>end</em> of the deployment is the worst-case timing:
								if the same overcast stretch happened anywhere earlier in the experiment, the battery
								would have had time to recharge afterward and would finish with equal or more energy left.
								By assuming the bad weather comes last (when the battery has the least chance to recover),
								we size the battery for the toughest possible scenario.
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
								shortwave downward irradiance) for 2023–2025 in the same seasonal window as the user's
								date range.
							</dd>
						</div>
					</dl>
				{/if}
			</div>
		</section>
	</div>
</div>
