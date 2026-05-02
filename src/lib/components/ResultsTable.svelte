<script lang="ts">
	let {
		mode,
		groups,
		committedWorstDays = 0
	}: {
		mode: 'battery' | 'solar';
		groups: {
			name: string;
			batteriesNoSolar: number;
			batteriesN?: number;
			batteriesAll?: number;
		}[];
		committedWorstDays?: number;
	} = $props();

	const totalNoSolar = $derived(groups.reduce((s, g) => s + g.batteriesNoSolar, 0));
	const totalN = $derived(groups.reduce((s, g) => s + (g.batteriesN ?? 0), 0));
	const totalAll = $derived(groups.reduce((s, g) => s + (g.batteriesAll ?? 0), 0));

	const reductionN = $derived(totalNoSolar - totalN);
	const reductionAll = $derived(totalNoSolar - totalAll);
	const pctN = $derived(totalNoSolar > 0 ? Math.round((reductionN / totalNoSolar) * 100) : 0);
	const pctAll = $derived(totalNoSolar > 0 ? Math.round((reductionAll / totalNoSolar) * 100) : 0);
</script>

{#if mode === 'battery'}
	<table class="w-full text-sm">
		<thead>
			<tr class="border-b border-[#333] text-left text-xs text-[#aaa]">
				<th class="pb-1.5 font-normal">Group</th>
				<th class="pb-1.5 text-right font-normal">Batteries</th>
			</tr>
		</thead>
		<tbody>
			{#each groups as group, i (i)}
				<tr class="border-b border-[#1f1f1f]">
					<td class="py-1.5 text-[#e8e8e8]">{group.name || `Group ${i + 1}`}</td>
					<td class="py-1.5 text-right font-mono text-[#e8e8e8]">{group.batteriesNoSolar}</td>
				</tr>
			{/each}
		</tbody>
		<tfoot>
			<tr class="border-t border-[#444]">
				<td class="pt-1.5 text-xs text-[#ccc]">Total</td>
				<td class="pt-1.5 text-right font-mono font-medium text-[#f59e0b]">{totalNoSolar}</td>
			</tr>
		</tfoot>
	</table>
{:else}
	<table class="w-full text-sm">
		<thead>
			<tr class="border-b border-[#333] text-left text-xs text-[#ccc]">
				<th class="pb-1.5 font-normal">Group</th>
				<th class="pb-1.5 text-right font-normal"
					>{committedWorstDays} worst day{committedWorstDays === 1 ? '' : 's'}</th
				>
				<th class="pb-1.5 text-right font-normal">All worst days</th>
			</tr>
		</thead>
		<tbody>
			{#each groups as group, i (i)}
				<tr class="border-b border-[#1f1f1f]">
					<td class="py-1.5 text-[#e8e8e8]">{group.name || `Group ${i + 1}`}</td>
					<td class="py-1.5 text-right font-mono text-[#e8e8e8]">{group.batteriesN ?? '—'}</td>
					<td class="py-1.5 text-right font-mono text-[#e8e8e8]">{group.batteriesAll ?? '—'}</td>
				</tr>
			{/each}
		</tbody>
		<tfoot>
			<tr class="border-t border-[#444]">
				<td class="pt-1.5 text-xs text-[#aaa]">Total</td>
				<td class="pt-1.5 text-right font-mono font-medium text-[#f59e0b]">{totalN}</td>
				<td class="pt-1.5 text-right font-mono font-medium text-[#f59e0b]">{totalAll}</td>
			</tr>
			<tr>
				<td class="pt-1 text-xs text-[#888]">vs battery-only</td>
				<td class="pt-1 text-right font-mono text-xs text-[#5fa87a]">
					{reductionN > 0 ? `-${reductionN} (${pctN}%)` : '—'}
				</td>
				<td class="pt-1 text-right font-mono text-xs text-[#5fa87a]">
					{reductionAll > 0 ? `-${reductionAll} (${pctAll}%)` : '—'}
				</td>
			</tr>
		</tfoot>
	</table>
{/if}
