import { cn } from "@meldgrove/ui/utils";

/**
 * `Table` from @meldgrove/ui/table with a labelled, focusable scroll
 * container, so keyboard users can scroll a table wider than the page
 * (WCAG 2.1.1). The package's `Table` takes no props for its container.
 */
export function ScrollTable({ className, label, ...props }: React.ComponentProps<"table"> & { label: string }) {
  return (
    <div data-slot="table-container" role="region" aria-label={label} tabIndex={0} className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}
