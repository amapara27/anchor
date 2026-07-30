/** The app's switch — used for schedules, housekeeping rules, and settings rows. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name; supply one whenever the switch has no adjacent <label>. */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        "flex h-[19px] w-[34px] shrink-0 cursor-pointer rounded-full border border-hair p-0.5",
        "transition-colors duration-200 [transition-timing-function:var(--ease-out)]",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "justify-end bg-accent" : "justify-start bg-hair",
      ].join(" ")}
    >
      <span
        className={[
          "size-[13px] rounded-full transition-colors duration-200 [transition-timing-function:var(--ease-out)]",
          checked ? "bg-accent-fg" : "bg-fg-muted",
        ].join(" ")}
      />
    </button>
  );
}
