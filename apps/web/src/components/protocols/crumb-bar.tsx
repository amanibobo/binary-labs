import { Breadcrumbs, type Crumb } from "../ui/breadcrumbs";

// The top bar of a page under Protocols, like the browse view's.
export function CrumbBar({ items }: { items: readonly Crumb[] }) {
  return (
    <div className="flex h-16 items-center border-b border-border-opaque px-4 sm:px-8">
      <Breadcrumbs items={[{ label: "Protocols", href: "/protocols" }, ...items]} />
    </div>
  );
}
