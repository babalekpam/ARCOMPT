"use client";
import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n-client";
import type { Account } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Field";

export interface AccountNode {
  account: Account;
  children: AccountNode[];
}

/** Construit l'arbre par préfixe de numéro : le parent d'un compte est le plus long préfixe existant. */
export function buildTree(accounts: Account[]): AccountNode[] {
  const sorted = [...accounts].sort((a, b) => a.number.localeCompare(b.number));
  const byNumber = new Map<string, AccountNode>();
  const roots: AccountNode[] = [];
  for (const a of sorted) {
    const node: AccountNode = { account: a, children: [] };
    byNumber.set(a.number, node);
    let parent: AccountNode | undefined;
    for (let len = a.number.length - 1; len >= 1 && !parent; len--) parent = byNumber.get(a.number.slice(0, len));
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

function matches(node: AccountNode, q: string): boolean {
  return node.account.number.startsWith(q) || node.account.label.toLowerCase().includes(q) || node.children.some((c) => matches(c, q));
}

function TreeNode({ node, q, depth }: { node: AccountNode; q: string; depth: number }) {
  const t = useT();
  const a = node.account;
  const visibleChildren = q ? node.children.filter((c) => matches(c, q)) : node.children;
  const [open, setOpen] = useState(depth < 1);
  const expanded = q ? true : open;
  return (
    <li>
      <div className={`flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50 ${!a.active ? "opacity-50" : ""}`} style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}>
        {node.children.length > 0 ? (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={expanded} className="w-4 text-xs text-slate-400">
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <span className={`font-mono text-xs ${a.number.length <= 2 ? "font-bold" : ""}`}>{a.number}</span>
        <span className={`flex-1 truncate ${a.number.length <= 2 ? "font-semibold" : ""}`}>{a.label}</span>
        {a.postable ? <Badge tone="info">{t("accounts.postable")}</Badge> : null}
        {a.lettrable ? <Badge tone="neutral">{t("accounts.lettrable")}</Badge> : null}
        {!a.active ? <Badge tone="warning">{t("accounts.inactive")}</Badge> : null}
      </div>
      {expanded && visibleChildren.length > 0 ? (
        <ul>
          {visibleChildren.map((c) => (
            <TreeNode key={c.account.id} node={c} q={q} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Plan de comptes en arbre par classe, avec recherche. */
export function AccountTree({ accounts }: { accounts: Account[] }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const roots = useMemo(() => buildTree(accounts), [accounts]);
  const byClass = useMemo(() => {
    const map = new Map<number, AccountNode[]>();
    for (const r of roots) {
      const cls = Number(r.account.number[0]);
      map.set(cls, [...(map.get(cls) ?? []), r]);
    }
    return [...map.entries()].sort(([a], [b]) => a - b);
  }, [roots]);
  const count = useMemo(() => accounts.filter((a) => !q || a.number.startsWith(q) || a.label.toLowerCase().includes(q)).length, [accounts, q]);
  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("accounts.search")} aria-label={t("common.search")} className="max-w-sm" />
        <span className="text-xs text-slate-500">{t("accounts.count", { count })}</span>
      </div>
      <div className="space-y-2">
        {byClass.map(([cls, nodes]) => {
          const visible = q ? nodes.filter((n) => matches(n, q)) : nodes;
          if (visible.length === 0) return null;
          return (
            <details key={cls} open className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
              <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
                {t("common.class")} {cls} — {t(`accounts.class.${cls}`)}
              </summary>
              <ul className="pb-2">
                {visible.map((n) => (
                  <TreeNode key={n.account.id} node={n} q={q} depth={0} />
                ))}
              </ul>
            </details>
          );
        })}
      </div>
    </div>
  );
}
