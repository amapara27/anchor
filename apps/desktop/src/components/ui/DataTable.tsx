// Dense table primitives: one hairline per row, tabular figures throughout.
// Compose as <DataTable><thead><Tr><Th/>…</Tr></thead><tbody><Tr><Td/>…</Tr>….
export function DataTable({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <table className={["w-full border-collapse text-sm tabular", className].join(" ")}>{children}</table>
  );
}

export function Th({
  children,
  className = "",
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={[
        "border-b border-[var(--hairline)] px-3 py-2 text-left",
        "text-xs font-medium uppercase tracking-wide text-fg-subtle",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className = "",
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={["border-b border-[var(--hairline)] px-3 py-2 text-fg", className].join(" ")} {...props}>
      {children}
    </td>
  );
}

export function Tr({
  children,
  className = "",
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={["transition-colors duration-150 ease-out hover:bg-surface-raised", className].join(" ")}
      {...props}
    >
      {children}
    </tr>
  );
}
