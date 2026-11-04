import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// Raised table and list surfaces shared by Files, search results and settings rows.
export const dataSurface = "overflow-hidden rounded-card border border-border-opaque bg-background-raised shadow-raised";

export const dataRow = "relative border-t border-border-opaque first:border-t-0 transition-colors duration-150 ease-out";
export const dataRowInteractive = "hover:bg-background-secondary has-[[aria-expanded=true]]:bg-background-secondary";

export function DataTable({ className, children, ...props }: ComponentProps<"table">) {
  return (
    <div className={cn(dataSurface, className)}>
      <table className="w-full table-fixed border-collapse text-left" {...props}>
        {children}
      </table>
    </div>
  );
}

export function DataHeaderCell({ className, ...props }: ComponentProps<"th">) {
  return <th scope="col" className={cn("h-12 px-4 text-label-small font-normal text-content-tertiary sm:px-5", className)} {...props} />;
}

export function DataCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-4 py-3 align-middle sm:px-5", className)} {...props} />;
}
