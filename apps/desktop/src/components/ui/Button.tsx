// Shared button. `primary` (accent) is reserved for the ONE primary action per
// view; secondary actions use `ghost`, tertiary/inline use `text`.
type Variant = "primary" | "ghost" | "text";

const STYLES: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent/90",
  ghost: "text-fg ring-1 ring-inset ring-white/10 hover:bg-surface-raised hover:ring-white/20",
  text: "text-fg-muted hover:text-fg",
};

export function Button({
  variant = "ghost",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={[
        "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-3 py-1.5",
        "text-sm font-medium transition-colors duration-150 ease-out",
        "disabled:pointer-events-none disabled:opacity-40",
        STYLES[variant],
        className,
      ].join(" ")}
      {...props}
    />
  );
}
