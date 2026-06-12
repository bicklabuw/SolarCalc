<script lang="ts">
	import { groupColor } from '$lib/colors';
	import type { Snippet } from 'svelte';

	let {
		mode,
		groups,
		committedWorstDays = 0,
		experimentDays = 0,
		term
	}: {
		mode: 'battery' | 'solar';
		groups: {
			name: string;
			dailyUseWh?: number;
			minCapacityWh?: number; // battery-only: no-recharge minimum
			rechargesNeeded?: number; // battery-only, if a battery was supplied
			runtimePerChargeDays?: number; // battery-only, if a battery was supplied
			minCapacityBatteryOnly?: number; // solar: battery-only reference
			minCapacityN?: number; // solar: worst-stretch capacity
			minCapacityAll?: number; // solar: worst-case capacity
		}[];
		committedWorstDays?: number;
		experimentDays?: number;
		term?: Snippet<[string, string]>;
	} = $props();

	const ceil10 = (v: number) => Math.ceil(v / 10) * 10;
	const fmt = (v: number | undefined) => (v == null ? '–' : `${ceil10(v).toLocaleString()} Wh`);
	const fmtDays = (d: number | undefined) =>
		d == null ? '–' : d >= 1 ? `${d.toFixed(1)} days` : `${Math.round(d * 24)} h`;

	// Battery-size verdict for battery-only mode: how a charge length R (days) compares
	// to the experiment length E. Thresholds use min(absolute, relative) so they tighten
	// automatically for short experiments.
	function sizeBand(R: number | undefined, E: number) {
		if (R == null || E <= 0) return null;
		if (R < Math.min(3, E / 3)) return { color: '#f87171', label: 'too small' };
		if (R < Math.min(7, E / 2)) return { color: '#fb923c', label: 'frequent swaps' };
		if (R < E) return { color: '#facc15', label: 'periodic swaps' };
		if (R < 2 * E) return { color: '#4ade80', label: 'lasts the run' };
		return { color: '#c084fc', label: 'oversized' };
	}

	const showRecharges = $derived(groups.some((g) => g.rechargesNeeded != null));

	const totBatt = $derived(groups.reduce((s, g) => s + (g.minCapacityBatteryOnly ?? 0), 0));
	const totN = $derived(groups.reduce((s, g) => s + (g.minCapacityN ?? 0), 0));
	const totAll = $derived(groups.reduce((s, g) => s + (g.minCapacityAll ?? 0), 0));
	const pctN = $derived(totBatt > 0 ? Math.round((1 - totN / totBatt) * 100) : 0);
	const pctAll = $derived(totBatt > 0 ? Math.round((1 - totAll / totBatt) * 100) : 0);
</script>

{#if mode === 'battery'}
	<table class="w-full text-base">
		<thead>
			<tr class="border-b border-[#333] text-left text-sm text-[#aaa]">
				<th class="pb-2 font-normal">Group</th>
				<th class="pb-2 text-right font-normal">Daily use</th>
				<th class="pb-2 text-right font-normal">Min battery (no recharges)</th>
				{#if showRecharges}
					<th class="pb-2 text-right font-normal">Recharges</th>
					<th class="pb-2 text-right font-normal"
						>{#if term}{@render term('Lasts per charge', 'def-sizeband')}{:else}Lasts per charge{/if}</th
					>
				{/if}
			</tr>
		</thead>
		<tbody>
			{#each groups as group, i (i)}
				<tr class="border-b border-[#1f1f1f]">
					<td class="py-2 font-medium text-[#e8e8e8]">{group.name || `Group ${i + 1}`}</td>
					<td class="py-2 text-right font-mono text-[#bbb]">{fmt(group.dailyUseWh)}</td>
					<td class="py-2 text-right font-mono text-[#e8e8e8]">{fmt(group.minCapacityWh)}</td>
					{#if showRecharges}
						{@const b = sizeBand(group.runtimePerChargeDays, experimentDays)}
						<td class="py-2 text-right font-mono text-[#e8e8e8]">{group.rechargesNeeded ?? '–'}</td>
						<td class="py-2 text-right font-mono" style={b ? `color:${b.color}` : ''}>
							{fmtDays(group.runtimePerChargeDays)}
							{#if b}<span class="block font-sans text-xs opacity-90">{b.label}</span>{/if}
						</td>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
{:else}
	<table class="w-full text-base">
		<thead>
			<tr class="border-b border-[#333] text-left text-sm text-[#ccc]">
				<th class="pb-2 font-normal">Group</th>
				<th class="pb-2 text-right font-normal">Daily use</th>
				<th class="pb-2 text-right font-normal">Battery only</th>
				<th class="pb-2 text-right font-normal">Worst stretch ({committedWorstDays}d)</th>
				<th class="pb-2 text-right font-normal">Worst case</th>
			</tr>
		</thead>
		<tbody>
			{#each groups as group, i (i)}
				<tr class="border-b border-[#1f1f1f]">
					<td class="py-2 font-medium" style="color:{groupColor(i)}"
						>{group.name || `Group ${i + 1}`}</td
					>
					<td class="py-2 text-right font-mono text-[#bbb]">{fmt(group.dailyUseWh)}</td>
					<td class="py-2 text-right font-mono text-[#888]">{fmt(group.minCapacityBatteryOnly)}</td>
					<td class="py-2 text-right font-mono text-[#e8e8e8]">{fmt(group.minCapacityN)}</td>
					<td class="py-2 text-right font-mono text-[#888]">{fmt(group.minCapacityAll)}</td>
				</tr>
			{/each}
		</tbody>
		<tfoot>
			<tr class="border-t border-[#333]">
				<td class="border-b-2 border-[#444] py-2 text-base font-medium text-[#ccc]" colspan="3"
					>solar vs battery only</td
				>
				<td
					class="border-b-2 border-[#444] py-2 text-right font-mono text-base font-semibold text-[#5fa87a]"
					>{pctN > 0 ? `−${pctN}%` : '–'}</td
				>
				<td
					class="border-b-2 border-[#444] py-2 text-right font-mono text-base font-semibold text-[#5fa87a]"
					>{pctAll > 0 ? `−${pctAll}%` : '–'}</td
				>
			</tr>
		</tfoot>
	</table>
{/if}
