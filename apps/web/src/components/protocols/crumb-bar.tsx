import { Breadcrumbs, type Crumb } from "../ui/breadcrumbs";

// The top bar of a page under Protocols, like the browse view's.
export function CrumbBar({ items }: { items: readonly Crumb[] }) {
  return (
    <div className="border-b border-border-opaque">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center px-4 sm:px-6">
        <Breadcrumbs items={[{ label: "Protocols", href: "/protocols" }, ...items]} />
      </div>
    </div>
  );
}
