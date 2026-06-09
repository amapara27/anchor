import { ModelLibrary } from "./components/ModelLibrary";

export default function App() {
  return (
    <div className="min-h-dvh">
      <div className="mx-auto max-w-7xl px-6 py-10 lg:px-8">
        <header className="mb-8 flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <AnchorMark className="size-6 text-emerald-400" />
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Anchor</h1>
          </div>
          <p className="text-sm text-slate-400">
            Your local model library — browse, download, and manage models without the terminal.
          </p>
        </header>

        <ModelLibrary />
      </div>
    </div>
  );
}

function AnchorMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="5" r="2.5" />
      <path d="M12 7.5V21" />
      <path d="M5 12H3a9 9 0 0 0 18 0h-2" />
      <path d="M8 12H16" />
    </svg>
  );
}
