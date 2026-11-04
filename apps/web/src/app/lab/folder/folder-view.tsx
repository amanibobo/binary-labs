import { FolderPicker } from "./folder-picker";

export function FolderView({ accountLabel }: { accountLabel: string | null }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 pt-8 pb-24 sm:px-6 sm:pt-12">
      <h1 className="text-heading-large">Choose a folder</h1>
      <p className="mt-2 mb-6 text-paragraph-medium text-content-tertiary">
        {accountLabel === null ? "Pick one folder to index." : `Pick one folder from ${accountLabel} to index.`} Binary
        Labs reads it and never changes it.
      </p>
      <FolderPicker />
    </div>
  );
}
