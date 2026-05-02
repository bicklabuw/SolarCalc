<script lang="ts">
	let {
		group = $bindable(),
		index,
		showSolarInputs = false,
		canRemove = true,
		onRemove
	}: {
		group: { name: string; devices: number; panels: number };
		index: number;
		showSolarInputs?: boolean;
		canRemove?: boolean;
		onRemove: () => void;
	} = $props();

	let confirmRemove = $state(false);
	const placeholder = $derived(`Group ${index + 1}`);
</script>

<div class="flex items-center gap-3 rounded-sm bg-[#1a1a1a] px-3 py-2">
	<input
		type="text"
		bind:value={group.name}
		{placeholder}
		class="w-28 border-b border-[#333] bg-transparent text-sm text-[#e8e8e8] placeholder-[#888] focus:border-[#f59e0b] focus:outline-none"
	/>

	<label class="flex items-center gap-1.5 text-sm text-[#888]">
		<span>Devices</span>
		<input
			type="number"
			bind:value={group.devices}
			min="1"
			class="w-16 rounded-sm border border-[#333] bg-[#0f0f0f] px-2 py-0.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
		/>
	</label>

	{#if showSolarInputs}
		<label class="flex items-center gap-1.5 text-sm text-[#888]">
			<span>Panels</span>
			<input
				type="number"
				bind:value={group.panels}
				min="0"
				class="w-16 rounded-sm border border-[#333] bg-[#0f0f0f] px-2 py-0.5 font-mono text-sm text-[#e8e8e8] focus:border-[#f59e0b] focus:outline-none"
			/>
		</label>
	{/if}

	<div class="ml-auto text-sm">
		{#if canRemove}
			{#if !confirmRemove}
				<button
					onclick={() => (confirmRemove = true)}
					class="text-[#888] transition-colors hover:text-[#e8e8e8]"
				>
					Remove
				</button>
			{:else}
				<span class="text-[#888]">
					Remove?
					<button onclick={onRemove} class="ml-1 text-[#f59e0b] hover:underline">Yes</button>
					<button
						onclick={() => (confirmRemove = false)}
						class="ml-1 text-[#555] hover:text-[#e8e8e8]"
					>
						Cancel
					</button>
				</span>
			{/if}
		{/if}
	</div>
</div>
