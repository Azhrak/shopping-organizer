import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { groupsQuery, itemListQuery, queryKeys } from "~/lib/queries";
import { createGroupFn, deleteGroupFn } from "~/lib/server/comparisons";
import {
	MAX_GROUP_ITEMS,
	MIN_GROUP_ITEMS,
} from "~/lib/services/comparisons.service";

export const Route = createFileRoute("/compare/")({
	loader: async ({ context }) => {
		await Promise.all([
			context.queryClient.ensureQueryData(groupsQuery()),
			context.queryClient.ensureQueryData(itemListQuery({})),
		]);
	},
	component: ComparisonsPage,
});

function ComparisonsPage() {
	const queryClient = useQueryClient();
	const groups = useSuspenseQuery(groupsQuery());
	const items = useSuspenseQuery(itemListQuery({}));

	const [name, setName] = useState("");
	const [selected, setSelected] = useState<Array<string>>([]);

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: queryKeys.groups });

	const createGroup = useMutation({
		mutationFn: createGroupFn,
		onSuccess: async () => {
			setName("");
			setSelected([]);
			await invalidate();
		},
	});

	const removeGroup = useMutation({
		mutationFn: deleteGroupFn,
		onSuccess: invalidate,
	});

	const toggle = (id: string) => {
		setSelected((prev) =>
			prev.includes(id)
				? prev.filter((x) => x !== id)
				: prev.length >= MAX_GROUP_ITEMS
					? prev
					: [...prev, id],
		);
	};

	const canCreate =
		name.trim().length > 0 &&
		selected.length >= MIN_GROUP_ITEMS &&
		selected.length <= MAX_GROUP_ITEMS;

	return (
		<div className="space-y-8">
			<section>
				<h1 className="mb-3 text-lg font-semibold">Comparison groups</h1>
				{groups.data.length === 0 ? (
					<p className="text-sm text-slate-500">No groups yet.</p>
				) : (
					<ul className="space-y-2">
						{groups.data.map((g) => (
							<li
								key={g.id}
								className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 dark:border-slate-800"
							>
								<Link
									to="/compare/$groupId"
									params={{ groupId: g.id }}
									className="underline"
								>
									{g.name}
								</Link>
								<span className="text-sm text-slate-500">
									{g.itemCount} items
								</span>
								<button
									type="button"
									onClick={() =>
										removeGroup.mutate({ data: { groupId: g.id } })
									}
									className="text-sm text-rose-600"
								>
									Delete
								</button>
							</li>
						))}
					</ul>
				)}
			</section>

			<section>
				<h2 className="mb-3 font-medium">
					New group ({MIN_GROUP_ITEMS}-{MAX_GROUP_ITEMS} items)
				</h2>

				<input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Group name"
					className="mb-3 w-full max-w-sm rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
				/>

				<div className="grid max-h-80 gap-1 overflow-y-auto rounded border border-slate-200 p-2 dark:border-slate-800">
					{items.data.map((item) => (
						<label
							key={item.id}
							className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-900"
						>
							<input
								type="checkbox"
								checked={selected.includes(item.id)}
								onChange={() => toggle(item.id)}
							/>
							<span className="truncate">{item.title ?? item.url}</span>
						</label>
					))}
				</div>

				<button
					type="button"
					disabled={!canCreate || createGroup.isPending}
					onClick={() =>
						createGroup.mutate({
							data: { name: name.trim(), itemIds: selected },
						})
					}
					className="mt-3 rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
				>
					Create group
				</button>

				{createGroup.isError && (
					<p className="mt-2 text-sm text-rose-600">
						{createGroup.error.message}
					</p>
				)}
			</section>
		</div>
	);
}
