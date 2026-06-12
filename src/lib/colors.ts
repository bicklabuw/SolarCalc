// Shared per-group colours, indexed by group order, so a group is the same colour
// in the results table and in every charge graph.
export const GROUP_COLORS = [
	'#6c7eb8',
	'#5fa87a',
	'#9b7fc0',
	'#b87a5f',
	'#5fb8b3',
	'#c0a35f',
	'#7a9bc0',
	'#b8895f'
];

export const groupColor = (i: number) => GROUP_COLORS[i % GROUP_COLORS.length];
