import { cn } from "@meldgrove/ui/utils";

const L_PATH = "M11 8v16h11";

/** The Logbook mark, as in the app icon (`src/app/icon.svg`). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true" className={cn("size-8", className)}>
      <rect width="32" height="32" rx="7" fill="#171717" />
      <path d={L_PATH} fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The "L" of the mark alone, in the current color, for the square that the
 * app frame and the sign-in page draw. Its box is the middle half of the app
 * icon, so a square twice its size looks like the icon.
 */
export function LogoMark() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="8 8 16 16" overflow="visible" aria-hidden="true">
      <path d={L_PATH} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
