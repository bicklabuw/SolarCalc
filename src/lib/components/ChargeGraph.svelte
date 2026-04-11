<script lang="ts">
	let {
		groups,
		title,
		batteryCapacityWh
	}: {
		groups: { name: string; chargeHistory: number[]; numBatteries: number }[];
		title: string;
		batteryCapacityWh: number;
	} = $props();

	const PAD = { left: 60, right: 20, top: 16, bottom: 36 };
	const W = 800;
	const H = 220;
	const chartW = W - PAD.left - PAD.right;
	const chartH = H - PAD.top - PAD.bottom;

	const LINE_COLORS = ['#6c7eb8', '#5fa87a', '#9b7fc0', '#b87a5f', '#5fb8b3'];
	const ACCENT = '#f59e0b';

	const maxCapacity = $derived(Math.max(...groups.map((g) => g.numBatteries * batteryCapacityWh), 1));
	const numHours = $derived(groups[0]?.chargeHistory.length ?? 0);
	const numDays = $derived(Math.ceil(numHours / 24));

	// worst group = lowest minimum charge relative to its own capacity
	const worstIndex = $derived(() => {
		let worst = Infinity;
		let idx = 0;
		groups.forEach((g, i) => {
			const cap = g.numBatteries * batteryCapacityWh;
			const minRelative = Math.min(...g.chargeHistory) / cap;
			if (minRelative < worst) {
				worst = minRelative;
				idx = i;
			}
		});
		return idx;
	});

	function toX(hour: number): number {
		return PAD.left + (hour / Math.max(numHours - 1, 1)) * chartW;
	}

	function toY(wh: number): number {
		return PAD.top + chartH - (wh / maxCapacity) * chartH;
	}

	function makePath(history: number[]): string {
		return history
			.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`)
			.join(' ');
	}

	const yTicks = $derived(() => {
		const step = maxCapacity / 4;
		return [0, 1, 2, 3, 4].map((i) => i * step);
	});

	function fmtWh(v: number): string {
		return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
	}
</script>

<div class="w-full">
	<p class="mb-2 text-sm font-medium text-[#e8e8e8]">{title}</p>
	<svg
		viewBox="0 0 {W} {H}"
		width="100%"
		style="display:block"
		aria-label={title}
	>
		<!-- Day boundary lines -->
		{#each Array.from({ length: numDays + 1 }, (_, d) => d) as day}
			{@const x = toX(day * 24)}
			<line x1={x} y1={PAD.top} x2={x} y2={PAD.top + chartH} stroke="#222" stroke-width="1" />
		{/each}

		<!-- Y axis ticks + labels -->
		{#each yTicks() as tick}
			{@const y = toY(tick)}
			<line x1={PAD.left - 4} y1={y} x2={PAD.left} y2={y} stroke="#444" stroke-width="1" />
			<text x={PAD.left - 7} y={y + 4} text-anchor="end" font-size="10" fill="#666">
				{fmtWh(tick)}
			</text>
		{/each}

		<!-- X axis ticks + day labels -->
		{#each Array.from({ length: numDays + 1 }, (_, d) => d) as day}
			{@const x = toX(day * 24)}
			<line
				x1={x}
				y1={PAD.top + chartH}
				x2={x}
				y2={PAD.top + chartH + 4}
				stroke="#444"
				stroke-width="1"
			/>
			{#if day < numDays}
				<text
					x={toX(day * 24 + 12)}
					y={PAD.top + chartH + 16}
					text-anchor="middle"
					font-size="10"
					fill="#666"
				>
					Day {day + 1}
				</text>
			{/if}
		{/each}

		<!-- Axes -->
		<line
			x1={PAD.left}
			y1={PAD.top}
			x2={PAD.left}
			y2={PAD.top + chartH}
			stroke="#444"
			stroke-width="1"
		/>
		<line
			x1={PAD.left}
			y1={PAD.top + chartH}
			x2={PAD.left + chartW}
			y2={PAD.top + chartH}
			stroke="#444"
			stroke-width="1"
		/>

		<!-- Y axis label -->
		<text
			x={12}
			y={PAD.top + chartH / 2}
			text-anchor="middle"
			font-size="10"
			fill="#555"
			transform="rotate(-90, 12, {PAD.top + chartH / 2})"
		>
			Charge (Wh)
		</text>

		<!-- Group lines -->
		{#each groups as group, i}
			{@const isWorst = i === worstIndex()}
			{@const color = isWorst ? ACCENT : LINE_COLORS[i % LINE_COLORS.length]}
			<path
				d={makePath(group.chargeHistory)}
				fill="none"
				stroke={color}
				stroke-width={isWorst ? 2 : 1.5}
				opacity={isWorst ? 1 : 0.7}
			/>
		{/each}

		<!-- Legend -->
		{#each groups as group, i}
			{@const isWorst = i === worstIndex()}
			{@const color = isWorst ? ACCENT : LINE_COLORS[i % LINE_COLORS.length]}
			{@const lx = PAD.left + i * 110}
			{@const ly = H - 6}
			<line x1={lx} y1={ly} x2={lx + 16} y2={ly} stroke={color} stroke-width={isWorst ? 2 : 1.5} />
			<text x={lx + 20} y={ly + 4} font-size="10" fill={color}>
				{group.name || `Group ${i + 1}`}
			</text>
		{/each}
	</svg>
</div>
