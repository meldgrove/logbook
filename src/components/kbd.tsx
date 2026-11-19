import { Kbd as BaseKbd } from "@meldgrove/ui/kbd";
import { cn } from "@meldgrove/ui/utils";

export { KbdGroup } from "@meldgrove/ui/kbd";

// Changed from @meldgrove/ui: the key sits on the background with a border,
// because muted text on bg-muted stays below a 4.5:1 contrast.
export function Kbd({ className, ...props }: React.ComponentProps<typeof BaseKbd>) {
  return (
    <BaseKbd
      className={cn("border bg-background [[data-slot=tooltip-content]_&]:border-transparent", className)}
      {...props}
    />
  );
}
