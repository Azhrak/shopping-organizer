import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { AppLayout } from "~/components/AppShell";
import { formatEur } from "~/lib/money";
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
		<AppLayout>
			<section className="space-y-8">
				<div>
					<h3 className="text-[25px] text-text">Comparisons</h3>
					<p className="mt-1 text-[12.5px] text-muted">
						Group {MIN_GROUP_ITEMS}–{MAX_GROUP_ITEMS} similar products and
						compare each against its own typical price.
					</p>
				</div>

				{groups.data.length === 0 ? (
					<div className="rounded-lg bg-surface p-8 text-center shadow-card">
						<p className="text-sm text-muted">
							No comparison groups yet. Pick a few similar items below.
						</p>
					</div>
				) : (
					<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
						{groups.data.map((g) => (
							<div
								key={g.id}
								className="flex items-center gap-3 rounded-lg bg-surface p-3 shadow-card"
							>
								<Link
									to="/compare/$groupId"
									params={{ groupId: g.id }}
									className="min-w-0 flex-1"
								>
									<div className="truncate text-sm text-text">{g.name}</div>
									<div className="text-[11px] text-muted">
										{g.itemCount} {g.itemCount === 1 ? "item" : "items"}
									</div>
								</Link>
								<button
									type="button"
									aria-label={`Delete ${g.name}`}
									onClick={() =>
										removeGroup.mutate({ data: { groupId: g.id } })
									}
									className="grid size-8 flex-none place-items-center rounded-lg border border-divider text-muted hover:border-accent hover:text-accent"
								>
									<i className="ph ph-trash" aria-hidden="true" />
								</button>
							</div>
						))}
					</div>
				)}

				<div className="rounded-lg bg-surface p-4 shadow-card">
					<h4 className="text-[17px] text-text">New comparison</h4>
					<p className="mt-1 text-xs text-faint">
						Select {MIN_GROUP_ITEMS}–{MAX_GROUP_ITEMS} items. {selected.length}{" "}
						selected.
					</p>

					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="Group name, e.g. Trekking boots"
						aria-label="Group name"
						className="mt-3 h-9 w-full max-w-sm rounded-lg border border-divider bg-surface-2 px-3 text-sm text-text outline-none placeholder:text-faint"
					/>

					{items.data.length === 0 ? (
						<p className="mt-3 text-sm text-muted">
							Nothing saved yet — add products from the catalog first.
						</p>
					) : (
						<div className="mt-3 grid max-h-80 gap-px overflow-y-auto rounded-lg border border-divider p-1">
							{items.data.map((item) => {
								const checked = selected.includes(item.id);
								const full = !checked && selected.length >= MAX_GROUP_ITEMS;

								return (
									<label
										key={item.id}
										className={[
											"flex items-center gap-2 rounded px-2 py-1.5 text-sm",
											full
												? "cursor-not-allowed opacity-45"
												: "cursor-pointer hover:bg-hair",
											checked ? "bg-accent-tint" : "",
										].join(" ")}
									>
										<input
											type="checkbox"
											checked={checked}
											disabled={full}
											onChange={() => toggle(item.id)}
											className="accent-[var(--color-accent)]"
										/>
										<span className="min-w-0 flex-1 truncate text-text">
											{item.title ?? item.url}
										</span>
										<span className="text-[11px] text-muted">
											{item.storeHostname}
										</span>
										<span className="w-20 text-right text-xs text-text">
											{item.currentPrice !== null
												? formatEur(item.currentPrice)
												: "—"}
										</span>
									</label>
								);
							})}
						</div>
					)}

					<button
						type="button"
						disabled={!canCreate || createGroup.isPending}
						onClick={() =>
							createGroup.mutate({
								data: { name: name.trim(), itemIds: selected },
							})
						}
						className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg border border-accent px-3 text-sm text-accent hover:bg-accent-tint disabled:opacity-40"
					>
						<i className="ph ph-columns" aria-hidden="true" />
						{createGroup.isPending ? "Creating…" : "Create comparison"}
					</button>

					{createGroup.isError ? (
						<p className="mt-2 text-[13px] text-muted">
							{createGroup.error.message}
						</p>
					) : null}
				</div>
			</section>
		</AppLayout>
	);
}
